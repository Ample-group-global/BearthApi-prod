import path from "path";
import { Router } from "express";
import { requirePermission } from "../../adminAuth";
import pool from "../../pool";
import * as svc from "../../services/nft-gen.service";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const result = await svc.listCollections({
      limit: Number(req.query.limit ?? 50),
      offset: Number(req.query.offset ?? 0),
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    const { userId } = requirePermission(req, "nft_gen.manage_collections");
    const { name } = req.body ?? {};
    if (!name?.trim()) { res.status(422).json({ error: "Collection name is required." }); return; }
    const fw = Number(req.body?.formatWidth), fh = Number(req.body?.formatHeight);
    if (!req.body?.formatWidth || fw < 1) { res.status(422).json({ error: 'formatWidth (image width in px) is required.' }); return; }
    if (!req.body?.formatHeight || fh < 1) { res.status(422).json({ error: 'formatHeight (image height in px) is required.' }); return; }
    const collection = await svc.createCollection({ ...req.body, createdBy: userId });
    res.status(201).json({ collection });
  } catch (e) { next(e); }
});

// ── Sync status across all collections ────────────────────────────────────────
// Must be declared before /:id to prevent Express treating "sync-status" as a UUID.
router.get("/sync-status", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const { rows } = await pool.query(`
      SELECT
        c.id            AS collection_id,
        c.name          AS collection_name,
        c.supply,
        c.created_at,
        j.id            AS job_id,
        j.status        AS job_status,
        COALESCE(fi.synced_count, 0)   AS filebase_count,
        COALESCE(fi.total_count,  0)   AS filebase_total,
        COALESCE(rec.records_count, 0) AS records_count
      FROM nft_collections c
      LEFT JOIN LATERAL (
        SELECT id, status
        FROM nft_generation_jobs
        WHERE collection_id = c.id AND status = 'complete'
        ORDER BY created_at DESC
        LIMIT 1
      ) j ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE ipfs_image_cid IS NOT NULL) AS synced_count,
          COUNT(*)                                            AS total_count
        FROM nft_generated_items
        WHERE job_id = j.id
      ) fi ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS records_count
        FROM nft_records nr
        WHERE nr.serial_number = ANY (
          SELECT '#' || gi.edition_number::text
          FROM nft_generated_items gi
          WHERE gi.job_id = j.id AND gi.ipfs_image_cid IS NOT NULL
        )
        AND nr.image_ipfs_hash IS NOT NULL
      ) rec ON true
      ORDER BY c.created_at DESC
    `);

    const n = (v: unknown) => Number(v ?? 0);
    res.json({
      collections: rows.map((r, i) => {
        const supply = n(r.supply);
        const fbCount = n(r.filebase_count);
        const recCount = n(r.records_count);
        return {
          srNo: i + 1,
          collectionId: r.collection_id,
          collectionName: r.collection_name,
          supply,
          createdAt: r.created_at,
          jobId: r.job_id ?? null,
          jobStatus: r.job_status ?? null,
          filebaseCount: fbCount,
          filebaseTotal: n(r.filebase_total),
          recordsCount: recCount,
          filebaseSynced: supply > 0 && fbCount >= supply,
          recordsSynced: supply > 0 && recCount >= supply,
        };
      }),
    });
  } catch (e) { next(e); }
});

router.get("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const data = await svc.getCollection(req.params.id);
    if (!data) { res.status(404).json({ error: "Collection not found." }); return; }
    res.json(data);
  } catch (e) { next(e); }
});

router.put("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_collections");
    const collection = await svc.updateCollection(req.params.id, req.body ?? {});
    if (!collection) { res.status(404).json({ error: "Collection not found." }); return; }
    res.json({ collection });
  } catch (e) { next(e); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_collections");
    const result = await svc.deleteCollection(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

// ── Layers nested under collection ──────────────────────────────────────────
router.get("/:id/layers-organise", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const { rows: layerRows } = await pool.query(
      "SELECT * FROM nft_gen_layers_list($1::uuid)", [req.params.id]
    );
    const active = layerRows
      .filter((l: any) => l.is_active)
      .sort((a: any, b: any) => a.sort_order - b.sort_order);

    if (!active.length) { res.json({ layers: [] }); return; }

    const layerIds = active.map((l: any) => l.id);
    const { rows: traitRows } = await pool.query(
      "SELECT * FROM nft_traits WHERE layer_id = ANY($1::uuid[]) AND is_active = true ORDER BY created_at ASC",
      [layerIds]
    );

    const layers = active.map((l: any) => {
      const traits = traitRows.filter((t: any) => t.layer_id === l.id);
      return {
        id: l.id,
        folder: l.name,
        label: l.display_name ?? l.name,
        count: traits.length,
        optional: l.layer_rarity_pct != null && Number(l.layer_rarity_pct) < 100,
        bypassDna: l.bypass_dna ?? false,
        rarityPct: Number(l.layer_rarity_pct ?? 100),
        sortOrder: Number(l.sort_order ?? 0),
        assets: traits
          .map((t: any) => ({
            id: t.id,
            stem: t.file_path ? path.basename(t.file_path, path.extname(t.file_path)) : t.id,
            name: t.name,
            rel: t.file_path,
            defaultWeight: Number(t.rarity_weight ?? 1),
            // Pass through as-is — null means "never explicitly classified"
            // and must reach the frontend that way so it falls back to a
            // live weight-based badge instead of a forced, misleading default.
            rarityTier: t.rarity_tier ?? null,
          }))
          .sort((a: any, b: any) =>
            a.stem.localeCompare(b.stem, undefined, { numeric: true, sensitivity: 'base' })
          ),
      };
    });
    res.json({ layers });
  } catch (e) { next(e); }
});

router.get("/:id/layers", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const layers = await svc.listLayers(req.params.id);
    res.json({ layers });
  } catch (e) { next(e); }
});

router.post("/:id/layers", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const { name } = req.body ?? {};
    if (!name?.trim()) { res.status(422).json({ error: "Layer name is required." }); return; }
    const layer = await svc.createLayer({ collectionId: req.params.id, ...req.body });
    res.status(201).json({ layer });
  } catch (e) { next(e); }
});

router.post("/:id/layers/reconcile", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const { activeNames } = req.body ?? {};
    if (!Array.isArray(activeNames)) {
      res.status(422).json({ error: "activeNames must be an array." }); return;
    }
    const result = await svc.reconcileLayers(req.params.id, activeNames);
    res.json(result);
  } catch (e) { next(e); }
});

router.put("/:id/layers/reorder", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(422).json({ error: "items array is required." }); return;
    }
    const result = await svc.reorderLayers(req.params.id, items);
    res.json(result);
  } catch (e) { next(e); }
});

// ── Jobs nested under collection ─────────────────────────────────────────────

router.post("/:id/jobs", async (req, res, next) => {
  try {
    const { userId } = requirePermission(req, "nft_gen.generate");
    const { editionSize } = req.body ?? {};
    if (!editionSize || Number(editionSize) <= 0) {
      res.status(422).json({ error: "editionSize must be greater than 0." }); return;
    }
    const job = await svc.createJob({ collectionId: req.params.id, editionSize: Number(editionSize), createdBy: userId });
    res.status(201).json({ job });
  } catch (e) { next(e); }
});

export default router;
