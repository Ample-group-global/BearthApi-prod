import { ethers, type Contract, type EventLog } from "ethers";
import pool from "../pool";
import BearthNFT_ABI from "../abi/BearthNFT.abi.json";
import { getProvider } from "../utils/contract-factory";
import { logNftActivity } from "./nft-log.service";
import { HttpError } from "../errors";

let _contractRO: Contract | null = null;
let _contractSigned: Contract | null = null;

export function getContractReadOnly(): Contract {
  if (!_contractRO) {
    const addr = process.env.CONTRACT_ADDRESS;
    if (!addr) throw new Error("CONTRACT_ADDRESS env var is required");
    _contractRO = new ethers.Contract(addr, BearthNFT_ABI, getProvider());
  }
  return _contractRO;
}

export function getContractWithSigner(): Contract {
  if (!_contractSigned) {
    const addr = process.env.CONTRACT_ADDRESS;
    const privateKey = process.env.CONTRACT_PRIVATE_KEY ?? process.env.FIXED_PRIVATE_KEY;
    if (!addr) throw new Error("CONTRACT_ADDRESS env var is required");
    if (!privateKey) throw new Error("CONTRACT_PRIVATE_KEY (or FIXED_PRIVATE_KEY) env var is required");
    const signer = new ethers.Wallet(privateKey, getProvider());
    _contractSigned = new ethers.Contract(addr, BearthNFT_ABI, signer);
  }
  return _contractSigned;
}

const _contractROByCollection = new Map<string, Contract>();
const _contractSignedByCollection = new Map<string, Contract>();

export async function resolveCollectionContractAddress(collectionId: string): Promise<string> {
  const { rows } = await pool.query(
    "SELECT contract_address FROM nft_collections WHERE id = $1",
    [collectionId],
  );
  const addr = rows[0]?.contract_address as string | null | undefined;
  if (!addr) throw new HttpError(400, "This collection does not have a deployed contract yet.");
  return addr;
}

async function resolveCollectionIdFromContractAddress(contractAddress: string): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT id FROM nft_collections WHERE LOWER(contract_address) = LOWER($1)",
    [contractAddress],
  );
  return rows[0]?.id ?? null;
}

export function invalidateCollectionContractCache(collectionId: string): void {
  _contractROByCollection.delete(collectionId);
  _contractSignedByCollection.delete(collectionId);
}

export async function getContractReadOnlyForCollection(collectionId: string): Promise<Contract> {
  const cached = _contractROByCollection.get(collectionId);
  if (cached) return cached;
  const addr = await resolveCollectionContractAddress(collectionId);
  const c = new ethers.Contract(addr, BearthNFT_ABI, getProvider());
  _contractROByCollection.set(collectionId, c);
  return c;
}

