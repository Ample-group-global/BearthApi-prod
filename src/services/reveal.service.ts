import pool from "../pool";
import { logNftActivity } from "./nft-log.service";
import { ethers } from "ethers";
import GenesisABI from "../abi/BearthNFT.abi.json";
import CoordinatorABI from "../abi/BearthRevealCoordinator.abi.json";
import { resolveCollectionContractAddress } from "./contract.service";
import { getProvider } from "../utils/contract-factory";

function getSigner(): ethers.Wallet {
  const rpcUrl = process.env.ETH_RPC_URL;
  const privateKey = process.env.FIXED_PRIVATE_KEY;
  if (!rpcUrl || !privateKey) throw new Error("ETH_RPC_URL and FIXED_PRIVATE_KEY required for reveal");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new ethers.Wallet(privateKey, provider);
}

function getGenesisContract(signer: ethers.Wallet, contractAddress: string): ethers.Contract {
  return new ethers.Contract(contractAddress, GenesisABI, signer);
}

async function getCoordinatorContract(signer: ethers.Wallet, collectionId: string): Promise<ethers.Contract | null> {
  const { rows } = await pool.query<{ contract_reveal_coordinator_address: string | null }>(
    "SELECT contract_reveal_coordinator_address FROM nft_collections WHERE id = $1",
    [collectionId],
  );
  const addr = rows[0]?.contract_reveal_coordinator_address;
  if (!addr) return null;
  return new ethers.Contract(addr, CoordinatorABI, signer);
}

export async function executeWaveReveal(waveNum: number, collectionId: string): Promise<string | null> {
  const { rows: waveRows } = await pool.query<{
    id: string;
    wave_number: number;
    wave_reveal_uri: string | null;
  }>(
    "SELECT id, wave_number, wave_reveal_uri FROM nft_waves WHERE wave_number = $1 AND collection_id = $2",
    [waveNum, collectionId],
  );
  if (!waveRows.length) throw new Error(`Wave ${waveNum} not found`);
  const wave = waveRows[0];

  const revealUri = wave.wave_reveal_uri;
  if (!revealUri || !revealUri.startsWith("ipfs://")) {
    throw new Error(
      `Wave ${waveNum}: wave_reveal_uri not set or invalid. ` +
      `Set it in nft_waves (must start with ipfs://) before triggering reveal.`,
    );
  }

  if (!process.env.ETH_RPC_URL || !process.env.FIXED_PRIVATE_KEY) {
    console.log(`[reveal] Wave ${waveNum}: no signer env vars — DB-only reveal (dev mode)`);
    await _updateWaveRevealedInDB(wave.id, waveNum, revealUri, null, null, null);
    return null;
  }

  const contractAddress = await resolveCollectionContractAddress(collectionId);
  const signer = getSigner();
  const nft = getGenesisContract(signer, contractAddress);
  const coordinator = await getCoordinatorContract(signer, collectionId);

  if (coordinator) {
    console.log(`[reveal] Wave ${waveNum}: VRF path via coordinator ${await coordinator.getAddress()}`);

    const provenanceHash = ethers.keccak256(ethers.toUtf8Bytes(revealUri));
    console.log(`[reveal] Wave ${waveNum}: provenance hash = ${provenanceHash}`);

    const requestTx = await (coordinator.requestReveal as (
      waveNum: number, uri: string
    ) => Promise<ethers.TransactionResponse>)(waveNum, revealUri);

    const requestReceipt = await requestTx.wait(1);
    if (!requestReceipt) throw new Error("No receipt for requestReveal tx");
    const requestTxHash = requestReceipt.hash;
    console.log(`[reveal] Wave ${waveNum}: VRF request submitted, tx: ${requestTxHash}`);

    let vrfRequestId: string | null = null;
    for (const log of requestReceipt.logs) {
      try {
        const parsed = coordinator.interface.parseLog(log);
        if (parsed?.name === "RevealRequested") {
          vrfRequestId = parsed.args[1].toString();
          console.log(`[reveal] Wave ${waveNum}: VRF requestId = ${vrfRequestId}`);
          break;
        }
      } catch { }
    }

    await pool.query(
      `UPDATE nft_waves SET
         provenance_hash  = $2,
         vrf_request_id   = $3,
         vrf_requested_at = NOW(),
         updated_at       = NOW()
       WHERE wave_number = $1 AND collection_id = $4`,
      [waveNum, provenanceHash, vrfRequestId, collectionId],
    );

    const VRF_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
    console.log(`[reveal] Wave ${waveNum}: waiting for WaveRevealed event (up to ${VRF_WAIT_TIMEOUT_MS / 60000} min)…`);
    const txHash = await _waitForWaveRevealed(nft, waveNum, VRF_WAIT_TIMEOUT_MS, requestReceipt.blockNumber);
    console.log(`[reveal] Wave ${waveNum}: revealed on-chain, tx: ${txHash}`);

    let startingIndexNum: number | null = null;
    try {
      const si = await (coordinator.waveStartingIndex as (n: number) => Promise<bigint>)(waveNum);
      startingIndexNum = Number(si);
      console.log(`[reveal] Wave ${waveNum}: startingIndex = ${startingIndexNum}`);
    } catch { }

    await _updateWaveRevealedInDB(wave.id, waveNum, revealUri, txHash, provenanceHash, startingIndexNum);
    await _syncRevealedMetadata(waveNum, collectionId);
    return txHash;
  }

  console.log(`[reveal] Wave ${waveNum}: direct revealWave() — no VRF coordinator set`);
  const tx = await (nft.revealWave as (n: number, uri: string) => Promise<ethers.TransactionResponse>)(
    waveNum,
    revealUri,
  );
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error(`No receipt for revealWave(${waveNum})`);
  const txHash = receipt.hash;
  console.log(`[reveal] Wave ${waveNum}: revealed directly, tx: ${txHash}`);

  await _updateWaveRevealedInDB(wave.id, waveNum, revealUri, txHash, null, null);
  await _syncRevealedMetadata(waveNum, collectionId);
  return txHash;
}

