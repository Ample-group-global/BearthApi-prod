import { Router } from "express";
import { requireAdmin } from "../adminAuth";
import pool from "../pool";

const router = Router();

// GET /api/master — reference/lookup data for the NFT List page's filter
// dropdowns (stage, type, delivery status). Backed by lookup_values, the
// same generic reference table nfts.ts already reads for delivery_status
// — nothing here is a new data source, just exposing what already exists.
router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query<{ id: string; category: string; code: string; label: string }>(
      `SELECT id, category, code, label FROM lookup_values
       WHERE category IN ('nft_stage', 'nft_type', 'delivery_status') AND is_active = true
       ORDER BY category, sort_order, label`,
    );
    const byCategory = (category: string) =>
      rows.filter(r => r.category === category).map(r => ({ id: r.id, code: r.code, name: r.label }));
    res.json({
      nftStages: byCategory("nft_stage"),
      nftTypes: byCategory("nft_type"),
      deliveryStatuses: byCategory("delivery_status"),
    });
  } catch (e) { next(e); }
});

export default router;