export async function getContractWithSignerForCollection(collectionId: string): Promise<Contract> {
  const cached = _contractSignedByCollection.get(collectionId);
  if (cached) return cached;
  const addr = await resolveCollectionContractAddress(collectionId);
  const privateKey = process.env.CONTRACT_PRIVATE_KEY ?? process.env.FIXED_PRIVATE_KEY;
  if (!privateKey) throw new Error("CONTRACT_PRIVATE_KEY (or FIXED_PRIVATE_KEY) env var is required");
  const signer = new ethers.Wallet(privateKey, getProvider());
  const c = new ethers.Contract(addr, BearthNFT_ABI, signer);
  _contractSignedByCollection.set(collectionId, c);
  return c;
}
const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  WaveSoldOut: "This wave is sold out",
  SupplyExceeded: "Collection is sold out 9,999 max supply reached",
  WaveNotStarted: "This wave has not started yet",
  WaveEnded: "This wave has ended",
  WaveNotScheduled: "This wave has not been scheduled yet",
  WaveAlreadyClosed: "This wave has already been closed",
  WavePriceLocked: "Wave price cannot be changed after the first sale",
  WaveStillActive: "Wave is still active  wait for it to end before closing",
  InvalidWaveNumber: "Invalid wave number  must be 1 to 7",
  AlreadyClaimed: "This wallet has already claimed its free mint",
  NotAllowlisted: "This wallet is not on the allowlist",
  WrongPayment: "Incorrect ETH amount sent",
  PurchaseLimitExceeded: "Purchase limit exceeded for this wallet",
  WalletBlocked: "This wallet has been blocked from minting",
  InvalidQuantity: "Invalid quantity  must be at least 1",
  TokenAlreadyMinted: "Token has already been minted",
  WrongPhase: "This action is not available in the current phase",
  InvalidPhase: "Cannot move to an earlier phase",
  ZeroAddress: "Address cannot be zero",
  InvalidTime: "Invalid time  end must be after start and in the future",
  InvalidURI: "Invalid URI  must not be empty",
  InvalidRarityTier: "Invalid rarity tier  must be 1 (Common) to 4 (Legendary)",
  InvalidRoyaltyParams: "Invalid royalty  receiver cannot be zero and BPS must be 0–1000",
  ArrayLengthMismatch: "Array length mismatch between tokenIds and values",
  TokenDoesNotExist: "Token does not exist",
  InvalidEmergencyTransfer: "Invalid emergency transfer parameters",
  TransferNotAllowed: "Transfer not allowed  SBT mode is on or account is blocked",
  SBTCannotBeApproved: "Cannot approve an SBT token",
  MarketplaceNotAllowed: "This marketplace is not approved by the transfer validator",
  RefundFailed: "ETH refund to buyer failed",
  TransferFailed: "ETH transfer to treasury failed",
  NoBalance: "No ETH balance available to withdraw",
  AccessControlUnauthorizedAccount: "Caller does not have the required role",
  EnforcedPause: "Contract is paused",
  ExpectedPause: "Contract is not currently paused",
  ReentrancyGuardReentrantCall: "Reentrant call detected",
  URIQueryForNonexistentToken: "Token does not exist",
  MintToZeroAddress: "Cannot mint to zero address",
  MintZeroQuantity: "Cannot mint zero quantity",
};

function decodeContractError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const raw = err as unknown as Record<string, unknown>;
  const data =
    (raw["data"] as string | undefined) ??
    ((raw["info"] as Record<string, unknown> | undefined)?.["error"] as Record<string, unknown> | undefined)?.["data"] as string | undefined;
  if (!data || data === "0x") return null;
  try {
    const iface = new ethers.Interface(BearthNFT_ABI);
    const decoded = iface.parseError(data);
    if (!decoded) return null;
    return CONTRACT_ERROR_MESSAGES[decoded.name] ?? decoded.name;
  } catch {
    return null;
  }
}
export async function callContract(
  methodName: string,
  args: unknown[] = [],
  overrides: Record<string, unknown> = {},
  collectionId?: string,
): Promise<ethers.TransactionReceipt> {
  const contract = collectionId ? await getContractWithSignerForCollection(collectionId) : getContractWithSigner();
  try {
    const tx = await (contract[methodName] as (...a: unknown[]) => Promise<ethers.TransactionResponse>)(
      ...args, overrides
    );
    const receipt = await tx.wait(1);
    if (!receipt) throw new Error(`No receipt for ${methodName} tx`);
    await syncReceiptLogs(receipt);
    return receipt;
  } catch (err) {
    const readable = decodeContractError(err);
    if (readable) throw new HttpError(400, readable);
    throw err;
  }
}

const KNOWN_MARKETPLACES: Record<string, string> = {
  "0x0000000000000068f116a894984e2db1123eb395": "opensea",
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc": "opensea",
  "0x000000000000ad05ccc4f10045630fb830b95127": "blur",
  "0x0000000000e655fae4d56241588680f86e3b2377": "looksrare",
};

async function detectMarketplace(txHash: string): Promise<{ platform: string; source: "on_chain" | "external" }> {
  try {
    const tx = await getProvider().getTransaction(txHash);
    const to = tx?.to?.toLowerCase() ?? "";
    const platform = KNOWN_MARKETPLACES[to] ?? "bearth";
    return { platform, source: platform === "bearth" ? "on_chain" : "external" };
  } catch { return { platform: "bearth", source: "on_chain" }; }
}

