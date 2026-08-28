import multer from "multer";
import { Router } from "express";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { requirePermission } from "../../adminAuth";
import * as svc from "../../services/nft-gen.service";
import { getS3Client } from "../../clients/s3";
import { deleteObjectsChunked } from "../../utils/deleteObjects";
import pool from "../../pool";

// Deletes only the stale objects left over from a previous import of this
// same layer — i.e. keys under `${layer}/` that aren't in the set we just
// uploaded. Scoped to one layer and run only after its new files are
// confirmed uploaded, so a failed/partial upload never empties anything.
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
// "Start a new collection" calls this to clean up an abandoned, not-yet-saved
// upload attempt. bearth-layers holds EVERY artist's/collection's layers side
// by side (each upload gets its own random session-prefix folder so real
// uploads never collide on filenames) -- but this route used to delete the
// ENTIRE bucket with no scoping at all, so any artist resetting their own
// working session silently destroyed every other artist's layer files,
// including already-fully-generated collections'. Now requires the caller's
// own session prefix and only ever touches objects under it.
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

// ── GET /collections/:id/prefixes — distinct upload-session prefixes this ────
// collection's traits currently reference. Used by the Settings-tab re-upload
// flow to know what to clean up afterward -- see /cleanup-orphaned-prefix.
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
// only if no trait row anywhere in the DB still references it. A layer
// re-upload mints a brand new random prefix every time (by design, so two
// artists' concurrent uploads never collide) -- but nothing used to clean up
// the PREVIOUS prefix once its traits were repointed at the new one, so
// bearth-layers accumulated an orphaned ~40MB+ folder on every single
// re-upload of the same collection (confirmed live: 5 abandoned prefixes,
// ~250MB, from repeated re-uploads during one test session). Self-verifying
// by design -- never deletes a prefix still in active use, so it's safe to
// call speculatively after every sync.
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

    // Same prefix also appears under _thumbs/{size}/{prefix}/... — clean
    // those up too so the cache doesn't keep dead entries forever.
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
// exist in bearth-layers? Session prefixes are minted as `${symbol}-${random}`
// (see CollectionSetup.tsx), so any object under `${symbol}-` means someone
// already uploaded layers for this symbol. Lets the UI block a second upload
// before it starts, instead of silently accumulating duplicate layer sets.
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
    // Every upload attempt carries its own unique namespace (minted client-side
    // per drop) so this collection's/run's assets can never collide with, or be
    // silently overwritten by, another collection's identically-named layer
    // folder in the shared bucket — the root cause of a real incident where a
    // generated NFT composited in a completely unrelated stale image because
    // two uploads had written to the exact same flat key. Falls back to the
    // legacy flat layout only for older callers that don't send one yet.
    const rawPrefix = (req.body?.sessionPrefix ?? "") as string;
    const safePrefix = rawPrefix.trim().replace(/[^a-zA-Z0-9\-_]/g, "");
    const keyPrefix = safePrefix ? `${safePrefix}/` : "";
    const added: string[] = [];
    const s3Uploaded: string[] = [];
    const s3Failures: string[] = [];
    // Client sorts files by filename before chunking, so this loop already
    // dispatches them in that order -- a small concurrency window here is a
    // speed/determinism tradeoff, not a correctness one, since /upload/finalize
    // verifies every expected key actually landed in the bucket afterward
    // regardless of which order the concurrent PUTs actually completed in.
    // Fully serial (1) measured too slow on this machine's current bandwidth;
    // 12 (the old default) is what caused tonight's connection-timeout
    // saturation under sustained load -- 4 is a deliberate middle ground.
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
// A layer's files can arrive across several /upload calls (the client chunks
// large layers to stay under typical serverless request-body limits), so
// cleanup can no longer safely run inside /upload itself — it would delete
// files a later chunk hasn't uploaded yet. The client already knows every
// key a layer is SUPPOSED to have (computed once, deterministically, during
// its own file parse) and calls this once, after every chunk for that layer
// has confirmed success, passing that complete set as `keptKeys`.
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

    // Verify against the real bucket, not just the client's own upload
    // responses — a PUT can report success without the object actually
    // persisting (a real prior incident: two full layers had zero objects
    // in the bucket with no error surfaced anywhere).
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
      // null/undefined means "not classified" and must stay that way — forcing
      // it to "common" here defeated the nullable rarity_tier migration for
      // the exact flow (Excel sync) it was meant to fix.
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
