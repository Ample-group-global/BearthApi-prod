import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import pool from "../pool";
import { buildMerkleTree, getProof } from "../merkle";
import { reconcileWhitelistRoot, pushEffectiveRootOnChain } from "../services/customer-whitelist.service";
import { requirePermission } from "../adminAuth";
import { HttpError } from "../errors";

const router = Router();

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MERKLE_ROOT_RE = /^0x[a-fA-F0-9]{64}$/;

const testLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false });

// Recomputes and stores merkle_root from the live address list -- but only
// when no manual override is in effect (an admin's explicit PUT /merkle-root
// must not be silently overwritten by the next add/remove). DB-only, no
// on-chain push -- that stays a separate explicit action (POST /push-chain),
// matching the Whitelist tab's own "Add" vs "Push to Chain" separation.
async function refreshComputedRootUnlessOverridden(): Promise<void> {
  const { rows } = await pool.query("SELECT manual_override FROM whitelist_state WHERE id = 1");
  if (rows[0]?.manual_override) return;
  const { rows: addrRows } = await pool.query("SELECT * FROM whitelist_addresses_all()");
  const addresses = addrRows.map((r: { address: string }) => r.address);
  const root = addresses.length ? buildMerkleTree(addresses).root : null;
  await pool.query(
    "UPDATE whitelist_state SET merkle_root = $1, last_updated = NOW() WHERE id = 1",
    [root]
  );
}

// ── GET /api/whitelist?limit=1000 ───────────────────────────────────────────
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.view");
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "1000"), 10) || 1000, 1), 5000);
    const { rows } = await pool.query(
      "SELECT address FROM customer_wallets WHERE is_whitelisted = TRUE ORDER BY added_at LIMIT $1",
      [limit]
    );
    const { rows: stateRows } = await pool.query(
      "SELECT merkle_root, manual_override, last_updated FROM whitelist_state WHERE id = 1"
    );
    res.json({
      addresses: rows.map((r: { address: string }) => r.address),
      metadata: stateRows[0] ?? null,
    });
  } catch (e) { next(e); }
});

// ── POST /api/whitelist/entry — add one address ─────────────────────────────
router.post("/entry", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { address } = (req.body ?? {}) as { address?: string };
    if (!address || !ETH_ADDRESS_RE.test(address)) {
      res.status(422).json({ error: "Valid address required" });
      return;
    }
    // customer_wallets has no unique constraint on address (confirmed against
    // live schema -- only a PK on id), so this is an explicit check-then-
    // write, matching the same pattern already used by wallet_connect() and
    // customer_wallets_add() elsewhere in this schema, not an ON CONFLICT upsert.
    const lower = address.toLowerCase();
    const { rowCount } = await pool.query(
      "UPDATE customer_wallets SET is_whitelisted = TRUE WHERE lower(address) = $1",
      [lower]
    );
    if (!rowCount) {
      await pool.query(
        "INSERT INTO customer_wallets (address, is_whitelisted, source) VALUES ($1, TRUE, 'admin_manual')",
        [lower]
      );
    }
    await refreshComputedRootUnlessOverridden();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── POST /api/whitelist/add — bulk add ───────────────────────────────────────
router.post("/add", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { addresses } = (req.body ?? {}) as { addresses?: string[] };
    if (!Array.isArray(addresses) || !addresses.length) {
      res.status(422).json({ error: "addresses (non-empty array) required" });
      return;
    }
    const invalid = addresses.filter(a => !ETH_ADDRESS_RE.test(a));
    if (invalid.length) {
      res.status(422).json({ error: `${invalid.length} invalid address(es)` });
      return;
    }
    const lowered = addresses.map(a => a.toLowerCase());
    // Same no-unique-constraint reasoning as /entry above: mark existing rows
    // whitelisted, then insert only the addresses that didn't already exist.
    const { rows: existing } = await pool.query(
      `UPDATE customer_wallets SET is_whitelisted = TRUE
       WHERE lower(address) = ANY($1::text[])
       RETURNING lower(address) AS address`,
      [lowered]
    );
    const existingSet = new Set(existing.map((r: { address: string }) => r.address));
    const toInsert = lowered.filter(a => !existingSet.has(a));
    if (toInsert.length) {
      await pool.query(
        `INSERT INTO customer_wallets (address, is_whitelisted, source)
         SELECT unnest($1::text[]), TRUE, 'admin_manual'`,
        [toInsert]
      );
    }
    await refreshComputedRootUnlessOverridden();
    res.json({ ok: true, count: lowered.length });
  } catch (e) { next(e); }
});

