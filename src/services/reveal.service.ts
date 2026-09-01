import pool from "../pool";
import { logNftActivity } from "./nft-log.service";
import { ethers } from "ethers";
import GenesisABI from "../abi/BearthNFT.abi.json";
import CoordinatorABI from "../abi/BearthRevealCoordinator.abi.json";

function getSigner(): ethers.Wallet {
  const rpcUrl = process.env.ETH_RPC_URL;
  const privateKey = process.env.FIXED_PRIVATE_KEY;
  if (!rpcUrl || !privateKey) throw new Error("ETH_RPC_URL and FIXED_PRIVATE_KEY required for reveal");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new ethers.Wallet(privateKey, provider);
}

function getGenesisContract(signer: ethers.Wallet): ethers.Contract {
  const addr = process.env.CONTRACT_ADDRESS;
  if (!addr) throw new Error("CONTRACT_ADDRESS required for reveal");
  return new ethers.Contract(addr, GenesisABI, signer);
}

function getCoordinatorContract(signer: ethers.Wallet): ethers.Contract | null {
  const addr = process.env.REVEAL_COORDINATOR_ADDRESS;
  if (!addr) return null;
  return new ethers.Contract(addr, CoordinatorABI, signer);
}

export async function executeWaveReveal(waveNum: number): Promise<string | null> {
  const { rows: waveRows } = await pool.query<{
    id: string;
    wave_number: number;
    wave_reveal_uri: string | null;
  }>(
    "SELECT id, wave_number, wave_reveal_uri FROM nft_waves WHERE wave_number = $1",
    [waveNum],
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

  if (!process.env.CONTRACT_ADDRESS || !process.env.ETH_RPC_URL || !process.env.FIXED_PRIVATE_KEY) {
    console.log(`[reveal] Wave ${waveNum}: no contract env vars — DB-only reveal (dev mode)`);
    await _updateWaveRevealedInDB(wave.id, waveNum, revealUri, null, null, null);
    return null;
  }

  const signer = getSigner();
  const nft = getGenesisContract(signer);
  const coordinator = getCoordinatorContract(signer);

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
      } catch { /* skip unparseable logs */ }
    }

    await pool.query(
      `UPDATE nft_waves SET
         provenance_hash  = $2,
         vrf_request_id   = $3,
         vrf_requested_at = NOW(),
         updated_at       = NOW()
       WHERE wave_number = $1`,
      [waveNum, provenanceHash, vrfRequestId],
    );

    console.log(`[reveal] Wave ${waveNum}: waiting for WaveRevealed event (up to 10 min)…`);
    const txHash = await _waitForWaveRevealed(nft, waveNum, 10 * 60 * 1000, requestReceipt.blockNumber);
    console.log(`[reveal] Wave ${waveNum}: revealed on-chain, tx: ${txHash}`);

    let startingIndexNum: number | null = null;
    try {
      const si = await (coordinator.waveStartingIndex as (n: number) => Promise<bigint>)(waveNum);
      startingIndexNum = Number(si);
      console.log(`[reveal] Wave ${waveNum}: startingIndex = ${startingIndexNum}`);
    } catch { }

    await _updateWaveRevealedInDB(wave.id, waveNum, revealUri, txHash, provenanceHash, startingIndexNum);
    await _syncRevealedMetadata(waveNum);
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

  await _updateWaveRevealedInDB(wave.id, waveNum, revealUri, txHash, null, 0);
  await _syncRevealedMetadata(waveNum);
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

