import multer from "multer";
import { Router } from "express";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { requirePermission } from "../../adminAuth";
import * as svc from "../../services/nft-gen.service";
import { getS3Client } from "../../clients/s3";
import { deleteObjectsChunked } from "../../utils/deleteObjects";
import pool from "../../pool";

async function cleanupStaleLayerFiles(bucket: string, layer: string, keptKeys: Set<string>): Promise<void> {
  const s3 = getS3Client();
  const prefix = `${layer}/`;
  let continuationToken: string | undefined;
  const stale: string[] = [];
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: continuationToken,
    }));
    for (const obj of list.Contents ?? []) {
      if (obj.Key && !keptKeys.has(obj.Key)) stale.push(obj.Key);
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  if (stale.length) await deleteObjectsChunked(s3, bucket, stale);
}

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
router.post("/clear-bucket", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const rawPrefix = (req.body?.prefix ?? "") as string;
    const safePrefix = rawPrefix.trim().replace(/[^a-zA-Z0-9\-_]/g, "");
    if (!safePrefix) { res.status(422).json({ error: "prefix is required." }); return; }

    const bucket = process.env.FILEBASE_LAYERS_BUCKET || "bearth-layers";
    const s3 = getS3Client();
    let deleted = 0;
    let continuationToken: string | undefined;
    const prefix = `${safePrefix}/`;

    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }));

      const keys = (list.Contents ?? []).map(o => o.Key!).filter(Boolean);
      if (keys.length) deleted += await deleteObjectsChunked(s3, bucket, keys);

      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);

    res.json({ ok: true, bucket, prefix, deleted });
  } catch (e) { next(e); }
});

router.get("/collections/:id/prefixes", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const { rows } = await pool.query(
      `SELECT DISTINCT split_part(nt.file_path, '/', 1) AS prefix
       FROM nft_traits nt JOIN nft_layers nl ON nl.id = nt.layer_id
       WHERE nl.collection_id = $1::uuid AND nt.file_path IS NOT NULL`,
      [req.params.id],
    );
    res.json({ prefixes: rows.map(r => r.prefix).filter(Boolean) });
  } catch (e) { next(e); }
});

// ── POST /cleanup-orphaned-prefix — delete a session-prefix folder, but ──────
router.post("/cleanup-orphaned-prefix", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const rawPrefix = (req.body?.prefix ?? "") as string;
    const safePrefix = rawPrefix.trim().replace(/[^a-zA-Z0-9\-_]/g, "");
    if (!safePrefix) { res.status(422).json({ error: "prefix is required." }); return; }

    const { rows } = await pool.query(
      `SELECT 1 FROM nft_traits WHERE file_path LIKE $1 LIMIT 1`,
      [`${safePrefix}/%`],
    );
    if (rows.length) { res.json({ ok: true, deleted: 0, reason: "still referenced" }); return; }

    const bucket = process.env.FILEBASE_LAYERS_BUCKET || "bearth-layers";
    const s3 = getS3Client();
    let deleted = 0;
    let continuationToken: string | undefined;
    const prefix = `${safePrefix}/`;
    do {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: continuationToken }));
      const keys = (list.Contents ?? []).map(o => o.Key!).filter(Boolean);
      if (keys.length) deleted += await deleteObjectsChunked(s3, bucket, keys);
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);

    let thumbDeleted = 0;
    const thumbList = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "_thumbs/", MaxKeys: 1000 }));
    const thumbKeys = (thumbList.Contents ?? [])
      .map(o => o.Key!).filter(Boolean)
      .filter(k => k.split("/")[2] === safePrefix);
    if (thumbKeys.length) thumbDeleted = await deleteObjectsChunked(s3, bucket, thumbKeys);

    res.json({ ok: true, bucket, prefix, deleted, thumbDeleted });
  } catch (e) { next(e); }
});

