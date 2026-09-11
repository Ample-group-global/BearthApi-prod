import { Router } from "express";
import pool from "../../pool";
import { requirePermission } from "../../adminAuth";
import { ethers } from "ethers";
import {
  contractGetCollectionInfo,
  contractSetSBT,
  contractReserveMint,
  contractSetBlindBoxURI,
  contractWithdraw,
  contractPause,
  contractUnpause,
  contractBlockAccount,
  contractSetPurchaseLimitConfig,
  contractSetPhase,
} from "../../services/contract.service";
import { scheduleTreasuryWalletChange, getLatestTimelockOp, executeTimelockOp } from "../../services/timelock.service";

const router = Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function requireCollectionId(req: import("express").Request, res: import("express").Response): string | null {
  const v = (req.query.collection_id ?? req.body?.collectionId) as string | undefined;
  if (v && UUID_RE.test(v)) return v;
  res.status(400).json({ error: "collection_id is required" });
  return null;
}

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { rows } = await pool.query("SELECT * FROM nft_collections WHERE id = $1", [collectionId]);
    const config = rows[0] ?? null;

    const [onChainInfo, revealRows] = await Promise.all([
      contractGetCollectionInfo(collectionId),
      pool.query("SELECT COUNT(*) FILTER (WHERE wave_revealed) AS n FROM nft_waves WHERE collection_id = $1", [collectionId]),
    ]);

    const onChain = {
      currentPhase: onChainInfo.currentPhase,
      maxSupply: Number(onChainInfo.maxSupply),
      totalMinted: Number(onChainInfo.totalMinted),
      revealCount: Number(revealRows.rows[0]?.n ?? 0),
      sbt: onChainInfo.sbt,
      royaltyEnforced: config?.royalty_enforced ?? true,
      purchaseLimitEnabled: onChainInfo.purchaseLimitEnabled,
      normalMaxPerWallet: Number(onChainInfo.normalMaxPerWallet),
    };

    res.json({ config, onChain });
  } catch (err) { next(err); }
});

