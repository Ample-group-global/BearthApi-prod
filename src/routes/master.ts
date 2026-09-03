import { Router } from "express";
import { requireAdmin } from "../adminAuth";
import pool from "../pool";
import { getBlindboxImageUrl } from "../services/nft-gen.service";

const router = Router();

// GET /api/master — reference/lookup data for the NFT List page's filter
// dropdowns (stage, type, delivery status). Backed by lookup_values, the
// same generic reference table nfts.ts already reads for delivery_status
// — nothing here is a new data source, just exposing what already exists.
router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const [{ rows }, { rows: collectionRows }, blindBoxImageUrl] = await Promise.all([
      pool.query<{ id: string; category: string; code: string; label: string }>(
        `SELECT id, category, code, label FROM lookup_values
         WHERE category IN ('nft_stage', 'nft_type', 'delivery_status') AND is_active = true
         ORDER BY category, sort_order, label`,
      ),
      // Only collections actually synced into nft_records — a collection
      // that only exists in nft_generation_jobs (never synced) has nothing
      // to show under this filter yet.
      pool.query<{ id: string; name: string }>(
        `SELECT DISTINCT nc.id, nc.name FROM nft_collections nc
         JOIN nft_records nr ON nr.collection_id = nc.id
         ORDER BY nc.name`,
      ),
      getBlindboxImageUrl().catch(() => null),
    ]);
    const byCategory = (category: string) =>
      rows.filter(r => r.category === category).map(r => ({ id: r.id, code: r.code, name: r.label }));
    res.json({
      nftStages: byCategory("nft_stage"),
      nftTypes: byCategory("nft_type"),
      deliveryStatuses: byCategory("delivery_status"),
      collections: collectionRows,
      blindBoxImageUrl,
    });
  } catch (e) { next(e); }
});

export default router;
