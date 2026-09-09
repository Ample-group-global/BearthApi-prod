import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import pool from "../pool";
import { requirePermission } from "../adminAuth";
import { HttpError } from "../errors";
import { contractBlockAccount } from "../services/contract.service";
import { autoRegisterAndSync } from "../services/customer-whitelist.service";
import { keepAlive } from "../utils/taskProgress";

const router = Router();

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const connectLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
const readLimit = rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: "draft-7", legacyHeaders: false });
const writeLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });

// ── POST /api/wallets/connect ─────────────────────────────────────────────────
// Public — no auth. Called immediately when a customer connects their wallet
// on Bearth-FE (src/lib/wallet-register.ts). Registers the wallet if first
// time; always returns current block/allowlist status.
router.post("/connect", connectLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = (req.body ?? {}) as { address?: string };
    if (!address || !ETH_ADDRESS_RE.test(address)) {
      res.status(422).json({ error: "Invalid Ethereum address" });
      return;
    }
    const { rows } = await pool.query("SELECT * FROM wallet_connect($1)", [address]);
    const row = rows[0];
    if (!row) {
      res.status(500).json({ error: "Failed to register wallet" });
      return;
    }
    // Auto-register: new wallets get a stub customer user created and Merkle root rebuilt.
    // keepAlive() (Vercel's waitUntil) covers the WHOLE call, not just the
    // on-chain push inside it -- the DB insert this kicks off is also
    // unawaited here, so without it Vercel could tear the function down
    // before even that completes, not just before the chain push finishes.
    if (row.registered || !row.is_whitelisted) {
      keepAlive(autoRegisterAndSync(address, "wallet_connect").catch(() => null));
    }
    res.json({
      address: row.address as string,
      isBlocked: row.is_blocked as boolean,
      blockedReason: row.blocked_reason as string | null,
      isAllowlisted: row.is_whitelisted as boolean,
      registeredNow: row.registered as boolean,
      addedAt: (row.added_at as Date)?.toISOString() ?? null,
    });
  } catch (e) { next(e); }
});

// ── GET /api/wallets ──────────────────────────────────────────────────────────
// Admin: paginated wallet list. Pass ?blocked=true to show blocked wallets only.
router.get("/", readLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "customers.view");
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const offset = Number(req.query.offset ?? 0);
    const blockedOnly = req.query.blocked === "true";
    const { rows } = await pool.query(
      "SELECT * FROM wallets_list($1, $2, $3)",
      [limit, offset, blockedOnly]
    );
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    res.json({
      wallets: rows.map(r => ({
        id: r.id,
        address: r.address,
        userId: r.user_id ?? null,
        isAllowlisted: r.is_whitelisted,
        isBlocked: r.is_blocked,
        blockedReason: r.blocked_reason ?? null,
        blockedAt: r.blocked_at ? (r.blocked_at as Date).toISOString() : null,
        addedAt: r.added_at ? (r.added_at as Date).toISOString() : null,
      })),
      total, limit, offset,
      hasMore: offset + limit < total,
    });
  } catch (e) { next(e); }
});

// ── GET /api/wallets/:address ─────────────────────────────────────────────────
router.get("/:address", readLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "customers.view");
    const { address } = req.params;
    if (!ETH_ADDRESS_RE.test(address)) {
      res.status(422).json({ error: "Invalid Ethereum address" });
      return;
    }
    const { rows } = await pool.query("SELECT * FROM wallet_get($1)", [address]);
    if (!rows[0]) throw new HttpError(404, "Wallet not found");
    const r = rows[0];
    res.json({
      id: r.id,
      address: r.address,
      userId: r.user_id ?? null,
      isAllowlisted: r.is_whitelisted,
      isBlocked: r.is_blocked,
      blockedReason: r.blocked_reason ?? null,
      blockedAt: r.blocked_at ? (r.blocked_at as Date).toISOString() : null,
      addedAt: r.added_at ? (r.added_at as Date).toISOString() : null,
    });
  } catch (e) { next(e); }
});

// ── POST /api/wallets/:address/block ──────────────────────────────────────────
router.post("/:address/block", writeLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "customers.edit");
    const { address } = req.params;
    if (!ETH_ADDRESS_RE.test(address)) {
      res.status(422).json({ error: "Invalid Ethereum address" });
      return;
    }
    const { reason, onChain = true } = (req.body ?? {}) as { reason?: string; onChain?: boolean };

    const client = await pool.connect();
    let dbRow: Record<string, unknown>;
    try {
      await client.query("BEGIN");
      await client.query("SELECT wallet_connect($1)", [address]);
      const { rows } = await client.query("SELECT * FROM wallet_block($1, $2)", [address, reason ?? null]);
      await client.query("COMMIT");
      dbRow = rows[0];
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    let txHash: string | null = null;
    if (onChain) {
      try {
        const receipt = await contractBlockAccount(address, true);
        txHash = receipt.hash;
      } catch (chainErr) {
        res.status(207).json({
          ok: true,
          dbBlocked: true,
          onChainBlocked: false,
          onChainError: chainErr instanceof Error ? chainErr.message : "On-chain block failed",
          address: dbRow.address,
          isBlocked: dbRow.is_blocked,
          blockedReason: dbRow.blocked_reason ?? null,
          blockedAt: dbRow.blocked_at ? (dbRow.blocked_at as Date).toISOString() : null,
        });
        return;
      }
    }

    res.json({
      ok: true,
      dbBlocked: true,
      onChainBlocked: onChain,
      txHash,
      address: dbRow.address,
      isBlocked: dbRow.is_blocked,
      blockedReason: dbRow.blocked_reason ?? null,
      blockedAt: dbRow.blocked_at ? (dbRow.blocked_at as Date).toISOString() : null,
    });
  } catch (e) { next(e); }
});

// ── DELETE /api/wallets/:address/block ────────────────────────────────────────
router.delete("/:address/block", writeLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "customers.edit");
    const { address } = req.params;
    if (!ETH_ADDRESS_RE.test(address)) {
      res.status(422).json({ error: "Invalid Ethereum address" });
      return;
    }
    const { onChain = true } = (req.body ?? {}) as { onChain?: boolean };

    const { rows } = await pool.query("SELECT * FROM wallet_unblock($1)", [address]);
    if (!rows[0]) throw new HttpError(404, "Wallet not found");

    let txHash: string | null = null;
    if (onChain) {
      try {
        const receipt = await contractBlockAccount(address, false);
        txHash = receipt.hash;
      } catch (chainErr) {
        res.status(207).json({
          ok: true,
          dbUnblocked: true,
          onChainUnblocked: false,
          onChainError: chainErr instanceof Error ? chainErr.message : "On-chain unblock failed",
          address: rows[0].address,
          isBlocked: rows[0].is_blocked,
        });
        return;
      }
    }

    res.json({ ok: true, dbUnblocked: true, onChainUnblocked: onChain, txHash, address: rows[0].address, isBlocked: rows[0].is_blocked });
  } catch (e) { next(e); }
});

export default router;