async function syncEvent(
  eventName: string,
  args: unknown[],
  txHash: string | null,
  blockNumber: number,
  logIndex: number,
  contractAddress: string
): Promise<void> {
  const emittingContract = new ethers.Contract(contractAddress, BearthNFT_ABI, getProvider());
  const collectionId = await resolveCollectionIdFromContractAddress(contractAddress);
  try {
    if (txHash) {
      const { rows: logRows } = await pool.query<{ nft_event_log: boolean }>(
        "SELECT nft_event_log($1,$2,$3,$4,$5,$6,$7)",
        [eventName, txHash, blockNumber, logIndex, null, null, JSON.stringify(argsToPayload(args))]
      );
      const isNewEvent = logRows[0]?.nft_event_log ?? true;
      if (!isNewEvent) {
        console.log(`[contract.service] Duplicate delivery of ${eventName} (${txHash}#${logIndex}) -- already processed, skipping side effects.`);
        return;
      }
    }

    switch (eventName) {
      case "WaveSold": {
        const [waveNum, buyer, qty] = args as [bigint, string, bigint];
        const waveNumN = Number(waveNum);
        const isWl = waveNumN === 1;
        const onChainCount: bigint = await emittingContract.waveSoldCount(waveNum);
        await pool.query("SELECT nft_wave_sync_sold($1,$2,$3,$4)", [waveNumN, Number(onChainCount), txHash, collectionId]);
        await pool.query("SELECT nft_wallet_sync_mint($1,$2,$3,$4)", [buyer.toLowerCase(), Number(qty), isWl || null, txHash]);
        await pool.query("SELECT customer_wallet_auto_register($1, $2)", [buyer.toLowerCase(), "customer_mint"]);
        break;
      }

      case "WaveScheduleUpdated": {
        const [waveNum, startTime, endTime] = args as [bigint, bigint, bigint];
        await pool.query("SELECT nft_wave_sync_schedule($1,$2,$3,$4,$5)", [
          Number(waveNum),
          new Date(Number(startTime) * 1000).toISOString(),
          new Date(Number(endTime) * 1000).toISOString(),
          txHash,
          collectionId,
        ]);
        break;
      }

      case "WavePriceUpdated": {
        const [waveNum, newPrice] = args as [bigint, bigint];
        await pool.query("SELECT nft_wave_sync_price($1,$2,$3,$4,$5)", [
          Number(waveNum),
          Number(ethers.formatEther(newPrice)),
          false,
          txHash,
          collectionId,
        ]);
        break;
      }

      case "WaveClosedTreasury": {
        const [waveNum, recipient, qty] = args as [bigint, string, bigint];
        await pool.query("SELECT nft_wave_sync_treasury_close($1,$2,$3,$4,$5)", [
          Number(waveNum), recipient.toLowerCase(), Number(qty), txHash, collectionId,
        ]);
        break;
      }

      case "PhaseChanged": {
        const [newPhase] = args as [number];
        const phaseNames = ["Whitelist", "PaidMint", "Revealed"];
        await pool.query("SELECT nft_collection_config_update($1,$2)", [collectionId, phaseNames[newPhase] ?? "Whitelist"]);
        break;
      }

      case "WaveRevealed": {
        const [waveNum, uri] = args as [bigint, string, bigint];
        await pool.query("SELECT nft_wave_sync_reveal($1,$2,$3,$4)", [Number(waveNum), uri, txHash, collectionId]);
        break;
      }

      case "VIPStatusChanged": {
        const [wallet, status] = args as [string, boolean];
        await pool.query("SELECT nft_wallet_set_vip($1,$2,$3)", [wallet.toLowerCase(), status, txHash]);
        break;
      }

      case "PurchaseLimitChanged": {
        const [enabled, maxPerWallet] = args as [boolean, bigint];
        await pool.query("SELECT nft_purchase_limit_upsert($1,$2,$3)", [enabled, Number(maxPerWallet), collectionId]);
        break;
      }

      case "RoyaltyUpdated": {
        const [receiver, feeBasisPoints] = args as [string, bigint];
        const { rows } = await pool.query("SELECT * FROM nft_royalty_config_get($1)", [collectionId]);
        const current = rows[0] ?? {};
        await pool.query("SELECT nft_royalty_config_upsert($1,$2,$3,$4,$5)", [
          Number(feeBasisPoints), receiver.toLowerCase(), current.enforce_royalty ?? true, txHash, collectionId,
        ]);
        break;
      }

      case "SBTChanged": {
        const [enabled] = args as [boolean];
        await pool.query("UPDATE nft_collection_config SET sbt_enabled=$1, updated_at=NOW() WHERE id=1", [enabled]);
        break;
      }

      case "TokenSBTChanged": {
        const [tokenId, enabled] = args as [bigint, boolean];
        await pool.query(
          "UPDATE nft_records SET token_sbt=$1, updated_at=NOW() WHERE token_id=$2",
          [enabled, Number(tokenId)],
        );
        break;
      }

      case "Transfer": {
        const [from, to, tokenId] = args as [string, string, bigint];
        const tokenIdN = Number(tokenId);
        if (from === ethers.ZeroAddress) {
          const waveNum: bigint = await emittingContract.getTokenWave(tokenId);
          const waveNumN = Number(waveNum);
          const treasuryWallet: string = await emittingContract.treasuryWallet();
          const isTreasury = to.toLowerCase() === treasuryWallet.toLowerCase();
          await pool.query("SELECT nft_record_sync_mint($1,$2,$3,$4,$5,$6)", [tokenIdN, to.toLowerCase(), waveNumN, txHash, collectionId, isTreasury]);
          logNftActivity({ tokenId: tokenIdN, action: "mint", source: "on_chain", platform: "bearth", toWallet: to.toLowerCase(), txHash: txHash ?? undefined, blockNumber, details: { waveNumber: waveNumN } });
          break;
        }
        if (to === ethers.ZeroAddress) break;
        await pool.query("SELECT nft_record_sync_transfer($1,$2,$3,$4)", [tokenIdN, to.toLowerCase(), null, txHash]);
        const { platform: mktPlatform, source: mktSource } = await detectMarketplace(txHash ?? "");
        logNftActivity({ tokenId: tokenIdN, action: mktSource === "external" ? "sale" : "transfer", source: mktSource, platform: mktPlatform, fromWallet: from.toLowerCase(), toWallet: to.toLowerCase(), txHash: txHash ?? undefined, blockNumber });
        break;
      }

      case "Bred":
      case "TransferValidatorUpdated":
      case "Paused":
      case "Unpaused":
      case "Emergency":
      case "ContractURIUpdated":
      case "Upgraded":
        break;

      default:
        break;
    }
  } catch (err) {
    console.error(`[contract.service] Failed to sync event ${eventName}:`, err);
  }
}
export async function syncReceiptLogs(receipt: ethers.TransactionReceipt): Promise<void> {
  const iface = new ethers.Interface(BearthNFT_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) continue;
      await syncEvent(
        parsed.name,
        [...parsed.args],
        receipt.hash,
        receipt.blockNumber,
        log.index,
        log.address
      );
    } catch {
    }
  }
}
const WATCHED_EVENTS = [
  "WaveSold", "WaveScheduleUpdated", "WavePriceUpdated", "WaveRevealed",
  "PhaseChanged", "PurchaseLimitChanged", "VIPStatusChanged",
  "WaveClosedTreasury", "RoyaltyUpdated", "SBTChanged", "TokenSBTChanged", "Transfer",
  "TransferValidatorUpdated", "Paused", "Unpaused",
];

