import { ethers, type Contract, type EventLog } from "ethers";
import pool from "../pool";
import BearthNFT_ABI from "../abi/BearthNFT.abi.json";
import { getProvider } from "../utils/contract-factory";
import { logNftActivity } from "./nft-log.service";

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
    // CONTRACT_PRIVATE_KEY is the per-environment signer key:
    const privateKey = process.env.CONTRACT_PRIVATE_KEY ?? process.env.FIXED_PRIVATE_KEY;
    if (!addr) throw new Error("CONTRACT_ADDRESS env var is required");
    if (!privateKey) throw new Error("CONTRACT_PRIVATE_KEY (or FIXED_PRIVATE_KEY) env var is required");
    const signer = new ethers.Wallet(privateKey, getProvider());
    _contractSigned = new ethers.Contract(addr, BearthNFT_ABI, signer);
  }
  return _contractSigned;
}
const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  // Wave / supply
  WaveSoldOut: "This wave is sold out",
  SupplyExceeded: "Collection is sold out 9,999 max supply reached",
  WaveNotStarted: "This wave has not started yet",
  WaveEnded: "This wave has ended",
  WaveNotScheduled: "This wave has not been scheduled yet",
  WaveAlreadyClosed: "This wave has already been closed",
  WavePriceLocked: "Wave price cannot be changed after the first sale",
  WaveStillActive: "Wave is still active  wait for it to end before closing",
  InvalidWaveNumber: "Invalid wave number  must be 1 to 7",
  // Mint
  AlreadyClaimed: "This wallet has already claimed its free mint",
  NotAllowlisted: "This wallet is not on the allowlist",
  WrongPayment: "Incorrect ETH amount sent",
  PurchaseLimitExceeded: "Purchase limit exceeded for this wallet",
  WalletBlocked: "This wallet has been blocked from minting",
  InvalidQuantity: "Invalid quantity  must be at least 1",
  TokenAlreadyMinted: "Token has already been minted",
  // Phase / state
  WrongPhase: "This action is not available in the current phase",
  InvalidPhase: "Cannot move to an earlier phase",
  // Params
  ZeroAddress: "Address cannot be zero",
  InvalidTime: "Invalid time  end must be after start and in the future",
  InvalidURI: "Invalid URI  must not be empty",
  InvalidRarityTier: "Invalid rarity tier  must be 1 (Common) to 4 (Legendary)",
  InvalidRoyaltyParams: "Invalid royalty  receiver cannot be zero and BPS must be 0–1000",
  ArrayLengthMismatch: "Array length mismatch between tokenIds and values",
  TokenDoesNotExist: "Token does not exist",
  InvalidEmergencyTransfer: "Invalid emergency transfer parameters",
  // Transfer / SBT
  TransferNotAllowed: "Transfer not allowed  SBT mode is on or account is blocked",
  SBTCannotBeApproved: "Cannot approve an SBT token",
  MarketplaceNotAllowed: "This marketplace is not approved by the transfer validator",
  // Finance
  RefundFailed: "ETH refund to buyer failed",
  TransferFailed: "ETH transfer to treasury failed",
  NoBalance: "No ETH balance available to withdraw",
  // Access
  AccessControlUnauthorizedAccount: "Caller does not have the required role",
  // Pause
  EnforcedPause: "Contract is paused",
  ExpectedPause: "Contract is not currently paused",
  // Reentrancy
  ReentrancyGuardReentrantCall: "Reentrant call detected",
  // ERC721A internals
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
  overrides: Record<string, unknown> = {}
): Promise<ethers.TransactionReceipt> {
  const contract = getContractWithSigner();
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
    if (readable) throw new Error(readable);
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
  logIndex: number
): Promise<void> {
  try {
    if (txHash) {
      await pool.query(
        "SELECT nft_event_log($1,$2,$3,$4,$5,$6,$7)",
        [eventName, txHash, blockNumber, logIndex, null, null, JSON.stringify(argsToPayload(args))]
      );
    }

    switch (eventName) {
      case "WaveSold": {
        // WaveSold(waveNum indexed, buyer indexed, qty)
        const [waveNum, buyer, qty] = args as [bigint, string, bigint];
        const waveNumN = Number(waveNum);
        const isWl = waveNumN === 1;
        const onChainCount: bigint = await getContractReadOnly().waveSoldCount(waveNum);
        await pool.query("SELECT nft_wave_sync_sold($1,$2,$3)", [waveNumN, Number(onChainCount), txHash]);
        await pool.query("SELECT nft_wallet_sync_mint($1,$2,$3,$4)", [buyer.toLowerCase(), Number(qty), isWl || null, txHash]);
        // Auto-register buyer (creates customer user if wallet has no user_id)
        await pool.query("SELECT customer_wallet_auto_register($1, $2)", [buyer.toLowerCase(), "customer_mint"]);
        break;
      }

      case "WaveScheduleUpdated": {
        const [waveNum, startTime, endTime] = args as [bigint, bigint, bigint];
        await pool.query("SELECT nft_wave_sync_schedule($1,$2,$3,$4)", [
          Number(waveNum),
          new Date(Number(startTime) * 1000).toISOString(),
          new Date(Number(endTime) * 1000).toISOString(),
          txHash,
        ]);
        break;
      }

      case "WavePriceUpdated": {
        const [waveNum, newPrice] = args as [bigint, bigint];
        await pool.query("SELECT nft_wave_sync_price($1,$2,$3,$4)", [
          Number(waveNum),
          Number(ethers.formatEther(newPrice)),
          false,
          txHash,
        ]);
        break;
      }

      case "WaveClosedTreasury": {
        // WaveClosedTreasury(waveNum indexed, recipient indexed, qty)
        const [waveNum, recipient, qty] = args as [bigint, string, bigint];
        await pool.query("SELECT nft_wave_sync_treasury_close($1,$2,$3,$4)", [
          Number(waveNum), recipient.toLowerCase(), Number(qty), txHash,
        ]);
        break;
      }

      case "PhaseChanged": {
        const [newPhase] = args as [number];
        const phaseNames = ["Whitelist", "PaidMint", "Revealed"];
        await pool.query("SELECT nft_collection_config_update($1,$2)", [null, phaseNames[newPhase] ?? "Whitelist"]);
        break;
      }

      case "WaveRevealed": {
        // WaveRevealed(waveNum indexed, uri, timestamp)
        const [waveNum, uri] = args as [bigint, string, bigint];
        await pool.query("SELECT nft_wave_sync_reveal($1,$2,$3)", [Number(waveNum), uri, txHash]);
        break;
      }

      case "VIPStatusChanged": {
        const [wallet, status] = args as [string, boolean];
        await pool.query("SELECT nft_wallet_set_vip($1,$2,$3)", [wallet.toLowerCase(), status, txHash]);
        break;
      }

      case "PurchaseLimitChanged": {
        const [enabled, maxPerWallet] = args as [boolean, bigint];
        await pool.query("SELECT nft_purchase_limit_upsert($1,$2,$3)", [enabled, Number(maxPerWallet), txHash]);
        break;
      }

      case "RoyaltyUpdated": {
        const [receiver, feeBasisPoints] = args as [string, bigint];
        const { rows } = await pool.query("SELECT nft_royalty_config_get()");
        const current = rows[0]?.nft_royalty_config_get ?? {};
        await pool.query("SELECT nft_royalty_config_upsert($1,$2,$3,$4)", [
          Number(feeBasisPoints), receiver.toLowerCase(), current.enforce_royalty ?? true, txHash,
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
          // Mint event — sync DB record and log
          const waveNum: bigint = await getContractReadOnly().getTokenWave(tokenId);
          const waveNumN = Number(waveNum);
          await pool.query("SELECT nft_record_sync_mint($1,$2,$3,$4)", [tokenIdN, to.toLowerCase(), waveNumN, txHash]);
          logNftActivity({ tokenId: tokenIdN, action: "mint", source: "on_chain", platform: "bearth", toWallet: to.toLowerCase(), txHash: txHash ?? undefined, blockNumber, details: { waveNumber: waveNumN } });
          break;
        }
        if (to === ethers.ZeroAddress) break; // burn — no action needed
        await pool.query("SELECT nft_record_sync_transfer($1,$2,$3,$4)", [tokenIdN, to.toLowerCase(), null, txHash]);
        const { platform: mktPlatform, source: mktSource } = await detectMarketplace(txHash ?? "");
        logNftActivity({ tokenId: tokenIdN, action: mktSource === "external" ? "sale" : "transfer", source: mktSource, platform: mktPlatform, fromWallet: from.toLowerCase(), toWallet: to.toLowerCase(), txHash: txHash ?? undefined, blockNumber });
        break;
      }

      // Log-only events (no DB state change needed)
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
async function syncReceiptLogs(receipt: ethers.TransactionReceipt): Promise<void> {
  const contract = getContractReadOnly();
  const iface = contract.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) continue;
      await syncEvent(
        parsed.name,
        [...parsed.args],
        receipt.hash,
        receipt.blockNumber,
        log.index
      );
    } catch {
      // Unknown event from another contract in the same tx  skip
    }
  }
}
export function startEventListeners(): void {
  if (process.env.VERCEL) return;

  const contract = getContractReadOnly();

  const watchedEvents = [
    "WaveSold", "WaveScheduleUpdated", "WavePriceUpdated", "WaveRevealed",
    "PhaseChanged", "PurchaseLimitChanged", "VIPStatusChanged",
    "WaveClosedTreasury", "RoyaltyUpdated", "SBTChanged", "TokenSBTChanged", "Transfer",
    "TransferValidatorUpdated", "Paused", "Unpaused",
  ];

  // Guard: only register events that exist in the deployed ABI.
  const abiEventNames = new Set(
    contract.interface.fragments
      .filter((f) => f.type === "event")
      .map((f) => (f as unknown as { name: string }).name),
  );

  let registered = 0;
  for (const eventName of watchedEvents) {
    if (!abiEventNames.has(eventName)) {
      console.warn(`[contract.service] Skipping unknown event '${eventName}' (not in ABI)`);
      continue;
    }
    try {
      contract.on(eventName, async (...rawArgs: unknown[]) => {
        const ev = rawArgs[rawArgs.length - 1] as EventLog;
        const args = rawArgs.slice(0, -1);
        await syncEvent(eventName, args, ev.transactionHash ?? null, ev.blockNumber, ev.index);
      });
      registered++;
    } catch (err) {
      console.warn(`[contract.service] Could not register listener for '${eventName}':`, err);
    }
  }

  console.log(`[contract.service] Event listeners started on ${process.env.CONTRACT_ADDRESS} (${registered}/${watchedEvents.length} events)`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function resyncFromBlock(fromBlock = 0): Promise<{ synced: number; scannedBlocks: number; skippedChunks: number }> {
  const provider = getProvider();
  const contract = getContractReadOnly();
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
      logs = await provider.getLogs({
        address: process.env.CONTRACT_ADDRESS,
        fromBlock: cursor,
        toBlock: end,
      });
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
          log.transactionHash, log.blockNumber, log.index
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
  endUnix: number
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1–7");
  if (endUnix <= startUnix) throw new Error("End time must be after start time");
  return callContract("setWaveSchedule", [waveNum, startUnix, endUnix]);
}

export async function contractSetWavePrice(
  waveNum: number,
  priceWei: bigint,
  collectionId: string
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1–7");
  const { rows } = await pool.query("SELECT price_locked FROM nft_waves WHERE wave_number=$1 AND collection_id=$2", [waveNum, collectionId]);
  if (rows[0]?.price_locked) throw new Error(`Wave ${waveNum} price is locked  first sale has occurred`);
  return callContract("setWavePrice", [waveNum, priceWei]);
}

export async function contractTreasuryClose(
  waveNum: number,
  recipient: string | null
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1–7");
  let to = recipient;
  if (!to) {
    to = await getContractReadOnly().treasuryWallet() as string;
  }
  if (!ethers.isAddress(to)) throw new Error("Invalid recipient address");
  return callContract("treasuryClose", [waveNum, to]);
}

export async function contractSetRoyalty(
  receiverAddress: string,
  feeBps: number
): Promise<ethers.TransactionReceipt> {
  if (feeBps < 0 || feeBps > 1000) throw new Error("Royalty basis points must be 0–1000 (max 10%)");
  if (!ethers.isAddress(receiverAddress)) throw new Error("Invalid receiver address");
  return callContract("setRoyalty", [receiverAddress, feeBps]);
}

export async function contractSetTransferValidator(
  validatorAddress: string
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(validatorAddress)) throw new Error("Invalid validator address");
  return callContract("setTransferValidator", [validatorAddress]);
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
  normalMaxPerWallet: number
): Promise<ethers.TransactionReceipt> {
  if (normalMaxPerWallet < 1) throw new Error("Max per wallet must be at least 1");
  return callContract("setPurchaseLimitConfig", [enabled, normalMaxPerWallet]);
}

export async function contractSetWaveWhitelistRequired(
  waveNum: number,
  required: boolean
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1-7");
  return callContract("setWaveWhitelistRequired", [waveNum, required]);
}

export async function contractSetWaveWhitelistApprovedBatch(
  wallets: string[],
  approved: boolean
): Promise<ethers.TransactionReceipt> {
  if (!wallets.length) throw new Error("Wallet list is empty");
  if (!wallets.every(w => ethers.isAddress(w))) throw new Error("One or more addresses are invalid");
  return callContract("setWaveWhitelistApprovedBatch", [wallets, approved]);
}

export async function contractSetPhase(
  phase: 0 | 1 | 2
): Promise<ethers.TransactionReceipt> {
  return callContract("setPhase", [phase]);
}

export async function contractSetAllowlistRoot(
  root: string
): Promise<ethers.TransactionReceipt> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(root)) throw new Error("root must be a 32-byte hex string (0x...)");
  return callContract("setAllowlistRoot", [root]);
}

