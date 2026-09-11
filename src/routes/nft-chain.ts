import { Router } from "express";
import { ethers } from "ethers";
import { requireAdmin } from "../adminAuth";
import { contractEmergencyTransfer, getContractReadOnlyForCollection } from "../services/contract.service";

const router = Router();
const ETH_ADDR = /^0x[a-fA-F0-9]{40}$/;
const OWNED_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

async function getOwnedTokenIds(addr: string, collectionId: string): Promise<number[]> {
  const nft = await getContractReadOnlyForCollection(collectionId);

  const [balance, supply] = await Promise.all([
    nft.balanceOf(addr) as Promise<bigint>,
    nft.totalSupply() as Promise<bigint>,
  ]);

  if (Number(balance) === 0) return [];

  const scanLimit = Number(supply) + 20;
  const checks = Array.from({ length: scanLimit }, (_, i) =>
    (nft.ownerOf(i + 1) as Promise<string>)
      .then((owner: string) => owner.toLowerCase() === addr.toLowerCase() ? i + 1 : null)
      .catch(() => null)
  );
  const results = await Promise.all(checks);
  return results.filter((id): id is number => id !== null);
}

router.get("/owned", async (req, res, next) => {
  const { address, collectionId } = req.query;

  if (!address || !ETH_ADDR.test(address as string)) {
    res.status(400).json({ detail: "Invalid or missing address parameter" });
    return;
  }
  if (!collectionId || !OWNED_UUID_RE.test(collectionId as string)) {
    res.status(400).json({ detail: "collectionId is required" });
    return;
  }

  const addr = (address as string).toLowerCase();

  try {
    const tokenIds = await getOwnedTokenIds(addr, collectionId as string);
    res.json({ tokenIds, collectionId });
  } catch (e) {
    next(e);
  }
});

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

router.post("/emergency-transfer", requireAdmin, async (req, res, next) => {
  const { tokenId, from, to, reason, collectionId } = req.body as {
    tokenId?: unknown; from?: unknown; to?: unknown; reason?: unknown; collectionId?: unknown;
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
  if (!collectionId || !UUID_RE.test(String(collectionId))) {
    res.status(400).json({ error: "collectionId is required" });
    return;
  }
  try {
    const receipt = await contractEmergencyTransfer(
      tokenId,
      String(from).toLowerCase(),
      String(to).toLowerCase(),
      String(reason).trim(),
      String(collectionId)
    );
    res.json({ txHash: receipt.hash, blockNumber: receipt.blockNumber });
  } catch (e) {
    next(e);
  }
});

router.get("/metadata/:tokenId", requireAdmin, async (req, res, next) => {
  const tokenId = Number(req.params.tokenId);
  if (!Number.isInteger(tokenId) || tokenId < 1) {
    res.status(400).json({ error: "tokenId must be a positive integer" });
    return;
  }
  const { collectionId } = req.query as { collectionId?: string };
  if (!collectionId || !UUID_RE.test(collectionId)) {
    res.status(400).json({ error: "collectionId is required" });
    return;
  }
  try {
    const contract = await getContractReadOnlyForCollection(collectionId);
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
    } catch { }
    res.json({ tokenId, uri, gatewayUrl, metadata });
  } catch (e) {
    next(e);
  }
});

export default router;
