import { Router } from "express";
import pool from "../../pool";
import { ethers } from "ethers";
import { requirePermission } from "../../adminAuth";

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
    const { rows } = await pool.query(
      "SELECT * FROM membership_tiers WHERE collection_id = $1 ORDER BY sort_order, tier_level",
      [collectionId],
    );
    res.json({ tiers: rows });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const b = req.body as Record<string, unknown>;
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    if (!b.name) return res.status(422).json({ error: "name required" });
    const { rows } = await pool.query(
      `INSERT INTO membership_tiers
         (collection_id, name, tier_level, qualifying_wave_number, qualifying_rarity_tier, min_tokens_held, discount_pct, benefits, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        collectionId, b.name, b.tier_level ?? 1, b.qualifying_wave_number ?? null, b.qualifying_rarity_tier ?? null,
        b.min_tokens_held ?? 1, b.discount_pct ?? 0, b.benefits ? JSON.stringify(b.benefits) : null, b.sort_order ?? 0,
      ]
    );
    res.json({ ok: true, tier: rows[0] });
  } catch (err) { next(err); }
});

router.put("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const b = req.body as Record<string, unknown>;
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { rows } = await pool.query(
      `UPDATE membership_tiers SET
         name = COALESCE($3, name),
         tier_level = COALESCE($4, tier_level),
         qualifying_wave_number = $5,
         qualifying_rarity_tier = $6,
         min_tokens_held = COALESCE($7, min_tokens_held),
         discount_pct = COALESCE($8, discount_pct),
         benefits = COALESCE($9, benefits),
         sort_order = COALESCE($10, sort_order),
         updated_at = NOW()
       WHERE id = $1 AND collection_id = $2 RETURNING *`,
      [
        req.params.id, collectionId, b.name ?? null, b.tier_level ?? null, b.qualifying_wave_number ?? null,
        b.qualifying_rarity_tier ?? null, b.min_tokens_held ?? null, b.discount_pct ?? null,
        b.benefits ? JSON.stringify(b.benefits) : null, b.sort_order ?? null,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: "Tier not found" });
    res.json({ ok: true, tier: rows[0] });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    await pool.query(
      "UPDATE membership_tiers SET is_active = false, updated_at = NOW() WHERE id = $1 AND collection_id = $2",
      [req.params.id, collectionId],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/verify", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const wallet = String(req.query.wallet ?? "").toLowerCase();
    if (!wallet || !ethers.isAddress(wallet)) return res.status(422).json({ error: "Valid wallet required" });

    const { rows: heldRows } = await pool.query(
      `SELECT COUNT(*) AS tokens_held,
              array_agg(DISTINCT on_chain_wave_num) FILTER (WHERE on_chain_wave_num IS NOT NULL) AS waves,
              array_agg(DISTINCT rarity_tier) FILTER (WHERE rarity_tier IS NOT NULL) AS rarities
         FROM nft_records
        WHERE owner_address = $1 AND collection_id = $2 AND is_burned = false AND token_id IS NOT NULL`,
      [wallet, collectionId]
    );
    const held = heldRows[0];
    const tokensHeld = Number(held?.tokens_held ?? 0);
    const waves: number[] = held?.waves ?? [];
    const rarities: string[] = held?.rarities ?? [];

    const { rows: tierRows } = await pool.query(
      `SELECT * FROM membership_tiers
        WHERE collection_id = $4
          AND is_active = true
          AND min_tokens_held <= $1
          AND (qualifying_wave_number IS NULL OR qualifying_wave_number = ANY($2::int[]))
          AND (qualifying_rarity_tier IS NULL OR qualifying_rarity_tier = ANY($3::text[]))
        ORDER BY tier_level DESC
        LIMIT 1`,
      [tokensHeld, waves, rarities, collectionId]
    );
    const tier = tierRows[0];

    res.json({
      membership: {
        tier_name: tier?.name ?? null,
        tier_level: tier?.tier_level ?? null,
        discount_pct: tier?.discount_pct ?? 0,
        tokens_held: tokensHeld,
        benefits: tier?.benefits ?? null,
      },
    });
  } catch (err) { next(err); }
});

export default router;
