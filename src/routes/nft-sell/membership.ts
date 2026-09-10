import { Router } from "express";
import pool from "../../pool";
import { ethers } from "ethers";
import { requirePermission } from "../../adminAuth";

const router = Router();

// GET /api/nft-sell/membership — all tiers (active + inactive, page shows both)
router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const { rows } = await pool.query("SELECT * FROM membership_tiers ORDER BY sort_order, tier_level");
    res.json({ tiers: rows });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const b = req.body as Record<string, unknown>;
    if (!b.name) return res.status(422).json({ error: "name required" });
    const { rows } = await pool.query(
      `INSERT INTO membership_tiers
         (name, tier_level, qualifying_wave_number, qualifying_rarity_tier, min_tokens_held, discount_pct, benefits, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        b.name, b.tier_level ?? 1, b.qualifying_wave_number ?? null, b.qualifying_rarity_tier ?? null,
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
    const { rows } = await pool.query(
      `UPDATE membership_tiers SET
         name = COALESCE($2, name),
         tier_level = COALESCE($3, tier_level),
         qualifying_wave_number = $4,
         qualifying_rarity_tier = $5,
         min_tokens_held = COALESCE($6, min_tokens_held),
         discount_pct = COALESCE($7, discount_pct),
         benefits = COALESCE($8, benefits),
         sort_order = COALESCE($9, sort_order),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id, b.name ?? null, b.tier_level ?? null, b.qualifying_wave_number ?? null,
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
    await pool.query("UPDATE membership_tiers SET is_active = false, updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/nft-sell/membership/verify?wallet=0x... — highest matching tier
// for a wallet, based on its held (non-burned) tokens' wave + rarity.
router.get("/verify", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const wallet = String(req.query.wallet ?? "").toLowerCase();
    if (!wallet || !ethers.isAddress(wallet)) return res.status(422).json({ error: "Valid wallet required" });

    const { rows: heldRows } = await pool.query(
      `SELECT COUNT(*) AS tokens_held,
              array_agg(DISTINCT on_chain_wave_num) FILTER (WHERE on_chain_wave_num IS NOT NULL) AS waves,
              array_agg(DISTINCT rarity_tier) FILTER (WHERE rarity_tier IS NOT NULL) AS rarities
         FROM nft_records
        WHERE owner_address = $1 AND is_burned = false AND token_id IS NOT NULL`,
      [wallet]
    );
    const held = heldRows[0];
    const tokensHeld = Number(held?.tokens_held ?? 0);
    const waves: number[] = held?.waves ?? [];
    const rarities: string[] = held?.rarities ?? [];

    const { rows: tierRows } = await pool.query(
      `SELECT * FROM membership_tiers
        WHERE is_active = true
          AND min_tokens_held <= $1
          AND (qualifying_wave_number IS NULL OR qualifying_wave_number = ANY($2::int[]))
          AND (qualifying_rarity_tier IS NULL OR qualifying_rarity_tier = ANY($3::text[]))
        ORDER BY tier_level DESC
        LIMIT 1`,
      [tokensHeld, waves, rarities]
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
