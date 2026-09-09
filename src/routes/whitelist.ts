import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import pool from "../pool";
import { buildMerkleTree, getProof } from "../merkle";
import { reconcileWhitelistRoot } from "../services/customer-whitelist.service";
import { HttpError } from "../errors";

const router = Router();

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const testLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false });

// ── POST /api/whitelist/test ──────────────────────────────────────────────────
// Public — no auth. Called by Bearth-FE (src/lib/whitelist-proof.ts) before every
// whitelistMint()/waveMint() to get the Merkle proof the contract needs. Response
// shape (proof/root/is_whitelisted, snake_case) is fixed by that existing client.
router.post("/test", testLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = (req.body ?? {}) as { address?: string };
    if (!address || !ETH_ADDRESS_RE.test(address)) {
      res.status(400).json({ detail: "Invalid address format" });
      return;
    }
    const { rows } = await pool.query("SELECT * FROM whitelist_addresses_all()");
    const addresses = rows.map((r: { address: string }) => r.address);
    if (!addresses.length) {
      res.json({ is_whitelisted: false, address, proof: [], root: "0x0", leaf_index: null, generated_at: new Date().toISOString() });
      return;
    }
    const tree = buildMerkleTree(addresses);
    const lower = address.toLowerCase();
    const leafIndex = addresses.map((a: string) => a.toLowerCase()).indexOf(lower);
    const isWhitelisted = leafIndex !== -1;
    const proof = isWhitelisted ? getProof(tree, address) : [];
    res.json({
      is_whitelisted: isWhitelisted,
      address,
      proof,
      root: tree.root,
      leaf_index: isWhitelisted ? leafIndex : null,
      generated_at: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

// ── GET /api/whitelist/reconcile ──────────────────────────────────────────────
// Self-healing check: compares the DB's intended Merkle root against the
// last-confirmed on-chain root and re-pushes if they've drifted (see
// customer-whitelist.service.ts's reconcileWhitelistRoot for why this exists
// -- the 2026-09-09 incident where every whitelist mint silently reverted).
// Intended to be hit by a scheduled job (vercel.json cron), not end users --
// it can trigger a real on-chain transaction, so it's gated on CRON_SECRET.
// GET, not POST: Vercel Cron Jobs always invoke via GET, so a POST-only
// route here would just 404 against the scheduler. Vercel automatically
// sends `Authorization: Bearer ${CRON_SECRET}` to cron-invoked routes when
// that env var is set: https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
router.get("/reconcile", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const expected = process.env.CRON_SECRET;
    const auth = req.headers.authorization;
    if (!expected || auth !== `Bearer ${expected}`) {
      throw new HttpError(401, "Unauthorized");
    }
    const result = await reconcileWhitelistRoot();
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