// ── GET /symbol-check — does a layer upload for this Token Symbol already ───
router.get("/symbol-check", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const rawSymbol = (req.query?.symbol ?? "") as string;
    const safeSymbol = rawSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!safeSymbol) { res.status(422).json({ error: "symbol is required." }); return; }

    const bucket = process.env.FILEBASE_LAYERS_BUCKET || "bearth-layers";
    const s3 = getS3Client();
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: `${safeSymbol}-`, Delimiter: "/", MaxKeys: 1,
    }));
    const existingPrefix = list.CommonPrefixes?.[0]?.Prefix?.replace(/\/$/, "") ?? null;
    res.json({ exists: !!existingPrefix, prefix: existingPrefix });
  } catch (e) { next(e); }
});

// ── POST /upload — receive layer PNGs from BearthAdmin, save to Filebase S3 ──
router.post("/upload", upload.array("files"), async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");

    const layer = (req.body?.layer ?? "") as string;
    const subpaths = ([] as string[]).concat(req.body?.subpaths ?? []);
    const files = (req.files ?? []) as Express.Multer.File[];
    const safe = layer.trim().replace(/[^a-zA-Z0-9\-_ ]/g, "");
    if (!safe) { res.status(400).json({ error: "layer name required" }); return; }
    const rawPrefix = (req.body?.sessionPrefix ?? "") as string;
    const safePrefix = rawPrefix.trim().replace(/[^a-zA-Z0-9\-_]/g, "");
    const keyPrefix = safePrefix ? `${safePrefix}/` : "";
    const added: string[] = [];
    const s3Uploaded: string[] = [];
    const s3Failures: string[] = [];
    const S3_CONCURRENCY = 4;
    for (let i = 0; i < files.length; i += S3_CONCURRENCY) {
      await Promise.all(files.slice(i, i + S3_CONCURRENCY).map(async (file, j) => {
        const idx = i + j;
        const sub = (subpaths[idx] ?? "").replace(/\.\./g, "").replace(/^\//, "");
        const base = file.originalname.split(/[\\/]/).pop() ?? file.originalname;
        const safeName = base.replace(/[^a-zA-Z0-9.\-_]/g, "_");
        if (!safeName.match(/\.(png|webp|jpg|jpeg|gif)$/i)) return;
        const rel = `${keyPrefix}${safe}/${sub || safeName}`;
        try {
          await svc.uploadLayerImageWithThumb(rel, file.buffer);
          s3Uploaded.push(rel);
          added.push(rel);
        } catch {
          s3Failures.push(rel);
        }
      }));
    }

    res.json({ ok: true, added, s3Uploaded, s3Failures });
  } catch (e) { next(e); }
});

// ── POST /upload/finalize — clean up a layer's stale leftovers ──────────────
router.post("/upload/finalize", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const layer = (req.body?.layer ?? "") as string;
    const safe = layer.trim().replace(/[^a-zA-Z0-9\-_ ]/g, "");
    if (!safe) { res.status(400).json({ error: "layer name required" }); return; }
    const rawPrefix = (req.body?.sessionPrefix ?? "") as string;
    const safePrefix = rawPrefix.trim().replace(/[^a-zA-Z0-9\-_]/g, "");
    const keyPrefix = safePrefix ? `${safePrefix}/` : "";
    const keptKeys = (req.body?.keptKeys ?? []) as string[];
    if (!Array.isArray(keptKeys) || !keptKeys.length) { res.status(422).json({ error: "keptKeys must be a non-empty array." }); return; }
    const bucket = process.env.FILEBASE_LAYERS_BUCKET || "bearth-layers";
    const layerPath = `${keyPrefix}${safe}`;
    await cleanupStaleLayerFiles(bucket, layerPath, new Set(keptKeys));
    const s3 = getS3Client();
    const found = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: `${layerPath}/`, MaxKeys: 1000, ContinuationToken: continuationToken,
      }));
      for (const obj of list.Contents ?? []) if (obj.Key) found.add(obj.Key);
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);
    const missing = keptKeys.filter(k => !found.has(k));

    res.json({ ok: missing.length === 0, expectedCount: keptKeys.length, foundCount: found.size, missing });
  } catch (e) { next(e); }
});