async function _waitForWaveRevealed(
  nft: ethers.Contract,
  targetWaveNum: number,
  timeoutMs: number,
  fromBlock?: number,
): Promise<string> {
  if (fromBlock !== undefined) {
    const pastEvents = await nft.queryFilter(
      nft.filters.WaveRevealed(targetWaveNum),
      fromBlock,
    ) as ethers.EventLog[];
    if (pastEvents.length > 0) {
      return pastEvents[pastEvents.length - 1].transactionHash;
    }
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nft.off("WaveRevealed", listener);
      reject(new Error(`Wave ${targetWaveNum}: VRF fulfillment timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const listener = (waveNum: bigint, _uri: string, _ts: bigint, event: ethers.EventLog) => {
      if (Number(waveNum) === targetWaveNum) {
        clearTimeout(timer);
        nft.off("WaveRevealed", listener);
        resolve(event.transactionHash);
      }
    };

    nft.on("WaveRevealed", listener);
  });
}

async function _updateWaveRevealedInDB(
  waveId: string,
  waveNum: number,
  revealUri: string,
  txHash: string | null,
  provenanceHash: string | null,
  startingIndex: number | null,
): Promise<void> {
  await pool.query(
    `UPDATE nft_waves SET
        is_revealed       = TRUE,
        wave_revealed     = TRUE,
        wave_reveal_uri   = $2,
        wave_revealed_at  = NOW(),
        last_tx_hash      = COALESCE($3, last_tx_hash),
        provenance_hash   = COALESCE($4, provenance_hash),
        starting_index    = COALESCE($5, starting_index),
        wave_starting_index = COALESCE($5, wave_starting_index),
        vrf_fulfilled_at  = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE vrf_fulfilled_at END,
        updated_at        = NOW()
      WHERE id = $1::uuid`,
    [waveId, revealUri, txHash, provenanceHash, startingIndex],
  );

  const { rowCount: revealedRows } = await pool.query(
    `UPDATE nft_records
        SET is_revealed        = TRUE,
            revealed_at        = NOW(),
            delivery_status_id = (SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code = 'revealed'),
            updated_at         = NOW()
      WHERE wave_id  = $1::uuid
        AND token_id IS NOT NULL
        AND mint_type IN ('free', 'paid')`,
    [waveId],
  );

  const { rowCount: pendingRows } = await pool.query(
    `UPDATE nft_records
        SET delivery_status_id = (SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code = 'reserved'),
            updated_at         = NOW()
      WHERE wave_id  = $1::uuid
        AND token_id IS NULL
        AND delivery_status_id NOT IN (
          SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code IN ('reserved','treasury_pending','treasury_wallet','delivered','transferred')
        )`,
    [waveId],
  );

  console.log(`[reveal] Wave ${waveNum} reveal state synced to DB — ${revealedRows ?? 0} customer NFTs marked revealed, ${pendingRows ?? 0} unsold → reserved`);
}

const IPFS_GATEWAY = "https://ipfs.filebase.io/ipfs/";
async function fetchFolderMetadata(folderCid: string, edition: number, attempt = 1): Promise<{
  attrs: Record<string, string>;
  imageHash: string | null;
} | null> {
  try {
    const res = await fetch(`${IPFS_GATEWAY}${folderCid}/${edition}.json`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = JSON.parse(await res.text()) as { image?: string; attributes?: { trait_type: string; value: unknown }[] };
    const attrs: Record<string, string> = {};
    for (const a of meta.attributes ?? []) attrs[a.trait_type] = String(a.value);
    return { attrs, imageHash: meta.image ? meta.image.replace(/^ipfs:\/\//, "") : null };
  } catch (err) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
      return fetchFolderMetadata(folderCid, edition, attempt + 1);
    }
    console.warn(`[reveal] fetchFolderMetadata: ${folderCid}/${edition}.json failed after retries:`, err);
    return null;
  }
}

export async function _syncRevealedMetadata(waveNum: number, collectionId: string): Promise<void> {
  const { rows: waveRows } = await pool.query<{ wave_reveal_uri: string | null }>(
    `SELECT wave_reveal_uri FROM nft_waves WHERE wave_number = $1 AND collection_id = $2`,
    [waveNum, collectionId],
  );
  if (!waveRows.length) return;
  const { wave_reveal_uri: revealUri } = waveRows[0];
  if (!revealUri) {
    console.warn(`[reveal] Wave ${waveNum}: no wave_reveal_uri set, cannot sync metadata`);
    return;
  }

  const { rows: mintedTokens } = await pool.query<{ id: string; token_id: number }>(
    `SELECT id, token_id FROM nft_records WHERE on_chain_wave_num = $1 AND collection_id = $2 AND token_id IS NOT NULL`,
    [waveNum, collectionId],
  );
  if (!mintedTokens.length) {
    console.log(`[reveal] Wave ${waveNum}: no minted tokens to sync metadata for`);
    return;
  }

  console.log(`[reveal] Wave ${waveNum}: syncing artwork for ${mintedTokens.length} tokens…`);

  const contractAddress = await resolveCollectionContractAddress(collectionId);
  const nft = new ethers.Contract(contractAddress, GenesisABI, getProvider());

  const assignments: { id: string; token_id: number; folderCid: string; artworkEdition: number }[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < mintedTokens.length; i += CONCURRENCY) {
    const batch = mintedTokens.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ id, token_id }) => {
      try {
        const uri = await (nft.tokenURI as (id: bigint) => Promise<string>)(BigInt(token_id));
        const withoutScheme = uri.replace(/^ipfs:\/\//, "");
        const slashIdx = withoutScheme.lastIndexOf("/");
        const folderCid = withoutScheme.slice(0, slashIdx);
        const artworkEdition = parseInt(withoutScheme.slice(slashIdx + 1).replace(/\.json$/, ""), 10);
        if (!folderCid || isNaN(artworkEdition)) {
          console.warn(`[reveal] Wave ${waveNum} token ${token_id}: could not parse tokenURI '${uri}'`);
          return;
        }
        assignments.push({ id, token_id, folderCid, artworkEdition });
      } catch (err) {
        console.warn(`[reveal] Wave ${waveNum} token ${token_id}: tokenURI() call failed:`, err);
      }
    }));
  }

  const uniqueKeys = [...new Set(assignments.map(a => `${a.folderCid}/${a.artworkEdition}`))];
  const editionMap = new Map<string, Awaited<ReturnType<typeof fetchFolderMetadata>>>();
  for (let i = 0; i < uniqueKeys.length; i += CONCURRENCY) {
    const batch = uniqueKeys.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (key) => {
      const [folderCid, editionStr] = [key.slice(0, key.lastIndexOf("/")), key.slice(key.lastIndexOf("/") + 1)];
      editionMap.set(key, await fetchFolderMetadata(folderCid, Number(editionStr)));
    }));
  }

  let synced = 0;
  let missing = 0;
  for (const { id, token_id, folderCid, artworkEdition } of assignments) {
    const artwork = editionMap.get(`${folderCid}/${artworkEdition}`);
    if (!artwork) {
      missing++;
      console.warn(`[reveal] Wave ${waveNum} token ${token_id}: could not fetch edition #${artworkEdition} from folder CID`);
      continue;
    }
    const metadataUri = `ipfs://${folderCid}/${artworkEdition}.json`;
    await pool.query(
      `UPDATE nft_records SET
         image_ipfs_hash    = $2,
         metadata_uri       = $3,
         traits             = $4::jsonb,
         rarity_tier        = $5,
         rarity_score       = $6,
         rarity_rank        = $7,
         updated_at         = NOW()
       WHERE id = $1::uuid`,
      [id, artwork.imageHash, metadataUri, JSON.stringify(artwork.attrs),
        artwork.attrs["Rarity Tier"]?.toLowerCase() ?? null,
        artwork.attrs["Rarity Score"] ?? null,
        artwork.attrs["Rarity Rank"] ? parseInt(artwork.attrs["Rarity Rank"].replace("#", ""), 10) : null],
    );
    synced++;
  }
  console.log(`[reveal] Wave ${waveNum}: artwork sync complete — ${synced} updated, ${missing} missing (of ${mintedTokens.length} minted)`);

  const { rows: supplyRows } = await pool.query(`SELECT COUNT(*) AS total FROM nft_records WHERE collection_id = $1`, [collectionId]);
  const totalSupply = Number(supplyRows[0]?.total ?? 0);
  const legendaryMax = Math.ceil(totalSupply * 0.01);
  const epicMax = Math.ceil(totalSupply * 0.05);
  const rareMax = Math.ceil(totalSupply * 0.15);

  await pool.query(
    `UPDATE nft_records SET rarity_tier = CASE
       WHEN rarity_rank <= $2 THEN 'legendary'
       WHEN rarity_rank <= $3 THEN 'epic'
       WHEN rarity_rank <= $4 THEN 'rare'
       ELSE 'common'
     END
     WHERE on_chain_wave_num = $1
       AND collection_id = $5
       AND token_id IS NOT NULL
       AND rarity_rank IS NOT NULL
       AND rarity_tier IS NULL`,
    [waveNum, legendaryMax, epicMax, rareMax, collectionId],
  );
}

export async function repairTreasuryMintsForWave(waveNum: number, collectionId: string): Promise<{ assigned: number; revealed: number }> {
  const RPC_URL = process.env.ETH_RPC_URL ?? process.env.ETH_RPC_URL_MAINNET ?? "";
  if (!RPC_URL) {
    console.warn(`[treasury-repair] Wave ${waveNum}: skipped — ETH_RPC_URL not set`);
    return { assigned: 0, revealed: 0 };
  }
  const CONTRACT_ADDR = await resolveCollectionContractAddress(collectionId);

  const { rows: waveRows } = await pool.query<{ id: string; starting_index: number | null }>(
    `SELECT id, starting_index FROM nft_waves WHERE wave_number = $1 AND collection_id = $2`,
    [waveNum, collectionId],
  );
  if (!waveRows.length) return { assigned: 0, revealed: 0 };
  const { id: waveId, starting_index: startingIndex } = waveRows[0];

  const { rows: unassigned } = await pool.query<{ id: string }>(
    `SELECT nr.id
         FROM nft_records nr
         JOIN lookup_values lv ON lv.id = nr.delivery_status_id
        WHERE nr.wave_id = $1::uuid
          AND nr.token_id IS NULL
          AND lv.code IN ('transferred', 'treasury_wallet')
        ORDER BY REGEXP_REPLACE(nr.serial_number, '[^0-9]', '', 'g')::INTEGER ASC`,
    [waveId],
  );

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
  const ZERO_PADDED = ethers.zeroPadValue(ethers.ZeroAddress, 32);

  const { rows: recipientRows } = await pool.query<{ addr: string }>(
    `SELECT DISTINCT treasury_recipient AS addr FROM nft_waves
       WHERE wave_number = $1 AND collection_id = $2 AND treasury_recipient IS NOT NULL`,
    [waveNum, collectionId],
  );

  const tokenIdSet = new Set<number>();
  const tokenIdToTxHash = new Map<number, string>();
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - 150_000);
  const CHUNK = 2_000;

  for (const { addr } of recipientRows) {
    const paddedTo = ethers.zeroPadValue(addr.toLowerCase(), 32);
    let cursor = fromBlock;
    while (cursor <= latestBlock) {
      const end = Math.min(cursor + CHUNK - 1, latestBlock);
      try {
        const logs = await provider.getLogs({
          address: CONTRACT_ADDR,
          topics: [TRANSFER_TOPIC, ZERO_PADDED, paddedTo],
          fromBlock: cursor,
          toBlock: end,
        });
        for (const log of logs) {
          const tokenId = Number(BigInt(log.topics[3]));
          tokenIdSet.add(tokenId);
          tokenIdToTxHash.set(tokenId, log.transactionHash);
        }
      } catch { }
      cursor = end + 1;
    }
  }

  const chainTokenIds = [...tokenIdSet].sort((a, b) => a - b);

  let assigned = 0;
  const toReveal: string[] = [];
  for (let i = 0; i < Math.min(chainTokenIds.length, unassigned.length); i++) {
    await pool.query(
      `UPDATE nft_records
            SET token_id          = $2,
                on_chain_wave_num = $3,
                mint_type         = 'treasury',
                minted_at         = COALESCE(minted_at, NOW()),
                mint_tx_hash      = COALESCE(mint_tx_hash, $4),
                synced_at         = NOW(),
                updated_at        = NOW()
          WHERE id = $1::uuid AND token_id IS NULL`,
      [unassigned[i].id, chainTokenIds[i], waveNum, tokenIdToTxHash.get(chainTokenIds[i]) ?? null],
    );
    logNftActivity({
      nftRecordId: unassigned[i].id,
      tokenId: chainTokenIds[i],
      action: "wave_assigned",
      source: "on_chain",
      platform: "bearth",
      txHash: tokenIdToTxHash.get(chainTokenIds[i]) ?? undefined,
      details: { waveNumber: waveNum, repairRun: true },
    });
    toReveal.push(unassigned[i].id);
    assigned++;
  }

  if (tokenIdToTxHash.size > 0) {
    const { rows: needsTxHash } = await pool.query<{ id: string; token_id: number }>(
      `SELECT nr.id, nr.token_id
           FROM nft_records nr
           JOIN lookup_values lv ON lv.id = nr.delivery_status_id
          WHERE nr.wave_id = $1::uuid
            AND nr.token_id IS NOT NULL
            AND nr.mint_tx_hash IS NULL
            AND lv.code IN ('transferred', 'treasury_wallet')`,
      [waveId],
    );
    for (const row of needsTxHash) {
      const txHash = tokenIdToTxHash.get(row.token_id);
      if (!txHash) continue;
      await pool.query(
        `UPDATE nft_records SET mint_tx_hash = $2, updated_at = NOW() WHERE id = $1::uuid`,
        [row.id, txHash],
      );
    }
    if (needsTxHash.length > 0)
      console.log(`[treasury-repair] Wave ${waveNum}: backfilled mint_tx_hash for ${needsTxHash.length} existing record(s)`);
  }

  let revealed = 0;
  if (toReveal.length) {
    const { rowCount } = await pool.query(
      `UPDATE nft_records
            SET is_revealed = TRUE,
                revealed_at = COALESCE(revealed_at, NOW()),
                updated_at  = NOW()
          WHERE id = ANY($1::uuid[])`,
      [toReveal],
    );
    revealed = rowCount ?? 0;
  }

  if (assigned > 0 && startingIndex != null) {
    await _syncRevealedMetadata(waveNum, collectionId);
  }

  console.log(`[treasury-repair] Wave ${waveNum}: assigned=${assigned}, revealed=${revealed}`);
  return { assigned, revealed };
}