// Backward-compat alias used by whitelist route
export const contractSetMerkleRoot = contractSetAllowlistRoot;

export async function contractSetTreasuryWallet(
  wallet: string
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(wallet)) throw new Error("Invalid treasury wallet address");
  return callContract("setTreasuryWallet", [wallet]);
}

export async function contractWithdraw(): Promise<ethers.TransactionReceipt> {
  return callContract("withdraw", []);
}

export async function contractAuctionMint(
  to: string,
  waveNum: number,
  qty: number
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(to)) throw new Error("Invalid recipient address");
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1–7");
  if (qty < 1) throw new Error("Quantity must be at least 1");
  return callContract("auctionMint", [to, waveNum, qty]);
}

export async function contractSetTokenPrice(
  tokenId: number,
  priceWei: bigint
): Promise<ethers.TransactionReceipt> {
  const { rows } = await pool.query("SELECT rarity_price_locked FROM nft_records WHERE token_id=$1", [tokenId]);
  if (rows[0]?.rarity_price_locked) {
    throw new Error(`Token ${tokenId} rarity price is locked  already sold to a customer`);
  }
  return callContract("setTokenPrice", [tokenId, priceWei]);
}

export async function contractSetRarityBatch(
  tokenIds: number[],
  rarities: number[]
): Promise<ethers.TransactionReceipt> {
  if (tokenIds.length !== rarities.length) throw new Error("tokenIds and rarities length mismatch");
  if (rarities.some(r => r < 1 || r > 4)) throw new Error("Rarity must be 1–4 (Common/Rare/Epic/Legendary)");
  return callContract("setRarityBatch", [tokenIds, rarities]);
}