router.get("/image", async (req, res, next) => {
  try {
    const rel = req.query.rel as string | undefined;
    if (!rel || rel.includes("..") || rel.startsWith("/")) {
      res.status(400).json({ error: "Invalid rel path." });
      return;
    }
    const buf = req.query.full
      ? await svc.fetchLayerImage(rel)
      : await svc.fetchLayerThumb(rel);
    if (!buf) { res.status(404).json({ error: "Image not found." }); return; }
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (e) { next(e); }
});

router.get("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const data = await svc.getLayer(req.params.id);
    if (!data) { res.status(404).json({ error: "Layer not found." }); return; }
    res.json(data);
  } catch (e) { next(e); }
});

router.put("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const layer = await svc.updateLayer(req.params.id, req.body ?? {});
    if (!layer) { res.status(404).json({ error: "Layer not found." }); return; }
    res.json({ layer });
  } catch (e) { next(e); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const result = await svc.deleteLayer(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

// ── Traits nested under layer ────────────────────────────────────────────────

router.get("/:id/traits", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const traits = await svc.listTraits(req.params.id);
    res.json({ traits });
  } catch (e) { next(e); }
});

router.post("/:id/traits/reconcile", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const { activeFilePaths } = req.body ?? {};
    if (!Array.isArray(activeFilePaths)) {
      res.status(422).json({ error: "activeFilePaths must be an array." }); return;
    }
    const result = await svc.reconcileTraits(req.params.id, activeFilePaths);
    res.json(result);
  } catch (e) { next(e); }
});

router.post("/:id/traits/bulk", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const { traits } = req.body ?? {};
    if (!Array.isArray(traits) || !traits.length) {
      res.status(422).json({ error: "traits must be a non-empty array." }); return;
    }
    const VALID_TIERS = ["legendary", "epic", "rare", "common"];
    for (const t of traits) {
      if (!t?.name?.trim()) { res.status(422).json({ error: "Every trait needs a name." }); return; }
      if (!t?.filePath?.trim()) { res.status(422).json({ error: "Every trait needs a filePath." }); return; }
      if (t.rarityTier == null) continue;
      const tier = String(t.rarityTier).toLowerCase();
      if (!VALID_TIERS.includes(tier)) {
        res.status(422).json({ error: "rarityTier must be one of: legendary, epic, rare, common." }); return;
      }
      t.rarityTier = tier;
    }
    const created = await svc.createTraitsBulk(req.params.id, traits);
    res.status(201).json({ traits: created, count: created.length });
  } catch (e) { next(e); }
});

router.post("/:id/traits/apply-names", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const { names } = req.body ?? {};
    if (!Array.isArray(names) || !names.length || names.some((n: unknown) => typeof n !== "string" || !n.trim())) {
      res.status(422).json({ error: "names must be a non-empty array of non-empty strings." }); return;
    }
    const result = await svc.applyTraitNamesFromExcel(req.params.id, names);
    res.json(result);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Trait count mismatch")) {
      res.status(409).json({ error: e.message }); return;
    }
    next(e);
  }
});

router.post("/:id/traits", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const { name, filePath } = req.body ?? {};
    if (!name?.trim()) { res.status(422).json({ error: "Trait name is required." }); return; }
    if (filePath !== null && !filePath?.trim()) { res.status(422).json({ error: "File path is required." }); return; }
    const VALID_TIERS = ["legendary", "epic", "rare", "common"];
    let tier: string | undefined;
    if (req.body.rarityTier != null) {
      tier = String(req.body.rarityTier).toLowerCase();
      if (!VALID_TIERS.includes(tier)) {
        res.status(422).json({ error: "rarityTier must be one of: legendary, epic, rare, common." }); return;
      }
    }
    const trait = await svc.createTrait({ layerId: req.params.id, ...req.body, rarityTier: tier });
    res.status(201).json({ trait });
  } catch (e) { next(e); }
});

export default router;
