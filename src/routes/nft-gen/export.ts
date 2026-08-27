import { Router } from "express";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import os from "os";
import sharp from "sharp";
import { requirePermission } from "../../adminAuth";
import pool from "../../pool";
import { getS3Client } from "../../clients/s3";
import { syncGeneratedItemsToNftRecords } from "../../services/nft-gen.service";
import { ZipStream } from "../../utils/zipStream";
import {
  hasLayerSource, makeLayerFetcher, fetchEditionRows, applyNameFormat, streamToBuffer,
} from "./export-helpers";
import {
  exportMeta, refreshCidMeta, previewMeta, zipRegistry,
} from "./export-state";
import { runExport, runPreview, runRefreshCids } from "./export-workers";
import { saveTask, getTask, keepAlive } from "../../utils/taskProgress";

const router = Router();
async function safeZipFilename(jobId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT c.name FROM nft_generation_jobs j
     JOIN nft_collections c ON c.id = j.collection_id
     WHERE j.id = $1::uuid`,
    [jobId],
  );
  const collectionName = rows[0]?.name ?? "";
  return (collectionName || "bearth-nft-collection").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
}

// ── POST / — start server-side export ────────────────────────────────────────

router.post("/", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");

    const {
      jobId, bucket,
      format = "png", width: bodyWidth, height: bodyHeight,
      collectionName = "", description = "", nameFormat = "",
      syncToRecords = true,
      resumeFrom = 0,
    } = req.body ?? {};

    if (!jobId) { res.status(422).json({ error: "jobId is required." }); return; }
    if (!bucket) { res.status(422).json({ error: "bucket is required." }); return; }
    if (exportMeta.running) {
      // A "running" flag can outlive the process that set it — a serverless
      // invocation killed by the platform's execution-time limit never runs
      // its own cleanup, so this would otherwise stay stuck forever and
      // block every export, for any collection, until the instance happens
      // to recycle. Treat it as abandoned once it's gone quiet longer than
      // any real progress tick should take (worker updates every batch —
      // 90s of silence is well past that even for a slow batch).
      const STALE_MS = 90_000;
      const runningEntry = [...exportMeta.jobs.entries()].find(([, j]) => j.status === 'running');
      const isStale = !runningEntry || (Date.now() - runningEntry[1].lastUpdatedAt) > STALE_MS;
      if (isStale) {
        exportMeta.running = false;
      } else {
        // Include the running job's own id/progress so the caller can show
        // live progress instead of a dead-end "please wait" message — the
        // artist has no way to gauge how much longer to wait otherwise.
        const [runningExportId, runningJob] = runningEntry;
        res.status(409).json({
          error: "An export is already running. Wait for it to complete before starting a new one.",
          exportId: runningExportId,
          progress: runningJob.progress,
          total: runningJob.total,
          phase: runningJob.phase,
        });
        return;
      }
    }

    // width/height are optional — most callers (e.g. Collection Sync Status)
    // never had a reason to know them, since the collection already stores
    // its own export resolution. Fall back to that single source of truth
    // instead of requiring every caller to duplicate it.
    let width = bodyWidth;
    let height = bodyHeight;
    if (!width || !height) {
      const { rows: dimRows } = await pool.query(
        `SELECT c.format_width, c.format_height FROM nft_generation_jobs j
         JOIN nft_collections c ON c.id = j.collection_id
         WHERE j.id = $1::uuid`,
        [jobId],
      );
      width = width || dimRows[0]?.format_width;
      height = height || dimRows[0]?.format_height;
    }
    if (!width || Number(width) < 1) { res.status(422).json({ error: "width is required and must be >= 1 px." }); return; }
    if (!height || Number(height) < 1) { res.status(422).json({ error: "height is required and must be >= 1 px." }); return; }

    if (!hasLayerSource()) {
      res.status(500).json({ error: "No layer source configured. Set LAYERS_BUCKET (Filebase bucket name)." });
      return;
    }

    const { rows: jobRows } = await pool.query(
      "SELECT id FROM nft_generation_jobs WHERE id = $1::uuid",
      [jobId],
    );
    if (!jobRows.length) { res.status(404).json({ error: "Job not found." }); return; }

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) AS cnt FROM nft_generated_items WHERE job_id = $1::uuid",
      [jobId],
    );
    const total = Number(countRows[0]?.cnt ?? 0);
    if (total === 0) { res.status(422).json({ error: "No generated items for this job. Generate NFTs first." }); return; }

    const startFrom = Math.max(0, Math.min(Number(resumeFrom) || 0, total));
    const exportId = randomUUID();
    exportMeta.jobs.set(exportId, { status: "running", progress: startFrom, total, phase: startFrom > 0 ? `Resuming from ${startFrom}…` : "Starting…", lastUpdatedAt: Date.now() });

    exportMeta.running = true;
    const exportJob = runExport(exportId, jobId, {
      bucket,
      format: String(format),
      width: Number(width),
      height: Number(height),
      total,
      collectionName: String(collectionName),
      description: String(description),
      nameFormat: String(nameFormat),
      syncToRecords: syncToRecords !== false,
      resumeFrom: startFrom,
    }).catch(async err => {
      const s = exportMeta.jobs.get(exportId);
      const msg = String(err?.message ?? err);
      if (s) { s.status = "error"; s.error = msg; }
      await saveTask(exportId, 'export', { status: 'error', phase: s?.phase ?? 'Failed', progress: s?.progress ?? startFrom, total, error: msg, meta: { jobId } });
    }).finally(() => {
      exportMeta.running = false;
    });
    keepAlive(exportJob);
    await saveTask(exportId, 'export', { status: 'running', phase: startFrom > 0 ? `Resuming from ${startFrom}…` : 'Starting…', progress: startFrom, total, meta: { jobId } });

    res.status(202).json({ exportId, total });
  } catch (e) { next(e); }
});

// ── POST /preview — start server-side image validation/preview ────────────────

router.post("/preview", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const { jobId, width = 512, height = 512 } = req.body ?? {};
    if (!jobId) { res.status(422).json({ error: "jobId is required." }); return; }

    if (!hasLayerSource()) {
      res.status(500).json({ error: "No layer source configured. Set LAYERS_BUCKET (Filebase bucket name)." });
      return;
    }

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) AS cnt FROM nft_generated_items WHERE job_id = $1::uuid",
      [jobId],
    );
    const total = Number(countRows[0]?.cnt ?? 0);
    if (total === 0) { res.status(422).json({ error: "No generated items for this job." }); return; }

    const previewId = randomUUID();

    // Thumbnails are a scratch cache, not layer source data — always OS temp dir.
    const previewDir = path.join(os.tmpdir(), "bearth-previews", previewId);
    fs.mkdirSync(previewDir, { recursive: true });

    previewMeta.jobs.set(previewId, {
      status: "running", progress: 0, total,
      phase: "Starting…", validCount: 0, invalidItems: [], dir: previewDir,
    });

    runPreview(previewId, jobId, { width: Number(width), height: Number(height), total, previewDir })
      .catch(err => {
        const s = previewMeta.jobs.get(previewId);
        if (s) { s.status = "error"; s.error = String(err?.message ?? err); }
      });

    res.status(202).json({ previewId, total });
  } catch (e) { next(e); }
});

// ── GET /preview/:previewId — poll preview status ─────────────────────────────

router.get("/preview/:previewId", (req, res) => {
  const state = previewMeta.jobs.get(req.params.previewId);
  if (!state) { res.status(404).json({ error: "Preview job not found." }); return; }
  const { dir, ...rest } = state;
  res.json(rest);
});

// ── GET /preview/:previewId/img/:edition — serve a thumbnail PNG ──────────────

router.get("/preview/:previewId/img/:edition", (req, res) => {
  const state = previewMeta.jobs.get(req.params.previewId);
  if (!state) { res.status(404).json({ error: "Preview job not found." }); return; }
  const edition = parseInt(req.params.edition, 10);
  if (isNaN(edition) || edition < 1) { res.status(400).json({ error: "Invalid edition." }); return; }
  const imgPath = path.join(state.dir, `${edition}.png`);
  if (!fs.existsSync(imgPath)) { res.status(404).json({ error: "Thumbnail not ready." }); return; }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  fs.createReadStream(imgPath).pipe(res);
});
const DOWNLOAD_BATCH = 50;
const DOWNLOAD_CONCURRENCY = 20;
router.get("/download-zip/:jobId", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    req.socket?.setTimeout(0);
    const { jobId } = req.params;
    const ext = (req.query.format as string) === "webp" ? "webp" : "png";
    const width = Math.max(1, Number(req.query.width) || 512);
    const height = Math.max(1, Number(req.query.height) || 512);
    const collectionName = String(req.query.collectionName ?? "");
    const description = String(req.query.description ?? "");
    const nameFormat = String(req.query.nameFormat ?? "");
    const bucket = String(req.query.bucket ?? "").trim();

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) AS cnt FROM nft_generated_items WHERE job_id = $1::uuid",
      [jobId],
    );
    const total = Number(countRows[0]?.cnt ?? 0);
    if (total === 0) { res.status(422).json({ error: "No generated items for this job." }); return; }

    const safeName = (collectionName || "bearth-nft-collection").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);

    const zip = new ZipStream(res);

    // Fast path: this job was already exported to Filebase — every image
    // and metadata file is already sitting there, fully composited. Read
    // them directly (2 GetObjects/edition) instead of recompositing from
    // raw layers (~8 layer-source fetches + a Sharp composite per edition,
    // work this job already paid for once during the real export).
    if (bucket) {
      console.log(`[download-zip] job ${jobId}: ${total} NFTs — fast path from bucket "${bucket}"`);
      const s3 = getS3Client();
      try {
        // Sum real object sizes via ListObjectsV2 (cheap — a handful of
        // paginated calls for ~20000 objects) so the client can show a real
        // "X of Y" progress bar instead of just "X received…". Exposed as a
        // custom header, not Content-Length — the actual ZIP stream is a
        // few bytes larger per entry (local file headers, central
        // directory), and Content-Length must match the real byte count
        // exactly or the browser treats the download as truncated.
        let estimatedBytes = 0;
        for (const prefix of ["images/", "metadata/"]) {
          let token: string | undefined;
          do {
            const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
            for (const obj of resp.Contents ?? []) estimatedBytes += obj.Size ?? 0;
            token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
          } while (token);
        }
        if (estimatedBytes > 0) res.setHeader("X-Estimated-Zip-Bytes", String(estimatedBytes));

        let cursor = 1;
        let cursorEnd = 0;
        // Bounded to cursorEnd (the current batch's end), not total — a
        // worker checking `cursor <= total` would keep pulling forward
        // through the ENTIRE 9999-item collection on the very first batch
        // iteration, so nothing ever reached zip.addFile() until virtually
        // everything had already been fetched (the "0 B received" bug).
        async function worker() {
          const out: Array<{ n: number; imgBuf: Buffer; metaBuf: Buffer }> = [];
          while (cursor <= cursorEnd) {
            const n = cursor++;
            const [imgRes, metaRes] = await Promise.all([
              s3.send(new GetObjectCommand({ Bucket: bucket, Key: `images/${n}.${ext}` })),
              s3.send(new GetObjectCommand({ Bucket: bucket, Key: `metadata/${n}.json` })),
            ]);
            const [imgBuf, metaBuf] = await Promise.all([
              streamToBuffer(imgRes.Body),
              streamToBuffer(metaRes.Body),
            ]);
            out.push({ n, imgBuf, metaBuf });
          }
          return out;
        }
        for (let offset = 0; offset < total; offset += DOWNLOAD_BATCH) {
          const batchEnd = Math.min(offset + DOWNLOAD_BATCH, total);
          cursor = offset + 1;
          cursorEnd = batchEnd;
          const batchTotal = batchEnd - offset;
          const results = (await Promise.all(
            Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, batchTotal) }, worker),
          )).flat().sort((a, b) => a.n - b.n);
          for (const r of results) {
            await zip.addFile(`images/${r.n}.${ext}`, r.imgBuf);
            await zip.addFile(`metadata/${r.n}.json`, r.metaBuf);
          }
        }
        await zip.finish();
      } catch (streamErr) {
        console.error(`[download-zip] fast path failed mid-stream for job ${jobId}:`, streamErr);
        res.destroy(streamErr instanceof Error ? streamErr : new Error(String(streamErr)));
      }
      return;
    }

    if (!hasLayerSource()) {
      res.status(500).json({ error: "No layer source configured. Set LAYERS_BUCKET (Filebase bucket name)." });
      return;
    }
    console.log(`[download-zip] job ${jobId}: ${total} NFTs, width=${width} height=${height} — starting ZIP64 stream (recompositing, no bucket given)`);

    const fetchLayerBuf = makeLayerFetcher();

    try {
      for (let offset = 0; offset < total; offset += DOWNLOAD_BATCH) {
        const batchEnd = Math.min(offset + DOWNLOAD_BATCH, total);
        const rows = await fetchEditionRows(jobId, offset, batchEnd);

        type LayerRow = { trait_type: string; trait_value: string; file_path: string | null; sort_order: number };
        type EditionData = { layers: LayerRow[]; rarityScore: number; rarityRank: number; rarityTier: string };
        const byEdition = new Map<number, EditionData>();
        for (const row of rows) {
          if (!byEdition.has(row.edition_number)) {
            byEdition.set(row.edition_number, {
              layers: [],
              rarityScore: parseFloat(row.rarity_score ?? '0') || 0,
              rarityRank: parseInt(row.rarity_rank ?? '0', 10) || 0,
              rarityTier: row.rarity_tier ?? 'Common',
            });
          }
          byEdition.get(row.edition_number)!.layers.push(row);
        }

        const editions = [...byEdition.keys()].sort((a, b) => a - b);
        const results: Array<{ editionNum: number; imgBuf: Buffer; metaJson: string }> = [];
        let cursor = 0;
        async function processOne() {
          while (cursor < editions.length) {
            const editionNum = editions[cursor++];
            const editionData = byEdition.get(editionNum)!;
            const validLayers = editionData.layers.filter(l => l.file_path);
            const resized: Buffer[] = [];
            for (const layer of validLayers) {
              const raw = await fetchLayerBuf(layer.file_path!);
              // See export-workers.ts's identical check — a trait row without a
              // fetchable source image must fail the download loudly, not
              // silently ship an incomplete NFT image as if it were correct.
              if (!raw) throw new Error(`Missing layer image for edition #${editionNum}: "${layer.trait_type}" -> "${layer.file_path}" not found in storage.`);
              resized.push(await sharp(raw).resize(width, height, { kernel: sharp.kernel.lanczos3, fit: "fill" }).toBuffer());
            }

            let imgBuf: Buffer;
            if (resized.length === 0) {
              imgBuf = await sharp({
                create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } },
              }).toFormat(ext === "webp" ? "webp" : "png", ext === "webp" ? { quality: 95, effort: 4 } : {}).toBuffer();
            } else {
              const [base, ...rest] = resized;
              imgBuf = await sharp(base)
                .composite(rest.map(buf => ({ input: buf, blend: "over" as const })))
                .toFormat(ext === "webp" ? "webp" : "png", ext === "webp" ? { quality: 95, effort: 4 } : {})
                .toBuffer();
            }

            const nftName = applyNameFormat(nameFormat || (collectionName ? `${collectionName} #{{id}}` : "#{{id}}"), editionNum);
            const traitAttributes = validLayers.map(l => ({ trait_type: l.trait_type, value: l.trait_value }));
            const baseUrl = "https://www.imbearth.com";
            const metaJson = JSON.stringify({
              name: nftName,
              description,
              image: `images/${editionNum}.${ext}`,
              external_url: baseUrl,
              attributes: [
                ...traitAttributes,
                { trait_type: "Rarity Score", value: (editionData.rarityScore || 0).toFixed(2) },
                { trait_type: "Rarity Rank", value: `#${editionData.rarityRank}` },
                { trait_type: "Rarity Tier", value: editionData.rarityTier || "Common" },
              ],
            }, null, 2);

            results.push({ editionNum, imgBuf, metaJson });
          }
        }
        await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, processOne));

        for (const r of results) {
          await zip.addFile(`images/${r.editionNum}.${ext}`, r.imgBuf);
          await zip.addFile(`metadata/${r.editionNum}.json`, Buffer.from(r.metaJson, "utf8"));
        }
      }

      await zip.finish();
    } catch (streamErr) {
      console.error(`[download-zip] failed mid-stream for job ${jobId}:`, streamErr);
      res.destroy(streamErr instanceof Error ? streamErr : new Error(String(streamErr)));
    }
  } catch (e) { next(e); }
});
router.post("/sync-records", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { jobId } = req.body ?? {};
    if (!jobId?.trim()) { res.status(422).json({ error: "jobId is required." }); return; }
    const { rows } = await pool.query(
      "SELECT id, status FROM nft_generation_jobs WHERE id = $1::uuid",
      [jobId],
    );
    if (!rows.length) { res.status(404).json({ error: "Job not found." }); return; }
    if (rows[0].status !== "complete") {
      res.status(409).json({ error: `Job status is '${rows[0].status}' — must be 'complete' before syncing to NFT Records.` });
      return;
    }
    const synced = await syncGeneratedItemsToNftRecords(jobId);
    res.json({ synced });
  } catch (e) { next(e); }
});

