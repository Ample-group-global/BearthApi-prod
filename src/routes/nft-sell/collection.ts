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
} from "../../services/contract.service";
import { scheduleTreasuryWalletChange, getLatestTimelockOp, executeTimelockOp } from "../../services/timelock.service";

const router = Router();

// GET /api/nft-sell/collection — DB config + live on-chain snapshot for the
// Contract Operations page header + Mint Operations tab.
router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const { rows } = await pool.query("SELECT * FROM nft_collection_config WHERE id = 1");
    const config = rows[0] ?? null;

    const [onChainInfo, revealRows] = await Promise.all([
      contractGetCollectionInfo(),
      pool.query("SELECT COUNT(*) FILTER (WHERE wave_revealed) AS n FROM nft_waves"),
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

// GET /api/nft-sell/collection/events?limit=20 — audit log, read from
// nft_event_log (populated by contract.service.ts's syncReceiptLogs on every
// admin write). Column is created_at, not processed_at -- aliased to match
// the frontend's ContractEvent shape.
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

// PUT /api/nft-sell/collection/sbt — collection-wide SBT toggle
router.put("/sbt", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") return res.status(422).json({ error: "enabled (boolean) required" });
    const receipt = await contractSetSBT(enabled);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

// POST /api/nft-sell/collection/admin-mint — treasury reserve mint (wave 0,
// outside any wave's quota/purchase-limit).
router.post("/admin-mint", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { to, qty } = req.body as { to?: string; qty?: number };
    if (!to) return res.status(422).json({ error: "to (wallet address) required" });
    if (!qty || qty < 1) return res.status(422).json({ error: "qty must be >= 1" });
    const receipt = await contractReserveMint(to, qty, 0);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

// PUT /api/nft-sell/collection/blind-box-uri
router.put("/blind-box-uri", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { uri } = req.body as { uri?: string };
    if (!uri) return res.status(422).json({ error: "uri required" });
    const receipt = await contractSetBlindBoxURI(uri);
    await pool.query("UPDATE nft_collection_config SET blind_box_uri = $1, updated_at = NOW() WHERE id = 1", [uri]);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

// ── Treasury Wallet — gated behind BearthTimelock (48h delay) ────────────────
// PUT /treasury schedules the change; GET /treasury/timelock-status reports
// readiness; POST /treasury/execute finalizes it once ready. A direct,
// single-step "set treasury wallet" call would simply revert on-chain, since
// setTreasuryWallet requires TREASURY_TIMELOCK_ROLE, held only by the Timelock.
router.put("/treasury", async (req, res, next) => {
  try {
    const { userId } = requirePermission(req, "contract_ops.manage");
    const { wallet } = req.body as { wallet?: string };
    if (!wallet) return res.status(422).json({ error: "wallet required" });
    const result = await scheduleTreasuryWalletChange(wallet, userId);
    res.json({ ok: true, scheduled: true, ...result });
  } catch (err) { next(err); }
});

router.get("/treasury/timelock-status", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const status = await getLatestTimelockOp("setTreasuryWallet");
    res.json({ status });
  } catch (err) { next(err); }
});

router.post("/treasury/execute", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { operationId } = req.body as { operationId?: string };
    if (!operationId) return res.status(422).json({ error: "operationId required" });
    const result = await executeTimelockOp(operationId);
    res.json({ ok: true, txHash: result.txHash });
  } catch (err) { next(err); }
});

// POST /api/nft-sell/collection/withdraw — sweep ETH balance to treasury wallet
router.post("/withdraw", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const receipt = await contractWithdraw();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

// POST /api/nft-sell/collection/pause | /unpause
router.post("/pause", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const receipt = await contractPause();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

router.post("/unpause", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const receipt = await contractUnpause();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

// PUT /api/nft-sell/collection/block-account — OPERATOR_ROLE-gated, blocks/
// unblocks a wallet from minting and transfers. Pre-mainnet checklist item #3
// -- contractBlockAccount() already existed in the service layer but had no
// route anywhere until now.
router.put("/block-account", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { wallet, blocked } = req.body as { wallet?: string; blocked?: boolean };
    if (!wallet || !ethers.isAddress(wallet)) return res.status(422).json({ error: "Valid wallet address required" });
    if (typeof blocked !== "boolean") return res.status(422).json({ error: "blocked (boolean) required" });
    const receipt = await contractBlockAccount(wallet, blocked);
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

// blind_box_uri points to a shared metadata JSON (same for every unrevealed
// token in a wave -- verified: {"image": "ipfs://...", "animation_url":
// "ipfs://...video/mp4..."}), not an image/video directly. Resolved once per
// distinct URI and reused across every row that shares it, rather than
// fetching it again per token.
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

// GET /api/nft-sell/collection/tokens?owner=0x...&limit=200 — a wallet's owned
// NFTs. Public, no auth -- called directly by Bearth-FE's Memory Hall gallery
// (src/components/bearth/collection/MemoryHallGallery.tsx / src/lib/memory-hall.ts),
// which has no admin session. Pre-reveal, the real artwork/rarity stay hidden
// (is_revealed/image_ipfs_hash naturally stay null/false until the separate
// reveal step runs -- see nft_record_sync_mint, patch_v15) but token_id and
// the shared blind-box placeholder image/video are always shown -- neither
// leaks anything about a specific token's eventual rarity (token_id is public
// on-chain regardless of what this API returns; the blind-box asset is
// identical across every sealed token in a wave).
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
          // rarity_tier is a static property of the pre-generated art asset a
          // token got FCFS-linked to at mint (see nft_record_sync_mint) -- it
          // must stay hidden pre-reveal or it defeats the point of the blind
          // box (a high-rarity token would be identifiable by tokenId before
          // reveal). Masked here rather than relying on the frontend to hide it.
          rarity_tier: r.is_revealed ? r.rarity_tier : null,
          traits: r.is_revealed ? r.traits : null,
          is_revealed: r.is_revealed,
          // Same masking as rarity_tier -- image_ipfs_hash is the real,
          // generation-time artwork hash for the row this token got linked to;
          // the frontend already gates rendering it behind is_revealed, but
          // that shouldn't be the only thing standing between a blind-box
          // token and its actual artwork.
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
