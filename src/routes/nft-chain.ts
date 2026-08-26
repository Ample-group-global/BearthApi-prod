import { Router } from "express";
import { ethers } from "ethers";
import { requireAdmin } from "../adminAuth";
import { contractEmergencyTransfer, getContractReadOnly } from "../services/contract.service";

const router = Router();
const ETH_ADDR = /^0x[a-fA-F0-9]{40}$/;

const RPC_URL         = process.env.ETH_RPC_URL         ?? "";
const CONTRACT_ADDR   = process.env.CONTRACT_ADDRESS    ?? "";
const UPGRADE_ADDR    = process.env.UPGRADE_NFT_ADDRESS ?? "";

const NFT_ABI = [
  "function balanceOf(address owner) external view returns (uint256)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function totalSupply() external view returns (uint256)",
];

function getProvider() {
  if (!RPC_URL) throw new Error("ETH_RPC_URL is required — set it in .env (no testnet fallback on any network)");
  return new ethers.JsonRpcProvider(RPC_URL);
}

/**
 * Scan ownerOf(1..totalSupply) to find all token IDs owned by addr.
 * Handles tokens beyond totalSupply (ERC721A burn counter discrepancy)
 * by checking up to totalSupply + extra buffer.
 */
async function getOwnedTokenIds(addr: string, contractAddress: string): Promise<number[]> {
  if (!contractAddress) return [];
  const provider = getProvider();
  const nft = new ethers.Contract(contractAddress, NFT_ABI, provider);

  const [balance, supply] = await Promise.all([
    nft.balanceOf(addr).catch(() => 0n),
    nft.totalSupply().catch(() => 0n),
  ]);

  if (Number(balance) === 0) return [];

  // Scan up to supply + 20 buffer (burned tokens reduce supply but IDs still exist)
  const scanLimit = Number(supply) + 20;
  const checks = Array.from({ length: scanLimit }, (_, i) =>
    nft.ownerOf(i + 1)
      .then((owner: string) => owner.toLowerCase() === addr.toLowerCase() ? i + 1 : null)
      .catch(() => null)
  );
  const results = await Promise.all(checks);
  return results.filter((id): id is number => id !== null);
}

/**
 * GET /api/nfts/owned?address=0x...&collection=genesis|upgrade
 *
 * Returns token IDs currently owned by the given wallet address.
 * Reads directly from the blockchain for accuracy — no DB dependency.
 */
router.get("/owned", async (req, res, next) => {
  const { address, collection = "genesis" } = req.query;

  if (!address || !ETH_ADDR.test(address as string)) {
    res.status(400).json({ detail: "Invalid or missing address parameter" });
    return;
  }

  const addr = (address as string).toLowerCase();

  try {
    let tokenIds: number[] = [];

    if ((collection as string) === "upgrade") {
      tokenIds = await getOwnedTokenIds(addr, UPGRADE_ADDR);
    } else {
      tokenIds = await getOwnedTokenIds(addr, CONTRACT_ADDR);
    }

    res.json({ tokenIds, collection: collection as string });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/nft-chain/emergency-transfer
 * Force-transfer a specific NFT token. Requires EMERGENCY_ROLE on the contract.
 * Signs via server FIXED_PRIVATE_KEY — no browser wallet needed.
 */
router.post("/emergency-transfer", requireAdmin, async (req, res, next) => {
  const { tokenId, from, to, reason } = req.body as {
    tokenId?: unknown; from?: unknown; to?: unknown; reason?: unknown;
  };
  if (typeof tokenId !== "number" || tokenId < 1) {
    res.status(400).json({ error: "tokenId must be a positive integer" });
    return;
  }
  if (!from || !ETH_ADDR.test(String(from))) {
    res.status(400).json({ error: "from must be a valid 0x address" });
    return;
  }
  if (!to || !ETH_ADDR.test(String(to))) {
    res.status(400).json({ error: "to must be a valid 0x address" });
    return;
  }
  if (!reason || !String(reason).trim()) {
    res.status(400).json({ error: "reason is required" });
    return;
  }
  try {
    const receipt = await contractEmergencyTransfer(
      tokenId,
      String(from).toLowerCase(),
      String(to).toLowerCase(),
      String(reason).trim()
    );
    res.json({ txHash: receipt.hash, blockNumber: receipt.blockNumber });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/nft-chain/metadata/:tokenId
 * Read tokenURI directly from the live contract, then fetch the IPFS JSON.
 * Use to detect DB ↔ chain desync without a browser wallet.
 */
router.get("/metadata/:tokenId", requireAdmin, async (req, res, next) => {
  const tokenId = Number(req.params.tokenId);
  if (!Number.isInteger(tokenId) || tokenId < 1) {
    res.status(400).json({ error: "tokenId must be a positive integer" });
    return;
  }
  try {
    const contract = getContractReadOnly();
    let uri: string;
    try {
      uri = await (contract.tokenURI(BigInt(tokenId)) as Promise<string>);
    } catch {
      res.status(404).json({ error: `Token ${tokenId} does not exist or tokenURI reverted` });
      return;
    }
    const gatewayUrl = uri.startsWith("ipfs://")
      ? `https://ipfs.io/ipfs/${uri.slice(7)}`
      : uri;
    let metadata: unknown = null;
    try {
      const ipfsRes = await fetch(gatewayUrl, { signal: AbortSignal.timeout(10_000) });
      if (ipfsRes.ok) metadata = await ipfsRes.json();
    } catch { /* metadata stays null — URI exists but IPFS unavailable */ }
    res.json({ tokenId, uri, gatewayUrl, metadata });
  } catch (e) {
    next(e);
  }
});

export default router;