export async function contractReserveMint(
  to: string,
  qty: number
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(to)) throw new Error("Invalid recipient address");
  if (qty < 1) throw new Error("Quantity must be at least 1");
  return callContract("reserveMint", [to, qty]);
}

export async function contractSetSBT(
  enabled: boolean
): Promise<ethers.TransactionReceipt> {
  return callContract("setSBT", [enabled]);
}

export async function contractSetTokenSBT(
  tokenId: number,
  enabled: boolean
): Promise<ethers.TransactionReceipt> {
  return callContract("setTokenSBT", [tokenId, enabled]);
}

export async function contractPause(): Promise<ethers.TransactionReceipt> {
  return callContract("pause", []);
}

export async function contractUnpause(): Promise<ethers.TransactionReceipt> {
  return callContract("unpause", []);
}

export async function contractSetContractURI(
  uri: string
): Promise<ethers.TransactionReceipt> {
  if (!uri) throw new Error("URI is required");
  return callContract("setContractURI", [uri]);
}

export async function contractSetBlindBoxURI(
  uri: string
): Promise<ethers.TransactionReceipt> {
  if (!uri) throw new Error("URI is required");
  return callContract("setBlindBoxURI", [uri]);
}

export async function contractEmergencyTransfer(
  id: number,
  from: string,
  to: string,
  reason: string
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(from)) throw new Error("Invalid from address");
  if (!ethers.isAddress(to)) throw new Error("Invalid to address");
  if (!reason?.trim()) throw new Error("reason is required");
  return callContract("emergencyTransfer", [id, from, to, reason]);
}

