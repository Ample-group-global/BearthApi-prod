import { Router } from "express";
import { requirePermission } from "../../adminAuth";
import * as svc from "../../services/nft-gen.service";
import { syncGeneratedItemsToNftRecords, syncFromFilebaseBucket } from "../../services/nft-gen.service";
import pool from "../../pool";

const router = Router();
router.post("/sync-from-filebase", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    // No hardcoded bucket fallback here on purpose — this route deletes and
    // rebuilds the entire nft_records table from whatever bucket it's given,
    // so silently guessing the wrong one is exactly how a real incident
    // happened before (an unrelated bucket's data got wiped). The caller
    // must say which bucket explicitly, every time.
    const bucket = (req.body?.bucket as string) || "";
    if (!bucket.trim()) { res.status(422).json({ error: "bucket is required." }); return; }
    await pool.query("DELETE FROM nft_records");
    const result = await syncFromFilebaseBucket(bucket);
    res.json({ bucket, ...result });
  } catch (e) {
    next(e);
  }
});

router.post("/sync-all-records", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const synced = await syncGeneratedItemsToNftRecords();
    res.json({ synced });
  } catch (e) {
    next(e);
  }
});
router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const collectionId = req.query.collectionId as string;
    const status = req.query.status as string | undefined;
    if (!collectionId) { res.status(422).json({ error: "collectionId is required." }); return; }
    const params: any[] = [collectionId];
    let where = "collection_id = $1::uuid";
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT id, collection_id, edition_size, status, created_at, completed_at, export_bucket
       FROM nft_generation_jobs WHERE ${where} ORDER BY created_at DESC LIMIT 10`,
      params,
    );
    res.json({ jobs: rows });
  } catch (e) { next(e); }
});

router.get("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const data = await svc.getJob(req.params.id);
    if (!data) { res.status(404).json({ error: "Job not found." }); return; }
    res.json(data);
  } catch (e) { next(e); }
});

router.post("/:id/start", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const result = await svc.startJob(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

router.patch("/:id/progress", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const { progress } = req.body ?? {};
    if (progress === undefined || Number(progress) < 0 || Number(progress) > 100) {
      res.status(422).json({ error: "progress must be between 0 and 100." }); return;
    }
    const result = await svc.updateJobProgress(req.params.id, Number(progress));
    res.json(result);
  } catch (e) { next(e); }
});

router.post("/:id/complete", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const result = await svc.completeJob(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

router.post("/:id/fail", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const { errorMessage } = req.body ?? {};
    if (!errorMessage) { res.status(422).json({ error: "errorMessage is required." }); return; }
    const result = await svc.failJob(req.params.id, errorMessage);
    res.json(result);
  } catch (e) { next(e); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const result = await svc.deleteFailedJob(req.params.id);
    if (!result) { res.status(404).json({ error: "Job not found or not in failed state." }); return; }
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

// ── Items under job ───────────────────────────────────────────────────────────

router.get("/:id/items", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const result = await svc.listItems({
      jobId: req.params.id,
      limit: Number(req.query.limit ?? 50),
      offset: Number(req.query.offset ?? 0),
    });
    res.json(result);
  } catch (e) { next(e); }
});
router.get("/:id/display-items", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    // Safety ceiling only (guards against an accidental/malicious huge
    // LIMIT), not a collection-size cap — real projects can exceed 10K.
    const limit = Math.min(Number(req.query.limit ?? 50), 50000);
    const offset = Number(req.query.offset ?? 0);
    const { rows } = await pool.query(`
      SELECT
        gi.edition_number,
        (gi.metadata_json->>'score')::numeric    AS rarity_score,
        (gi.metadata_json->>'rank')::int         AS rarity_rank,
        gi.metadata_json->>'tier'                AS rarity_tier,
        json_agg(json_build_object(
          'traitType',  nit.trait_type,
          'traitValue', nit.trait_value,
          'traitId',    nit.trait_id
        ) ORDER BY nit.trait_type)               AS traits
      FROM nft_generated_items gi
      JOIN nft_item_traits nit ON nit.item_id = gi.id
      WHERE gi.job_id = $1::uuid
      GROUP BY gi.id, gi.edition_number, gi.metadata_json
      ORDER BY gi.edition_number ASC
      LIMIT $2 OFFSET $3
    `, [req.params.id, limit, offset]);

    res.json({
      items: rows.map(r => ({
        editionNumber: Number(r.edition_number),
        rarityScore: r.rarity_score != null ? Number(r.rarity_score) : 0,
        rarityRank: r.rarity_rank != null ? Number(r.rarity_rank) : Number(r.edition_number),
        rarityTier: r.rarity_tier ?? "Common",
        traits: r.traits ?? [],
      })),
    });
  } catch (e) { next(e); }
});

router.get("/:id/rarity", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const data = await svc.getRarityReport(req.params.id);
    res.json(data ?? { totalEditions: 0, traits: [] });
  } catch (e) { next(e); }
});

router.post("/:id/items/batch", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(422).json({ error: "items must be a non-empty array." }); return;
    }
    if (items.length > 1000) {
      res.status(422).json({ error: "Max 1000 items per batch." }); return;
    }
    const inserted = await svc.insertItemsBatch({ jobId: req.params.id, items });
    res.json({ inserted: inserted.length, items: inserted });
  } catch (e) { next(e); }
});

router.post("/:id/items/batch-ipfs", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(422).json({ error: "items must be a non-empty array." }); return;
    }
    if (items.length > 1000) {
      res.status(422).json({ error: "Max 1000 items per batch." }); return;
    }
    const updated = await svc.batchUpdateItemIpfsCids({ jobId: req.params.id, items });
    res.json({ updated });
  } catch (e) { next(e); }
});

// POST /api/nft-gen/jobs/:id/sync-records — sync IPFS-ready items to nft_records
router.post("/:id/sync-records", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const synced = await syncGeneratedItemsToNftRecords(req.params.id);
    res.json({ synced });
  } catch (e) { next(e); }
});

// ── Upload batches under job ──────────────────────────────────────────────────

router.post("/:id/upload-batches", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { provider, batchType, totalItems } = req.body ?? {};
    if (!provider) { res.status(422).json({ error: "provider is required." }); return; }
    if (!batchType) { res.status(422).json({ error: "batchType is required." }); return; }
    if (!totalItems || Number(totalItems) <= 0) {
      res.status(422).json({ error: "totalItems must be greater than 0." }); return;
    }
    const batch = await svc.createUploadBatch({
      jobId: req.params.id, provider, batchType, totalItems: Number(totalItems),
    });
    res.status(201).json({ batch });
  } catch (e) { next(e); }
});

export default router;