function attachListenersFor(contract: Contract, label: string): number {
  const abiEventNames = new Set(
    contract.interface.fragments
      .filter((f) => f.type === "event")
      .map((f) => (f as unknown as { name: string }).name),
  );

  let registered = 0;
  for (const eventName of WATCHED_EVENTS) {
    if (!abiEventNames.has(eventName)) continue;
    try {
      contract.on(eventName, async (...rawArgs: unknown[]) => {
        const ev = rawArgs[rawArgs.length - 1] as EventLog;
        const args = rawArgs.slice(0, -1);
        await syncEvent(eventName, args, ev.transactionHash ?? null, ev.blockNumber, ev.index, String(contract.target));
      });
      registered++;
    } catch (err) {
      console.warn(`[contract.service] (${label}) Could not register listener for '${eventName}':`, err);
    }
  }
  return registered;
}

export async function attachListenersForCollection(collectionId: string): Promise<void> {
  const { rows } = await pool.query<{ name: string; contract_address: string }>(
    "SELECT name, contract_address FROM nft_collections WHERE id = $1 AND contract_address IS NOT NULL",
    [collectionId],
  );
  const row = rows[0];
  if (!row) return;
  const contract = new ethers.Contract(row.contract_address, BearthNFT_ABI, getProvider());
  const count = attachListenersFor(contract, row.name);
  console.log(`[contract.service] Event listeners attached post-deploy on ${row.contract_address} (${row.name}, ${count}/${WATCHED_EVENTS.length} events)`);
}