router.get("/presigned-zip/:jobId", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const { jobId } = req.params;
    const safeName = await safeZipFilename(jobId);
    const contentDisposition = `attachment; filename="${safeName}.zip"`;
    const reg = zipRegistry.get(jobId);
    if (reg) {
      const url = await getSignedUrl(
        getS3Client(),
        new GetObjectCommand({ Bucket: reg.bucket, Key: reg.zipKey, ResponseContentDisposition: contentDisposition }),
        { expiresIn: 86400 }, // 24 hours
      );
      res.json({ ready: true, url, bucket: reg.bucket, key: reg.zipKey });
      return;
    }
    const bucket = String(req.query.bucket ?? "");
    if (!bucket) { res.json({ ready: false, reason: "no_registry" }); return; }

    const zipKey = `downloads/${jobId}.zip`;
    try {
      await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: zipKey }));
      zipRegistry.set(jobId, { bucket, zipKey });
      const url = await getSignedUrl(
        getS3Client(),
        new GetObjectCommand({ Bucket: bucket, Key: zipKey, ResponseContentDisposition: contentDisposition }),
        { expiresIn: 86400 },
      );
      res.json({ ready: true, url, bucket, key: zipKey });
    } catch {
      res.json({ ready: false, reason: "not_built_yet" });
    }
  } catch (e) { next(e); }
});

