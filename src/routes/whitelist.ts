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
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const testLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false });

function requireCollectionId(req: Request, res: Response): string | null {
  const v = (req.query.collection_id ?? req.body?.collectionId) as string | undefined;
  if (v && UUID_RE.test(v)) return v;
  res.status(400).json({ error: "collection_id is required" });
  return null;
}

async function refreshComputedRootUnlessOverridden(collectionId: string): Promise<void> {
  const { rows } = await pool.query("SELECT manual_override FROM whitelist_state WHERE collection_id = $1", [collectionId]);
  if (rows[0]?.manual_override) return;
  const { rows: addrRows } = await pool.query("SELECT * FROM whitelist_addresses_for_collection($1)", [collectionId]);
  const addresses = addrRows.map((r: { address: string }) => r.address);
  const root = addresses.length ? buildMerkleTree(addresses).root : null;
  await pool.query(
    "UPDATE whitelist_state SET merkle_root = $1, last_updated = NOW() WHERE collection_id = $2",
    [root, collectionId]
  );
}

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.view");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "1000"), 10) || 1000, 1), 5000);
    const { rows } = await pool.query(
      "SELECT wallet_address AS address FROM nft_collection_whitelist WHERE collection_id = $1 ORDER BY added_at LIMIT $2",
      [collectionId, limit]
    );
    const { rows: stateRows } = await pool.query(
      "SELECT merkle_root, manual_override, last_updated FROM whitelist_state WHERE collection_id = $1",
      [collectionId]
    );
    res.json({
      addresses: rows.map((r: { address: string }) => r.address),
      metadata: stateRows[0] ?? null,
    });
  } catch (e) { next(e); }
});

router.post("/entry", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { address } = (req.body ?? {}) as { address?: string };
    if (!address || !ETH_ADDRESS_RE.test(address)) {
      res.status(422).json({ error: "Valid address required" });
      return;
    }
    const lower = address.toLowerCase();
    await pool.query(
      `INSERT INTO nft_collection_whitelist (collection_id, wallet_address, source)
       VALUES ($1, $2, 'admin_manual')
       ON CONFLICT (collection_id, wallet_address) DO NOTHING`,
      [collectionId, lower]
    );
    await refreshComputedRootUnlessOverridden(collectionId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post("/add", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
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
    await pool.query(
      `INSERT INTO nft_collection_whitelist (collection_id, wallet_address, source)
       SELECT $1, unnest($2::text[]), 'admin_manual'
       ON CONFLICT (collection_id, wallet_address) DO NOTHING`,
      [collectionId, lowered]
    );
    await refreshComputedRootUnlessOverridden(collectionId);
    res.json({ ok: true, count: lowered.length });
  } catch (e) { next(e); }
});

router.delete("/merkle-root", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    await pool.query("UPDATE whitelist_state SET manual_override = FALSE WHERE collection_id = $1", [collectionId]);
    await refreshComputedRootUnlessOverridden(collectionId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete("/:address", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const address = req.params.address;
    if (!ETH_ADDRESS_RE.test(address)) {
      res.status(422).json({ error: "Valid address required" });
      return;
    }
    await pool.query(
      "DELETE FROM nft_collection_whitelist WHERE collection_id = $1 AND wallet_address = lower($2)",
      [collectionId, address]
    );
    await refreshComputedRootUnlessOverridden(collectionId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.put("/merkle-root", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { root } = (req.body ?? {}) as { root?: string };
    if (!root || !MERKLE_ROOT_RE.test(root)) {
      res.status(422).json({ error: "root must be a 0x + 64 hex char value" });
      return;
    }
    await pool.query(
      "UPDATE whitelist_state SET merkle_root = $1, manual_override = TRUE, last_updated = NOW() WHERE collection_id = $2",
      [root, collectionId]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get("/export", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.view");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const format = String(req.query.format ?? "csv").toLowerCase();
    const { rows } = await pool.query("SELECT * FROM whitelist_addresses_for_collection($1)", [collectionId]);
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

router.post("/register", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
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
          "UPDATE customer_wallets SET user_id = $1 WHERE lower(address) = $2",
          [userId, lower]
        );
      } else {
        await pool.query(
          "INSERT INTO customer_wallets (address, user_id, source) VALUES ($1, $2, 'admin_register')",
          [lower, userId]
        );
      }
    }

    await pool.query(
      `INSERT INTO nft_collection_whitelist (collection_id, wallet_address, source)
       VALUES ($1, $2, 'admin_register')
       ON CONFLICT (collection_id, wallet_address) DO NOTHING`,
      [collectionId, lower]
    );
    await refreshComputedRootUnlessOverridden(collectionId);
    res.json({ ok: true, isNewUser, roleCode });
  } catch (e) { next(e); }
});

router.post("/push-chain", async (req: Request, res: Response, next: NextFunction) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { root, txHash } = await pushEffectiveRootOnChain(collectionId);
    res.json({ success: true, root, txHash });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ success: false, error: message });
  }
});

router.post("/test", testLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { address } = (req.body ?? {}) as { address?: string };
    if (!address || !ETH_ADDRESS_RE.test(address)) {
      res.status(400).json({ detail: "Invalid address format" });
      return;
    }
    const { rows } = await pool.query("SELECT * FROM whitelist_addresses_for_collection($1)", [collectionId]);
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

router.get("/reconcile", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const expected = process.env.CRON_SECRET;
    const auth = req.headers.authorization;
    if (!expected || auth !== `Bearer ${expected}`) {
      throw new HttpError(401, "Unauthorized");
    }
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const result = await reconcileWhitelistRoot(collectionId);
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