export async function startEventListeners(): Promise<void> {
  if (process.env.VERCEL) return;

  let legacyAddress: string | null = null;
  if (process.env.CONTRACT_ADDRESS) {
    try {
      const legacy = getContractReadOnly();
      legacyAddress = String(legacy.target).toLowerCase();
      const legacyCount = attachListenersFor(legacy, "legacy");
      console.log(`[contract.service] Event listeners started on ${process.env.CONTRACT_ADDRESS} (${legacyCount}/${WATCHED_EVENTS.length} events)`);
    } catch (err) {
      console.warn("[contract.service] Could not attach legacy event listeners:", err);
    }
  }

  try {
    const { rows } = await pool.query<{ id: string; name: string; contract_address: string }>(
      `SELECT id, name, contract_address FROM nft_collections WHERE contract_address IS NOT NULL`
    );
    for (const row of rows) {
      if (legacyAddress && row.contract_address.toLowerCase() === legacyAddress) continue;
      const contract = new ethers.Contract(row.contract_address, BearthNFT_ABI, getProvider());
      const count = attachListenersFor(contract, row.name);
      console.log(`[contract.service] Event listeners started on ${row.contract_address} (${row.name}, ${count}/${WATCHED_EVENTS.length} events)`);
    }
  } catch (err) {
    console.warn("[contract.service] Could not attach collection-wise event listeners:", err);
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Some RPC providers (e.g. Alchemy's free tier) hard-cap eth_getLogs to a
// tiny block range (10 blocks) regardless of the range requested -- a
// fixed 500-block CHUNK would 400 on every single chunk against such a
// provider, silently skipping the collection's entire mint/reveal/etc.
// history. Detected live 2026-09-11: a real customer mint succeeded
// on-chain but never reached the DB because of exactly this.
function isBlockRangeLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /block range|up to a \d+ block range/i.test(message);
}

async function getLogsWithAdaptiveRange(
  provider: ethers.Provider,
  contractAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<Awaited<ReturnType<typeof provider.getLogs>>> {
  try {
    return await provider.getLogs({ address: contractAddress, fromBlock, toBlock });
  } catch (err) {
    if (!isBlockRangeLimitError(err) || fromBlock >= toBlock) throw err;
    // Split in half and retry each half -- converges quickly (log2) even
    // against a 10-block-max provider, without permanently paying the cost
    // of tiny chunks when the provider doesn't actually need them.
    const mid = fromBlock + Math.floor((toBlock - fromBlock) / 2);
    const [first, second] = await Promise.all([
      getLogsWithAdaptiveRange(provider, contractAddress, fromBlock, mid),
      getLogsWithAdaptiveRange(provider, contractAddress, mid + 1, toBlock),
    ]);
    return [...first, ...second];
  }
}

export async function resyncFromBlock(fromBlock = 0, collectionId?: string): Promise<{ synced: number; scannedBlocks: number; skippedChunks: number }> {
  const provider = getProvider();
  const contract = collectionId ? await getContractReadOnlyForCollection(collectionId) : getContractReadOnly();
  const contractAddress = collectionId ? await resolveCollectionContractAddress(collectionId) : process.env.CONTRACT_ADDRESS;
  const iface = contract.interface;
  const CHUNK = 500;
  const latestBlock = await provider.getBlockNumber();
  const startBlock = fromBlock === 0
    ? Math.max(0, latestBlock - 20_000)
    : fromBlock;

  let synced = 0;
  let skippedChunks = 0;
  let cursor = startBlock;

  while (cursor <= latestBlock) {
    const end = Math.min(cursor + CHUNK - 1, latestBlock);

    let logs: Awaited<ReturnType<typeof provider.getLogs>> = [];
    try {
      logs = await getLogsWithAdaptiveRange(provider, contractAddress!, cursor, end);
    } catch (chunkErr) {
      console.error(`[resync] getLogs chunk ${cursor}-${end} failed, skipping:`, chunkErr);
      skippedChunks++;
      cursor = end + 1;
      await sleep(300);
      continue;
    }

    for (const log of logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!parsed) continue;
        await syncEvent(
          parsed.name, [...parsed.args],
          log.transactionHash, log.blockNumber, log.index, log.address
        );
        synced++;
      } catch {
      }
    }
    cursor = end + 1;
    if (cursor <= latestBlock) await sleep(100);
  }

  return { synced, scannedBlocks: latestBlock - startBlock + 1, skippedChunks };
}

export async function contractSetWaveSchedule(
  waveNum: number,
  startUnix: number,
  endUnix: number,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1–7");
  if (endUnix <= startUnix) throw new Error("End time must be after start time");
  return callContract("setWaveSchedule", [waveNum, startUnix, endUnix], {}, collectionId);
}

export async function contractSetWavePrice(
  waveNum: number,
  priceWei: bigint,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1–7");
  const { rows } = await pool.query("SELECT price_locked FROM nft_waves WHERE wave_number=$1 AND collection_id=$2", [waveNum, collectionId]);
  if (rows[0]?.price_locked) throw new Error(`Wave ${waveNum} price is locked  first sale has occurred`);
  return callContract("setWavePrice", [waveNum, priceWei], {}, collectionId);
}

export async function contractTreasuryClose(
  waveNum: number,
  recipient: string | null,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1–7");
  let to = recipient;
  if (!to) {
    to = await (await getContractReadOnlyForCollection(collectionId)).treasuryWallet() as string;
  }
  if (!ethers.isAddress(to)) throw new Error("Invalid recipient address");
  return callContract("treasuryClose", [waveNum, to], {}, collectionId);
}

export async function contractSetRoyalty(
  receiverAddress: string,
  feeBps: number,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (feeBps < 0 || feeBps > 1000) throw new Error("Royalty basis points must be 0–1000 (max 10%)");
  if (!ethers.isAddress(receiverAddress)) throw new Error("Invalid receiver address");
  return callContract("setRoyalty", [receiverAddress, feeBps], {}, collectionId);
}

export async function contractSetTransferValidator(
  validatorAddress: string,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(validatorAddress)) throw new Error("Invalid validator address");
  return callContract("setTransferValidator", [validatorAddress], {}, collectionId);
}