export async function contractBlockAccount(
  wallet: string,
  blocked: boolean
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(wallet)) throw new Error("Invalid wallet address");
  return callContract("blockAccount", [wallet, blocked]);
}

export async function contractTransferFromBatch(
  tokenIds: number[],
  recipient: string
): Promise<{ tokenId: number; txHash: string }[]> {
  if (!ethers.isAddress(recipient)) throw new Error("Invalid recipient address");
  if (!tokenIds.length) throw new Error("tokenIds must not be empty");
  if (tokenIds.length > 50) throw new Error("Maximum 50 tokens per batch");
  const treasury = (await getContractReadOnly().treasuryWallet()) as string;
  const results: { tokenId: number; txHash: string }[] = [];
  for (const tokenId of tokenIds) {
    const receipt = await callContract("transferFrom", [treasury, recipient, BigInt(tokenId)]);
    results.push({ tokenId, txHash: receipt.hash });
  }
  return results;
}

export async function contractBreedMint(
  to: string,
  outputRarity: number,
  burnIds: number[]
): Promise<ethers.TransactionReceipt> {
  if (!ethers.isAddress(to)) throw new Error("Invalid recipient address");
  if (!burnIds.length) throw new Error("burnIds must not be empty");
  if (outputRarity < 1 || outputRarity > 4) throw new Error("outputRarity must be 1–4");
  return callContract("breedMint", [to, outputRarity, burnIds]);
}
export async function contractGetCollectionInfo(): Promise<{
  currentPhase: number;
  maxSupply: bigint;
  totalMinted: bigint;
  sbt: boolean;
  purchaseLimitEnabled: boolean;
  normalMaxPerWallet: bigint;
}> {
  const c = getContractReadOnly();
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

export async function contractGetRoyalty(): Promise<{ receiver: string; feeBps: number } | null> {
  try {
    const c = getContractReadOnly();
    const [receiver, royaltyAmount] = await c.royaltyInfo(1, 10000) as [string, bigint];
    return { receiver, feeBps: Number(royaltyAmount) };
  } catch {
    return null;
  }
}

export async function contractIsGenesis(tokenId: number): Promise<boolean> {
  return getContractReadOnly().isGenesis(tokenId);
}

export async function contractGetSeries(tokenId: number): Promise<number> {
  return Number(await getContractReadOnly().getSeries(tokenId));
}

export async function contractGetWaveInfo(waveNum: number): Promise<{
  price: bigint;
  qty: bigint;
  soldCount: bigint;
  startTime: bigint;
  endTime: bigint;
  closed: boolean;
  active: boolean;
  revealed: boolean;
}> {
  const c = getContractReadOnly();
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

export async function contractGetWavePurchaseLimit(waveNum: number): Promise<number> {
  const limit: bigint = await (getContractReadOnly().wavePurchaseLimit(waveNum) as Promise<bigint>);
  return Number(limit);
}

export async function contractSetWavePurchaseLimit(
  waveNum: number,
  maxPerWallet: number
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1-7");
  if (maxPerWallet < 0) throw new Error("maxPerWallet must be >= 0");
  return callContract("setWavePurchaseLimit", [waveNum, maxPerWallet]);
}

export async function contractRevealWave(
  waveNum: number,
  uri: string
): Promise<ethers.TransactionReceipt> {
  if (waveNum < 1 || waveNum > 7) throw new Error("Wave number must be 1–7");
  if (!uri?.startsWith("ipfs://")) throw new Error("URI must start with ipfs://");
  return callContract("revealWave", [waveNum, uri]);
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