// ── DELETE /api/whitelist/merkle-root — clear manual override ───────────────
// Registered BEFORE the "/:address" DELETE route below -- Express would
// otherwise match this literal path as address="merkle-root".
router.delete("/merkle-root", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    await pool.query("UPDATE whitelist_state SET manual_override = FALSE WHERE id = 1");
    await refreshComputedRootUnlessOverridden();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── DELETE /api/whitelist/:address — remove one address ─────────────────────
router.delete("/:address", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const address = req.params.address;
    if (!ETH_ADDRESS_RE.test(address)) {
      res.status(422).json({ error: "Valid address required" });
      return;
    }
    await pool.query(
      "UPDATE customer_wallets SET is_whitelisted = FALSE WHERE lower(address) = lower($1)",
      [address]
    );
    await refreshComputedRootUnlessOverridden();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── PUT /api/whitelist/merkle-root — set manual override root ───────────────
router.put("/merkle-root", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { root } = (req.body ?? {}) as { root?: string };
    if (!root || !MERKLE_ROOT_RE.test(root)) {
      res.status(422).json({ error: "root must be a 0x + 64 hex char value" });
      return;
    }
    await pool.query(
      "UPDATE whitelist_state SET merkle_root = $1, manual_override = TRUE, last_updated = NOW() WHERE id = 1",
      [root]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── GET /api/whitelist/export?format=csv|json|txt ───────────────────────────
router.get("/export", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.view");
    const format = String(req.query.format ?? "csv").toLowerCase();
    const { rows } = await pool.query("SELECT * FROM whitelist_addresses_all()");
    const addresses = rows.map((r: { address: string }) => r.address);

    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.send(JSON.stringify(addresses, null, 2));
    } else if (format === "txt") {
      res.setHeader("Content-Type", "text/plain");
      res.send(addresses.join("\n"));
    } else {
      res.setHeader("Content-Type", "text/csv");
      res.send("address\n" + addresses.join("\n"));
    }
  } catch (e) { next(e); }
});

// ── POST /api/whitelist/register — register a wallet + identity, then whitelist it ──
// Judgment call: role_code isn't restricted to "customer" -- the Whitelist tab
// lets an admin pick any role (e.g. ext_referrer), so this mirrors
// customer_wallet_auto_register()'s user-creation shape (same seq_user_cu
// code sequence/prefix, same users/customer_wallets link) but parameterized
// by role and populated with the real name/email supplied, instead of always
// stubbing "Customer"/"".
router.post("/register", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { address, role_code, first_name, last_name, email } = (req.body ?? {}) as {
      address?: string; role_code?: string; first_name?: string; last_name?: string; email?: string;
    };
    if (!address || !ETH_ADDRESS_RE.test(address)) {
      res.status(422).json({ error: "Valid address required" });
      return;
    }
    if (!first_name?.trim()) {
      res.status(422).json({ error: "first_name required" });
      return;
    }
    const roleCode = role_code || "customer";
    const { rows: roleRows } = await pool.query("SELECT id, code FROM roles WHERE code = $1", [roleCode]);
    if (!roleRows[0]) {
      res.status(422).json({ error: `Unknown role_code "${roleCode}"` });
      return;
    }
    const roleId = roleRows[0].id;
    const lower = address.toLowerCase();

    const { rows: existingRows } = await pool.query(
      "SELECT user_id FROM customer_wallets WHERE lower(address) = $1",
      [lower]
    );
    const existingUserId: string | null = existingRows[0]?.user_id ?? null;

    let userId: string;
    let isNewUser: boolean;
    if (existingUserId) {
      userId = existingUserId;
      isNewUser = false;
      await pool.query(
        "UPDATE customer_wallets SET is_whitelisted = TRUE WHERE lower(address) = $1",
        [lower]
      );
    } else {
      isNewUser = true;
      const { rows: newUserRows } = await pool.query(
        `INSERT INTO users (user_code, first_name, last_name, email, role_id)
         VALUES ('CU' || LPAD(nextval('seq_user_cu')::TEXT, 3, '0'), $1, $2, $3, $4)
         RETURNING id`,
        [first_name.trim(), last_name?.trim() || "", email?.trim() || null, roleId]
      );
      userId = newUserRows[0].id;
      if (existingRows.length) {
        await pool.query(
          "UPDATE customer_wallets SET user_id = $1, is_whitelisted = TRUE WHERE lower(address) = $2",
          [userId, lower]
        );
      } else {
        await pool.query(
          "INSERT INTO customer_wallets (address, user_id, is_whitelisted, source) VALUES ($1, $2, TRUE, 'admin_register')",
          [lower, userId]
        );
      }
    }

    await refreshComputedRootUnlessOverridden();
    res.json({ ok: true, isNewUser, roleCode });
  } catch (e) { next(e); }
});

// ── POST /api/whitelist/push-chain — push the effective root on-chain ───────
router.post("/push-chain", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { root, txHash } = await pushEffectiveRootOnChain();
    res.json({ success: true, root, txHash });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ success: false, error: message });
  }
});

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