export async function contractSetVIP(
  walletAddress: string,
  isVip: boolean
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(walletAddress)) throw new Error("Invalid wallet address");
  return callContract("setVIP", [walletAddress, isVip]);
}

export async function contractSetPurchaseLimitConfig(
  enabled: boolean,
  normalMaxPerWallet: number,
  collectionId: string,
): Promise<ethers.TransactionReceipt> {
  if (normalMaxPerWallet < 1) throw new Error("Max per wallet must be at least 1");
  return callContract("setPurchaseLimitConfig", [enabled, normalMaxPerWallet], {}, collectionId);
}

export async function contractSetPhase(
  phase: 0 | 1 | 2
): Promise<ethers.TransactionReceipt> {
  return callContract("setPhase", [phase]);
}

export async function contractSetAllowlistRoot(
  root: string,
  collectionId?: string
): Promise<ethers.TransactionReceipt> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(root)) throw new Error("root must be a 32-byte hex string (0x...)");
  return callContract("setAllowlistRoot", [root], {}, collectionId);
}

export const contractSetMerkleRoot = contractSetAllowlistRoot;

export async function contractSetTreasuryWallet(
  wallet: string
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(wallet)) throw new Error("Invalid treasury wallet address");
  return callContract("setTreasuryWallet", [wallet]);
}