router.get("/events", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 200);
    const { rows } = await pool.query(
      `SELECT id, event_name, tx_hash, block_number, created_at AS processed_at
         FROM nft_event_log
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ events: rows });
  } catch (err) { next(err); }
});

router.put("/sbt", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") return res.status(422).json({ error: "enabled (boolean) required" });
    const receipt = await contractSetSBT(enabled, collectionId);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

router.put("/purchase-limit", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { enabled, normalMaxPerWallet } = req.body as { enabled?: boolean; normalMaxPerWallet?: number };
    if (typeof enabled !== "boolean") return res.status(422).json({ error: "enabled (boolean) required" });
    if (!Number.isInteger(normalMaxPerWallet) || normalMaxPerWallet! < 1) {
      return res.status(422).json({ error: "normalMaxPerWallet must be a whole number >= 1" });
    }
    const receipt = await contractSetPurchaseLimitConfig(enabled, normalMaxPerWallet!, collectionId);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

router.put("/phase", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { phase } = req.body as { phase?: number };
    if (phase !== 0 && phase !== 1 && phase !== 2) {
      return res.status(422).json({ error: "phase must be 0 (Whitelist), 1 (PaidMint), or 2 (Revealed)" });
    }
    const receipt = await contractSetPhase(phase, collectionId);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

router.post("/admin-mint", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { to, qty } = req.body as { to?: string; qty?: number };
    if (!to) return res.status(422).json({ error: "to (wallet address) required" });
    if (!qty || qty < 1) return res.status(422).json({ error: "qty must be >= 1" });
    const receipt = await contractReserveMint(to, qty, 0, collectionId);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

router.put("/blind-box-uri", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { uri } = req.body as { uri?: string };
    if (!uri) return res.status(422).json({ error: "uri required" });
    const receipt = await contractSetBlindBoxURI(uri, collectionId);
    await pool.query("UPDATE nft_collections SET blind_box_uri = $1, updated_at = NOW() WHERE id = $2", [uri, collectionId]);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

router.put("/treasury", async (req, res, next) => {
  try {
    const { userId } = requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { wallet } = req.body as { wallet?: string };
    if (!wallet) return res.status(422).json({ error: "wallet required" });
    const result = await scheduleTreasuryWalletChange(wallet, userId, collectionId);
    res.json({ ok: true, scheduled: true, ...result });
  } catch (err) { next(err); }
});

router.get("/treasury/timelock-status", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const status = await getLatestTimelockOp("setTreasuryWallet", collectionId);
    res.json({ status });
  } catch (err) { next(err); }
});

router.post("/treasury/execute", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { operationId } = req.body as { operationId?: string };
    if (!operationId) return res.status(422).json({ error: "operationId required" });
    const result = await executeTimelockOp(operationId, collectionId);
    res.json({ ok: true, txHash: result.txHash });
  } catch (err) { next(err); }
});

router.post("/withdraw", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const receipt = await contractWithdraw(collectionId);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

router.post("/pause", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const receipt = await contractPause(collectionId);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

router.post("/unpause", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const receipt = await contractUnpause(collectionId);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

router.put("/block-account", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { wallet, blocked } = req.body as { wallet?: string; blocked?: boolean };
    if (!wallet || !ethers.isAddress(wallet)) return res.status(422).json({ error: "Valid wallet address required" });
    if (typeof blocked !== "boolean") return res.status(422).json({ error: "blocked (boolean) required" });
    const receipt = await contractBlockAccount(wallet, blocked, collectionId);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

const FILEBASE_GATEWAY = "https://amgbearth.myfilebase.com/ipfs";

function toGatewayUrl(uri: string | null | undefined): string | null {
  if (!uri) return null;
  return uri.startsWith("ipfs://") ? `${FILEBASE_GATEWAY}/${uri.slice(7)}` : uri;
}

interface BlindBoxAssets {
  imageUrl: string | null;
  videoUrl: string | null;
}

async function resolveBlindBoxAssets(
  blindBoxUri: string,
): Promise<BlindBoxAssets> {
  try {
    const res = await fetch(toGatewayUrl(blindBoxUri)!);
    if (!res.ok) return { imageUrl: null, videoUrl: null };
    const meta = (await res.json()) as { image?: string; animation_url?: string };
    return {
      imageUrl: toGatewayUrl(meta.image),
      videoUrl: toGatewayUrl(meta.animation_url),
    };
  } catch {
    return { imageUrl: null, videoUrl: null };
  }
}

router.get("/tokens", async (req, res, next) => {
  try {
    const owner = String(req.query.owner ?? "").toLowerCase();
    if (!owner) return res.status(400).json({ error: "owner query param required" });

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1), 500);

    const { rows } = await pool.query(
      `SELECT token_id, owner_address, on_chain_wave_num, rarity_tier, traits,
              is_revealed, image_ipfs_hash, blind_box_uri, minted_at
         FROM nft_records
        WHERE owner_address = $1 AND token_id IS NOT NULL
        ORDER BY token_id ASC
        LIMIT $2`,
      [owner, limit],
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM nft_records WHERE owner_address = $1 AND token_id IS NOT NULL`,
      [owner],
    );

    const distinctBlindBoxUris = [
      ...new Set(
        rows
          .filter((r) => !r.is_revealed && r.blind_box_uri)
          .map((r) => r.blind_box_uri as string),
      ),
    ];
    const blindBoxAssets = new Map<string, BlindBoxAssets>(
      await Promise.all(
        distinctBlindBoxUris.map(
          async (uri) => [uri, await resolveBlindBoxAssets(uri)] as const,
        ),
      ),
    );

    res.json({
      total: Number(countRows[0]?.total ?? 0),
      tokens: rows.map((r) => {
        const blindBox = !r.is_revealed && r.blind_box_uri
          ? blindBoxAssets.get(r.blind_box_uri as string)
          : undefined;
        return {
          token_id: Number(r.token_id),
          owner_address: r.owner_address,
          wave_number: r.on_chain_wave_num,
          rarity_tier: r.is_revealed ? r.rarity_tier : null,
          traits: r.is_revealed ? r.traits : null,
          is_revealed: r.is_revealed,
          image_ipfs_hash: r.is_revealed ? r.image_ipfs_hash : null,
          blind_box_image_url: blindBox?.imageUrl ?? null,
          blind_box_video_url: blindBox?.videoUrl ?? null,
          minted_at: r.minted_at,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