router.post("/refresh-cids", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { bucket, format = "png", jobId, syncToRecords = false } = req.body ?? {};
    if (!bucket) { res.status(422).json({ error: "bucket is required." }); return; }
    if (!jobId) { res.status(422).json({ error: "jobId is required." }); return; }
    if (refreshCidMeta.running) {
      res.status(409).json({ error: "A CID refresh is already running." });
      return;
    }
    const refreshId = randomUUID();
    refreshCidMeta.jobs.set(refreshId, { status: "running", progress: 0, total: 0, resolved: 0, skipped: 0, phase: "Listing images…" });
    refreshCidMeta.running = true;
    const refreshJob = runRefreshCids(refreshId, bucket, String(format), String(jobId), Boolean(syncToRecords))
      .catch(async err => {
        const s = refreshCidMeta.jobs.get(refreshId);
        const msg = String(err?.message ?? err);
        if (s) { s.status = "error"; s.error = msg; }
        await saveTask(refreshId, 'refresh_cids', { status: 'error', phase: s?.phase ?? 'Failed', progress: s?.progress ?? 0, total: s?.total ?? 0, error: msg, meta: {} });
      })
      .finally(() => { refreshCidMeta.running = false; });
    keepAlive(refreshJob);
    await saveTask(refreshId, 'refresh_cids', { status: 'running', phase: 'Listing images…', progress: 0, total: 0, meta: {} });
    res.status(202).json({ refreshId });
  } catch (e) { next(e); }
});

// ── GET /refresh-cids/:refreshId — poll CID refresh status ───────────────────
router.get("/refresh-cids/:refreshId", async (req, res) => {
  const state = refreshCidMeta.jobs.get(req.params.refreshId);
  if (state) { res.json(state); return; }
  const db = await getTask(req.params.refreshId);
  if (!db) { res.status(404).json({ error: "Refresh job not found." }); return; }
  res.json(db);
});

// ── GET /:exportId — poll status ──────────────────────────────────────────────

router.get("/:exportId", async (req, res) => {
  const state = exportMeta.jobs.get(req.params.exportId);
  if (state) { res.json(state); return; }
  const db = await getTask(req.params.exportId);
  if (!db) { res.status(404).json({ error: "Export job not found." }); return; }
  res.json(db);
});

export default router;