export async function contractWithdraw(collectionId: string): Promise<ethers.TransactionReceipt> {
  return callContract("withdraw", [], {}, collectionId);
}

export async function contractReserveMint(
  to: string,
  qty: number,
  waveNum: number = 0,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(to)) throw new Error("Invalid recipient address");
  if (qty < 1) throw new Error("Quantity must be at least 1");
  if (waveNum < 0 || waveNum > 7) throw new Error("Wave number must be 0 (treasury) to 7");
  return callContract("reserveMint", [to, qty, waveNum], {}, collectionId);
}

export async function contractSetSBT(
  enabled: boolean,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  return callContract("setSBT", [enabled], {}, collectionId);
}

export async function contractSetTokenSBT(
  tokenId: number,
  enabled: boolean,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  return callContract("setTokenSBT", [tokenId, enabled], {}, collectionId);
}

export async function contractPause(collectionId: string): Promise<ethers.TransactionReceipt> {
  return callContract("pause", [], {}, collectionId);
}

export async function contractUnpause(collectionId: string): Promise<ethers.TransactionReceipt> {
  return callContract("unpause", [], {}, collectionId);
}

export async function contractSetBlindBoxURI(
  uri: string,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (!uri) throw new Error("URI is required");
  return callContract("setBlindBoxURI", [uri], {}, collectionId);
}

export async function contractEmergencyTransfer(
  id: number,
  from: string,
  to: string,
  reason: string,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(from)) throw new Error("Invalid from address");
  if (!ethers.isAddress(to)) throw new Error("Invalid to address");
  if (!reason?.trim()) throw new Error("reason is required");
  return callContract("emergencyTransfer", [id, from, to, reason], {}, collectionId);
}

export async function contractBlockAccount(
  wallet: string,
  blocked: boolean,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(wallet)) throw new Error("Invalid wallet address");
  return callContract("blockAccount", [wallet, blocked], {}, collectionId);
}

export async function contractTransferFromBatch(
  tokenIds: number[],
  recipient: string,
  collectionId: string
): Promise<{ tokenId: number; txHash: string }[]> {
  if (!ethers.isAddress(recipient)) throw new Error("Invalid recipient address");
  if (!tokenIds.length) throw new Error("tokenIds must not be empty");
  if (tokenIds.length > 50) throw new Error("Maximum 50 tokens per batch");
  const contract = await getContractReadOnlyForCollection(collectionId);
  const treasury = (await contract.treasuryWallet()) as string;
  const results: { tokenId: number; txHash: string }[] = [];
  for (const tokenId of tokenIds) {
    const receipt = await callContract("transferFrom", [treasury, recipient, BigInt(tokenId)], {}, collectionId);
    results.push({ tokenId, txHash: receipt.hash });
  }
  return results;
}

export async function contractGetCollectionInfo(collectionId: string): Promise<{
  currentPhase: number;
  maxSupply: bigint;
  totalMinted: bigint;
  sbt: boolean;
  purchaseLimitEnabled: boolean;
  normalMaxPerWallet: bigint;
}> {
  const c = await getContractReadOnlyForCollection(collectionId);
  const [currentPhase, maxSupply, totalMinted, sbt, purchaseLimitEnabled, normalMaxPerWallet] = await Promise.all([
    c.currentPhase() as Promise<bigint>,
    c.MAX_SUPPLY() as Promise<bigint>,
    c.totalSupply() as Promise<bigint>,
    c.sbt() as Promise<boolean>,
    c.purchaseLimitEnabled() as Promise<boolean>,
    c.normalMaxPerWallet() as Promise<bigint>,
  ]);
  return {
    currentPhase: Number(currentPhase),
    maxSupply,
    totalMinted,
    sbt,
    purchaseLimitEnabled,
    normalMaxPerWallet,
  };
}