export async function _syncRevealedMetadata(waveNum: number): Promise<void> {
  const { rows: waveRows } = await pool.query<{
    quantity: number;
    starting_index: number | null;
  }>(
    `SELECT quantity, starting_index FROM nft_waves WHERE wave_number = $1`,
    [waveNum],
  );
  if (!waveRows.length) return;
  const { quantity: waveQty, starting_index: startingIndex } = waveRows[0];

  const { rows: mintedTokens } = await pool.query<{ id: string; token_id: number }>(
    `SELECT id, token_id FROM nft_records WHERE on_chain_wave_num = $1 AND token_id IS NOT NULL`,
    [waveNum],
  );
  if (!mintedTokens.length) {
    console.log(`[reveal] Wave ${waveNum}: no minted tokens to sync metadata for`);
    return;
  }

  console.log(`[reveal] Wave ${waveNum}: syncing artwork for ${mintedTokens.length} tokens (startingIndex=${startingIndex ?? "none"})…`);

  const assignments = mintedTokens.map(({ id, token_id }) => {
    const artworkEdition = startingIndex != null
      ? ((token_id - 1 + startingIndex) % waveQty) + 1
      : token_id;
    return { id, token_id, artworkEdition };
  });

  const editionSerials = [...new Set(assignments.map(a => `#${a.artworkEdition}`))];
  const { rows: artworkRows } = await pool.query<{
    serial_number: string;
    image_ipfs_hash: string | null;
    metadata_ipfs_hash: string | null;
    metadata_uri: string | null;
    blind_box_uri: string | null;
    traits: Record<string, string> | null;
  }>(
    `SELECT serial_number, image_ipfs_hash, metadata_ipfs_hash, metadata_uri, blind_box_uri, traits
     FROM nft_records
     WHERE serial_number = ANY($1::text[])`,
    [editionSerials],
  );
  const artworkMap = new Map(artworkRows.map(r => [r.serial_number, r]));

  let synced = 0;
  let missing = 0;
  for (const { id, token_id, artworkEdition } of assignments) {
    const artwork = artworkMap.get(`#${artworkEdition}`);
    if (!artwork) {
      missing++;
      console.warn(`[reveal] Wave ${waveNum} token ${token_id}: no artwork found for edition #${artworkEdition}`);
      continue;
    }
    await pool.query(
      `UPDATE nft_records SET
         image_ipfs_hash    = $2,
         metadata_ipfs_hash = $3,
         metadata_uri       = $4,
         blind_box_uri      = COALESCE($5, blind_box_uri),
         traits             = $6,
         updated_at         = NOW()
       WHERE id = $1::uuid`,
      [id, artwork.image_ipfs_hash, artwork.metadata_ipfs_hash,
        artwork.metadata_uri, artwork.blind_box_uri, artwork.traits],
    );
    synced++;
  }
  console.log(`[reveal] Wave ${waveNum}: artwork sync complete — ${synced} updated, ${missing} missing`);

  // Same 1%/5%/15% percentage thresholds generate.ts's computeRarity() uses
  // at generation time (the canonical source) — this was previously a fixed
  // rank cutoff (<=100/500/1500) with no relationship to the actual
  // collection size, so any collection whose supply isn't close to ~10,000
  // got every item mis-tiered here (e.g. a 50-item collection: rank<=100 is
  // always true, so every revealed item became "legendary"). nft_records
  // holds exactly one collection's rows at a time, so its own row count is
  // that collection's real supply.
  const { rows: supplyRows } = await pool.query(`SELECT COUNT(*) AS total FROM nft_records`);
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
       AND token_id IS NOT NULL
       AND rarity_rank IS NOT NULL
       AND rarity_tier IS NULL`,
    [waveNum, legendaryMax, epicMax, rareMax],
  );
}

export async function repairTreasuryMintsForWave(waveNum: number): Promise<{ assigned: number; revealed: number }> {
  const CONTRACT_ADDR = process.env.CONTRACT_ADDRESS!;
  const RPC_URL = process.env.ETH_RPC_URL ?? process.env.ETH_RPC_URL_MAINNET ?? "";
  if (!CONTRACT_ADDR || !RPC_URL) {
    console.warn(`[treasury-repair] Wave ${waveNum}: skipped — ETH_RPC_URL or CONTRACT_ADDRESS not set`);
    return { assigned: 0, revealed: 0 };
  }

  const { rows: waveRows } = await pool.query<{ id: string; starting_index: number | null }>(
    `SELECT id, starting_index FROM nft_waves WHERE wave_number = $1`,
    [waveNum],
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
       WHERE wave_number = $1 AND treasury_recipient IS NOT NULL`,
    [waveNum],
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
      } catch { /* skip failed chunk */ }
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
    await _syncRevealedMetadata(waveNum);
  }

  console.log(`[treasury-repair] Wave ${waveNum}: assigned=${assigned}, revealed=${revealed}`);
  return { assigned, revealed };
}