export async function contractGetRoyalty(collectionId: string): Promise<{ receiver: string; feeBps: number } | null> {
  try {
    const c = await getContractReadOnlyForCollection(collectionId);
    const [receiver, royaltyAmount] = await c.royaltyInfo(1, 10000) as [string, bigint];
    return { receiver, feeBps: Number(royaltyAmount) };
  } catch {
    return null;
  }
}

export async function contractIsGenesis(tokenId: number): Promise<boolean> {
  return (await contractGetSeries(tokenId)) <= 2;
}

export async function contractGetSeries(tokenId: number): Promise<number> {
  return Number(await getContractReadOnly().getTokenWave(tokenId));
}

export async function contractGetWaveInfo(waveNum: number, collectionId?: string): Promise<{
  price: bigint;
  qty: bigint;
  soldCount: bigint;
  startTime: bigint;
  endTime: bigint;
  closed: boolean;
  active: boolean;
  revealed: boolean;
}> {
  const c = collectionId ? await getContractReadOnlyForCollection(collectionId) : getContractReadOnly();
  const [price, qty, soldCount, startTime, endTime, closed, revealed] = await Promise.all([
    c.wavePrice(waveNum) as Promise<bigint>,
    c.waveQty(waveNum) as Promise<bigint>,
    c.waveSoldCount(waveNum) as Promise<bigint>,
    c.waveStartTime(waveNum) as Promise<bigint>,
    c.waveEndTime(waveNum) as Promise<bigint>,
    c.waveClosed(waveNum) as Promise<boolean>,
    c.waveRevealed(waveNum) as Promise<boolean>,
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const active = !closed && startTime > 0n && now >= startTime && (endTime === 0n || now <= endTime);
  return { price, qty, soldCount, startTime, endTime, closed, active, revealed };
}

export async function contractGetWavePurchaseLimit(waveNum: number, collectionId?: string): Promise<number> {
  const c = collectionId ? await getContractReadOnlyForCollection(collectionId) : getContractReadOnly();
  const limit: bigint = await (c.wavePurchaseLimit(waveNum) as Promise<bigint>);
  return Number(limit);
}

export async function contractSetWavePurchaseLimit(
  waveNum: number,
  maxPerWallet: number,
  collectionId?: string
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1-7");
  if (maxPerWallet < 0) throw new Error("maxPerWallet must be >= 0");
  return callContract("setWavePurchaseLimit", [waveNum, maxPerWallet], {}, collectionId);
}

export async function contractRevealWave(
  waveNum: number,
  uri: string,
  collectionId?: string
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1–7");
  if (!uri?.startsWith("ipfs://")) throw new Error("URI must start with ipfs://");
  return callContract("revealWave", [waveNum, uri], {}, collectionId);
}

export async function contractGetWalletInfo(address: string): Promise<{
  totalMinted: bigint;
  isVip: boolean;
  wlClaimed: boolean;
  balance: bigint;
}> {
  const c = getContractReadOnly();
  const [balance, isVip, wlClaimed, totalMinted] = await Promise.all([
    c.balanceOf(address) as Promise<bigint>,
    c.isVIP(address) as Promise<boolean>,
    c.allowlistClaimed(address) as Promise<boolean>,
    c.walletTotalMinted(address) as Promise<bigint>,
  ]);
  return { totalMinted, isVip, wlClaimed, balance };
}
function argsToPayload(args: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  args.forEach((v, i) => {
    out[`arg${i}`] = typeof v === "bigint" ? v.toString() : v;
  });
  return out;
}
