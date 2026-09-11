import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import path from "path";
import fs from "fs";
import os from "os";
import sharp from "sharp";
import pool from "../../pool";
import { getS3Client } from "../../clients/s3";
import { batchUpdateItemIpfsCids, syncGeneratedItemsToNftRecords } from "../../services/nft-gen.service";
import { pollCid } from "../../utils/pollCid";
import { ZipStream } from "../../utils/zipStream";
import { S3MultipartWritable } from "../../utils/s3MultipartWritable";
import {
  EditionRow, LayerRow, EditionData,
  fetchEditionRows, applyNameFormat,
  makeLayerFetcher, makeResizedFetcher,
  streamToBuffer, putObjectWithRetry,
} from "./export-helpers";
import { exportMeta, refreshCidMeta, previewMeta, zipRegistry } from "./export-state";
import { saveTask } from "../../utils/taskProgress";

const CPU_COUNT = Math.max(2, os.cpus().length || 2);
sharp.concurrency(CPU_COUNT);
function createSemaphore(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>(resolve => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}
const compositeGate = createSemaphore(CPU_COUNT);

export const BATCH = 500;
export const CONCURRENCY = 150;
const META_CONCURRENCY = 60;
const REFRESH_CONCURRENCY = 20;
const PREVIEW_THUMB = 64;
const PREVIEW_CONCURRENCY = 20;
const PREVIEW_BATCH = 200;
const ZIP_ASSEMBLY_CONCURRENCY = 20;

async function buildZipFromBucket(bucket: string, jobId: string, total: number, ext: string): Promise<boolean> {
  const s3 = getS3Client();
  const zipKey = `downloads/${jobId}.zip`;
  const zipS3 = new S3MultipartWritable(s3, bucket, zipKey);
  const zipOut = new ZipStream(zipS3);

  try {
    const pending = new Map<number, { imgBuf: Buffer; metaBuf: Buffer }>();
    let nextToWrite = 1;
    let cursor = 1;
    let draining = false;

    async function drain() {
      if (draining) return;
      draining = true;
      try {
        while (pending.has(nextToWrite)) {
          const { imgBuf, metaBuf } = pending.get(nextToWrite)!;
          pending.delete(nextToWrite);
          await zipOut.addFile(`images/${nextToWrite}.${ext}`, imgBuf);
          await zipOut.addFile(`metadata/${nextToWrite}.json`, metaBuf);
          nextToWrite++;
        }
      } finally {
        draining = false;
      }
    }

    async function worker() {
      while (cursor <= total) {
        const n = cursor++;
        const [imgRes, metaRes] = await Promise.all([
          s3.send(new GetObjectCommand({ Bucket: bucket, Key: `images/${n}.${ext}` })),
          s3.send(new GetObjectCommand({ Bucket: bucket, Key: `metadata/${n}.json` })),
        ]);
        const [imgBuf, metaBuf] = await Promise.all([
          streamToBuffer(imgRes.Body),
          streamToBuffer(metaRes.Body),
        ]);
        pending.set(n, { imgBuf, metaBuf });
        await drain();
        while (n - nextToWrite > ZIP_ASSEMBLY_CONCURRENCY) {
          await new Promise(r => setTimeout(r, 25));
        }
      }
    }

    await Promise.all(Array.from({ length: ZIP_ASSEMBLY_CONCURRENCY }, worker));
    await zipOut.finish();
    await zipS3.complete();
    zipRegistry.set(jobId, { bucket, zipKey });
    console.log(`[buildZipFromBucket] pre-built ZIP assembled for resumed job: s3://${bucket}/${zipKey}`);
    return true;
  } catch (err) {
    console.error(`[buildZipFromBucket] failed to assemble ZIP for job ${jobId}:`, err);
    await zipS3.abort().catch(() => { });
    return false;
  }
}

export async function runExport(
  exportId: string,
  jobId: string,
  opts: {
    bucket: string; format: string; width: number; height: number; total: number;
    collectionName: string; description: string; nameFormat: string;
    syncToRecords: boolean; resumeFrom: number;
  },
) {
  const { bucket, format, width, height, total, syncToRecords, resumeFrom } = opts;
  const ext = format === "webp" ? "webp" : "png";
  const mime = ext === "webp" ? "image/webp" : "image/png";
  const state = exportMeta.jobs.get(exportId)!;
  const s3 = getS3Client();
  const fetchLayerBuf = makeLayerFetcher();
  const fetchLayerResized = makeResizedFetcher(fetchLayerBuf, width, height);

  const heartbeat = setInterval(() => { state.lastUpdatedAt = Date.now(); }, 10_000);
  try {
    return await runExportBody();
  } finally {
    clearInterval(heartbeat);
  }

  async function runExportBody() {

  const { rows: collRows } = await pool.query(
    `SELECT c.name, c.description, c.name_format FROM nft_generation_jobs j
     JOIN nft_collections c ON c.id = j.collection_id WHERE j.id = $1::uuid`,
    [jobId],
  );
  const dbCollectionName = collRows[0]?.name ?? "";
  const dbDescription = collRows[0]?.description ?? "";
  const dbNameFormat = collRows[0]?.name_format ?? "";

  const safeName = (dbCollectionName || "bearth-nft-collection").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
  const zipKey = `downloads/${jobId}.zip`;
  let zipS3: S3MultipartWritable | null = null;
  let zipOut: ZipStream | null = null;
  let zipOk = false;
  if (resumeFrom === 0) {
    zipS3 = new S3MultipartWritable(s3, bucket, zipKey);
    zipOut = new ZipStream(zipS3);
  }
  const loopStart = Math.floor(resumeFrom / BATCH) * BATCH;
  for (let offset = loopStart; offset < total; offset += BATCH) {
    const batchEnd = Math.min(offset + BATCH, total);
    state.phase = `Phase 1 — Compositing ${offset + 1}–${batchEnd} of ${total}…`;

    const rows = await fetchEditionRows(jobId, offset, batchEnd);

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
    const remainingPaths = rows.filter(r => r.edition_number > resumeFrom).map(r => r.file_path);
    const uniquePaths = [...new Set(remainingPaths.filter(Boolean))] as string[];
    const PREWARM_C = 10;
    for (let p = 0; p < uniquePaths.length; p += PREWARM_C) {
      await Promise.all(uniquePaths.slice(p, p + PREWARM_C).map(fp => fetchLayerResized(fp)));
    }

    let cursor = 0;
    let nextToUpload = editions.find(e => e > resumeFrom) ?? offset + 1;
    const pending = new Map<number, Buffer>();
    let draining = false;
    const MAX_LEAD = 20;

    async function drainImages() {
      if (draining) return;
      draining = true;
      try {
        while (pending.has(nextToUpload)) {
          const buf = pending.get(nextToUpload)!;
          pending.delete(nextToUpload);
          const imgKey = `images/${nextToUpload}.${ext}`;
          await putObjectWithRetry(s3, bucket, imgKey, buf, mime);
          if (zipOut) await zipOut.addFile(imgKey, buf);
          state.progress++;
          state.phase = `Phase 1 — Uploading images… ${state.progress} / ${total}`;
          nextToUpload++;
        }
      } finally {
        draining = false;
      }
    }

    async function processOneImage() {
      while (cursor < editions.length) {
        const editionNum = editions[cursor++];
        if (editionNum <= resumeFrom) continue;

        const editionData = byEdition.get(editionNum)!;
        const layerRows = editionData.layers;

        const validLayers = layerRows.filter(l => l.file_path);
        const resized: Buffer[] = [];
        for (const layer of validLayers) {
          const buf = await fetchLayerResized(layer.file_path!);
          if (!buf) throw new Error(`Missing layer image for edition #${editionNum}: "${layer.trait_type}" -> "${layer.file_path}" not found in storage.`);
          resized.push(buf);
        }

        const imgBuf: Buffer = await compositeGate(async () => {
          if (resized.length === 0) {
            return sharp({
              create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } },
            }).toFormat(ext === "webp" ? "webp" : "png", ext === "webp" ? { quality: 95, effort: 4 } : {}).toBuffer();
          }
          const [base, ...rest] = resized;
          return sharp(base)
            .composite(rest.map(buf => ({ input: buf, blend: "over" as const })))
            .toFormat(ext === "webp" ? "webp" : "png", ext === "webp" ? { quality: 95, effort: 4 } : {})
            .toBuffer();
        });

        pending.set(editionNum, imgBuf);
        await drainImages();

        while (editionNum - nextToUpload > MAX_LEAD) {
          await new Promise(r => setTimeout(r, 25));
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, processOneImage));

    if (pending.size > 0) {
      const stuckAt = nextToUpload;
      throw new Error(
        `Export stalled in batch ${offset + 1}-${batchEnd}: ${pending.size} composited image(s) never uploaded ` +
        `because edition #${stuckAt} is missing from this job's edition_number sequence. ` +
        `Uploaded through #${stuckAt - 1}; editions queued but undrained: ${[...pending.keys()].sort((a, b) => a - b).join(', ')}.`
      );
    }

    await saveTask(exportId, 'export', { status: 'running', phase: state.phase, progress: state.progress, total, meta: { jobId } });
  }

  const ipfsUpdates: Array<{ editionNumber: number; ipfsImageCid: string; ipfsMetadataCid: string; imagePath: string }> = [];
  const missedCids: Array<{ editionNumber: number; imgKey: string; metaKey: string }> = [];

  let metaResumeFrom = 0;
  {
    let continuationToken: string | undefined;
    let metaCount = 0;
    do {
      const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "metadata/", ContinuationToken: continuationToken }));
      metaCount += (resp.Contents ?? []).length;
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    metaResumeFrom = metaCount;
  }
  const metaLoopStart = Math.floor(metaResumeFrom / BATCH) * BATCH;
  let metaDone = metaResumeFrom;

  for (let offset = metaLoopStart; offset < total; offset += BATCH) {
    const batchEnd = Math.min(offset + BATCH, total);

    const rows2 = await fetchEditionRows(jobId, offset, batchEnd);

    const byEdition2 = new Map<number, EditionData>();
    for (const row of rows2) {
      if (!byEdition2.has(row.edition_number)) {
        byEdition2.set(row.edition_number, {
          layers: [],
          rarityScore: parseFloat(row.rarity_score ?? '0') || 0,
          rarityRank: parseInt(row.rarity_rank ?? '0', 10) || 0,
          rarityTier: row.rarity_tier ?? 'Common',
        });
      }
      byEdition2.get(row.edition_number)!.layers.push(row);
    }

    const editions2 = [...byEdition2.keys()].sort((a, b) => a - b);
    let cursor2 = 0;
    let nextMetaUpload = editions2.find(e => e > metaResumeFrom) ?? offset + 1;
    const pendingMeta = new Map<number, { metaJson: string; imgCid: string; metaKey: string; imgKey: string }>();
    let drainingMeta = false;
    const META_MAX_LEAD = 20;

    async function drainMeta() {
      if (drainingMeta) return;
      drainingMeta = true;
      try {
        while (pendingMeta.has(nextMetaUpload)) {
          const { metaJson, imgCid, metaKey, imgKey } = pendingMeta.get(nextMetaUpload)!;
          pendingMeta.delete(nextMetaUpload);
          await putObjectWithRetry(s3, bucket, metaKey, metaJson, "application/json");
          let metaCid = "";
          try {
            const metaHead = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: metaKey }));
            metaCid = (metaHead.Metadata?.["cid"] ?? "").trim();
          } catch { }

          if (zipOut) await zipOut.addFile(metaKey, Buffer.from(metaJson, "utf8"));
          if (imgCid) {
            ipfsUpdates.push({ editionNumber: nextMetaUpload, ipfsImageCid: imgCid, ipfsMetadataCid: metaCid, imagePath: imgKey });
          }

          metaDone++;
          state.phase = `Phase 2 — Metadata uploaded… ${metaDone} / ${total}`;
          nextMetaUpload++;
        }
      } finally {
        drainingMeta = false;
      }
    }

    async function processOneMeta() {
      while (cursor2 < editions2.length) {
        const editionNum = editions2[cursor2++];
        if (editionNum <= metaResumeFrom) continue;

        const { layers, rarityScore, rarityRank, rarityTier } = byEdition2.get(editionNum)!;
        const imgKey = `images/${editionNum}.${ext}`;
        const metaKey = `metadata/${editionNum}.json`;
        const imgCid = await pollCid(s3, bucket, imgKey, 30_000);
        if (!imgCid) missedCids.push({ editionNumber: editionNum, imgKey, metaKey });

        const nftName = applyNameFormat(dbNameFormat || (dbCollectionName ? `${dbCollectionName} #{{id}}` : "#{{id}}"), editionNum);
        const validLayers = layers.filter(l => l.file_path);
        const traitAttributes = validLayers.map(l => ({ trait_type: l.trait_type, value: l.trait_value }));
        const baseUrl = "https://www.imbearth.com";

        const metaJson = JSON.stringify({
          name: nftName,
          description: dbDescription,
          image: imgCid ? `ipfs://${imgCid}` : `ipfs://pending/${imgKey}`,
          external_url: baseUrl,
          attributes: [
            ...traitAttributes,
            { trait_type: "Rarity Score", value: rarityScore.toFixed(2) },
            { trait_type: "Rarity Rank", value: `#${rarityRank}` },
            { trait_type: "Rarity Tier", value: rarityTier || "Common" },
          ],
        }, null, 2);

        pendingMeta.set(editionNum, { metaJson, imgCid: imgCid || "", metaKey, imgKey });
        await drainMeta();

        while (editionNum - nextMetaUpload > META_MAX_LEAD) {
          await new Promise(r => setTimeout(r, 25));
        }
      }
    }

    await Promise.all(Array.from({ length: META_CONCURRENCY }, processOneMeta));
    await saveTask(exportId, 'export', { status: 'running', phase: state.phase, progress: state.progress, total, meta: { jobId } });

    if (ipfsUpdates.length > 0) {
      await batchUpdateItemIpfsCids({ jobId, items: ipfsUpdates });
      ipfsUpdates.length = 0;
    }
  }
  let unresolvedCids = 0;
  if (missedCids.length > 0) {
    state.phase = `Resolving ${missedCids.length} pending IPFS CID${missedCids.length === 1 ? '' : 's'}…`;
    const recovered: Array<{ editionNumber: number; ipfsImageCid: string; ipfsMetadataCid: string; imagePath: string }> = [];
    let mCursor = 0;

    async function retryOne() {
      while (mCursor < missedCids.length) {
        const { editionNumber, imgKey, metaKey } = missedCids[mCursor++];
        const imgCid = await pollCid(s3, bucket, imgKey, 60_000);
        if (!imgCid) { unresolvedCids++; continue; }

        try {
          const getResp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: metaKey }));
          const parsed = JSON.parse((await streamToBuffer(getResp.Body)).toString("utf8"));
          parsed.image = `ipfs://${imgCid}`;
          await s3.send(new PutObjectCommand({ Bucket: bucket, Key: metaKey, Body: JSON.stringify(parsed, null, 2), ContentType: "application/json" }));
        } catch { }

        let metaCid = "";
        try {
          const metaHead = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: metaKey }));
          metaCid = (metaHead.Metadata?.["cid"] ?? "").trim();
        } catch { }

        recovered.push({ editionNumber, ipfsImageCid: imgCid, ipfsMetadataCid: metaCid, imagePath: imgKey });
      }
    }

    await Promise.all(Array.from({ length: Math.min(META_CONCURRENCY, missedCids.length) }, retryOne));
    if (recovered.length > 0) await batchUpdateItemIpfsCids({ jobId, items: recovered });
    if (unresolvedCids > 0) {
      console.warn(`[runExport] ${unresolvedCids}/${missedCids.length} edition(s) still lack an IPFS CID after retry (jobId=${jobId}) — use "Refresh CIDs" to retry later.`);
    }
  }

  if (zipOut && zipS3) {
    state.phase = "Finalising download ZIP…";
    try {
      await zipOut.finish();
      await zipS3.complete();
      zipRegistry.set(jobId, { bucket, zipKey });
      zipOk = true;
      console.log(`[runExport] pre-built ZIP uploaded: s3://${bucket}/${zipKey}`);
    } catch (zipErr) {
      console.error(`[runExport] pre-built ZIP failed (streaming fallback still works):`, zipErr);
      await zipS3.abort().catch(() => { });
    }
  } else if (resumeFrom > 0) {
    state.phase = "Assembling download ZIP from uploaded files…";
    zipOk = await buildZipFromBucket(bucket, jobId, total, ext);
  }

  let synced = 0;
  if (syncToRecords) {
    state.phase = "Syncing to NFT Records…";
    synced = await syncGeneratedItemsToNftRecords(jobId);
  }

  const uploadedCount = total - resumeFrom;
  const unresolvedSuffix = unresolvedCids > 0 ? `, ${unresolvedCids} CID${unresolvedCids === 1 ? '' : 's'} still pending — use Refresh CIDs` : '';
  state.status = "done";
  state.phase = syncToRecords
    ? `Complete — ${uploadedCount} NFTs uploaded${resumeFrom > 0 ? ` (${total} total in bucket)` : ''}${zipOk ? ' · ZIP ready' : ''}, ${synced} synced to NFT Records${unresolvedSuffix}`
    : `Complete — ${uploadedCount} NFTs uploaded${resumeFrom > 0 ? ` (${total} total in bucket)` : ''}${zipOk ? ' · ZIP ready for instant download' : ''} (test run — nft_records not updated)${unresolvedSuffix}`;
  await saveTask(exportId, 'export', { status: 'done', phase: state.phase, progress: total, total, meta: { jobId } });
  }
}

export async function runExportSlice(
  exportId: string,
  jobId: string,
  opts: {
    bucket: string; format: string; width: number; height: number;
    collectionName: string; description: string; nameFormat: string;
    rangeStart: number; rangeEnd: number; resumeFrom: number;
  },
) {
  const { bucket, format, width, height, rangeStart, rangeEnd, resumeFrom } = opts;
  const ext = format === "webp" ? "webp" : "png";
  const mime = ext === "webp" ? "image/webp" : "image/png";
  const state = exportMeta.rangeSlices.get(exportId)!;
  const s3 = getS3Client();
  const fetchLayerBuf = makeLayerFetcher();
  const fetchLayerResized = makeResizedFetcher(fetchLayerBuf, width, height);
  const sliceTotal = rangeEnd - rangeStart;

  const heartbeat = setInterval(() => { state.lastUpdatedAt = Date.now(); }, 10_000);
  try {
    return await runSliceBody();
  } finally {
    clearInterval(heartbeat);
  }

  async function runSliceBody() {
    const { rows: collRows } = await pool.query(
      `SELECT c.name, c.description, c.name_format FROM nft_generation_jobs j
       JOIN nft_collections c ON c.id = j.collection_id WHERE j.id = $1::uuid`,
      [jobId],
    );
    const dbCollectionName = collRows[0]?.name ?? "";
    const dbDescription = collRows[0]?.description ?? "";
    const dbNameFormat = collRows[0]?.name_format ?? "";

    const imgLoopStart = Math.max(rangeStart, Math.floor(resumeFrom / BATCH) * BATCH);
    for (let offset = imgLoopStart; offset < rangeEnd; offset += BATCH) {
      const batchEnd = Math.min(offset + BATCH, rangeEnd);
      state.phase = `Phase 1 — Compositing ${offset + 1}–${batchEnd} of ${rangeEnd} (slice)…`;

      const rows = await fetchEditionRows(jobId, offset, batchEnd);
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

      const remainingPaths = rows.filter(r => r.edition_number > resumeFrom).map(r => r.file_path);
      const uniquePaths = [...new Set(remainingPaths.filter(Boolean))] as string[];
      const PREWARM_C = 10;
      for (let p = 0; p < uniquePaths.length; p += PREWARM_C) {
        await Promise.all(uniquePaths.slice(p, p + PREWARM_C).map(fp => fetchLayerResized(fp)));
      }

      let cursor = 0;
      let nextToUpload = editions.find(e => e > resumeFrom) ?? offset + 1;
      const pending = new Map<number, Buffer>();
      let draining = false;
      const MAX_LEAD = 20;

      async function drainImages() {
        if (draining) return;
        draining = true;
        try {
          while (pending.has(nextToUpload)) {
            const buf = pending.get(nextToUpload)!;
            pending.delete(nextToUpload);
            const imgKey = `images/${nextToUpload}.${ext}`;
            await putObjectWithRetry(s3, bucket, imgKey, buf, mime);
            state.progress++;
            state.phase = `Phase 1 — Uploading images… ${state.progress} / ${sliceTotal} (slice)`;
            nextToUpload++;
          }
        } finally {
          draining = false;
        }
      }

      async function processOneImage() {
        while (cursor < editions.length) {
          const editionNum = editions[cursor++];
          if (editionNum <= resumeFrom) continue;

          const editionData = byEdition.get(editionNum)!;
          const validLayers = editionData.layers.filter(l => l.file_path);
          const resized: Buffer[] = [];
          for (const layer of validLayers) {
            const buf = await fetchLayerResized(layer.file_path!);
            if (!buf) throw new Error(`Missing layer image for edition #${editionNum}: "${layer.trait_type}" -> "${layer.file_path}" not found in storage.`);
            resized.push(buf);
          }

          const imgBuf: Buffer = await compositeGate(async () => {
            if (resized.length === 0) {
              return sharp({
                create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } },
              }).toFormat(ext === "webp" ? "webp" : "png", ext === "webp" ? { quality: 95, effort: 4 } : {}).toBuffer();
            }
            const [base, ...rest] = resized;
            return sharp(base)
              .composite(rest.map(buf => ({ input: buf, blend: "over" as const })))
              .toFormat(ext === "webp" ? "webp" : "png", ext === "webp" ? { quality: 95, effort: 4 } : {})
              .toBuffer();
          });

          pending.set(editionNum, imgBuf);
          await drainImages();

          while (editionNum - nextToUpload > MAX_LEAD) {
            await new Promise(r => setTimeout(r, 25));
          }
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, processOneImage));

      if (pending.size > 0) {
        const stuckAt = nextToUpload;
        throw new Error(
          `Export slice stalled in batch ${offset + 1}-${batchEnd}: ${pending.size} composited image(s) never uploaded ` +
          `because edition #${stuckAt} is missing from this job's edition_number sequence.`
        );
      }

      await saveTask(exportId, 'export', { status: 'running', phase: state.phase, progress: state.progress, total: sliceTotal, meta: { jobId, rangeStart, rangeEnd } });
    }

    const ipfsUpdates: Array<{ editionNumber: number; ipfsImageCid: string; ipfsMetadataCid: string; imagePath: string }> = [];
    const missedCids: Array<{ editionNumber: number; imgKey: string; metaKey: string }> = [];

    let metaResumeFrom = rangeStart;
    {
      const { rows: doneRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM nft_generated_items
         WHERE job_id = $1::uuid AND edition_number > $2 AND edition_number <= $3
           AND ipfs_metadata_cid IS NOT NULL AND ipfs_metadata_cid != ''`,
        [jobId, rangeStart, rangeEnd],
      );
      metaResumeFrom = rangeStart + Number(doneRows[0]?.cnt ?? 0);
    }
    let metaDone = metaResumeFrom - rangeStart;

    const metaLoopStart = Math.max(rangeStart, Math.floor(metaResumeFrom / BATCH) * BATCH);
    for (let offset = metaLoopStart; offset < rangeEnd; offset += BATCH) {
      const batchEnd = Math.min(offset + BATCH, rangeEnd);
      const rows2 = await fetchEditionRows(jobId, offset, batchEnd);
      const byEdition2 = new Map<number, EditionData>();
      for (const row of rows2) {
        if (!byEdition2.has(row.edition_number)) {
          byEdition2.set(row.edition_number, {
            layers: [],
            rarityScore: parseFloat(row.rarity_score ?? '0') || 0,
            rarityRank: parseInt(row.rarity_rank ?? '0', 10) || 0,
            rarityTier: row.rarity_tier ?? 'Common',
          });
        }
        byEdition2.get(row.edition_number)!.layers.push(row);
      }
      const editions2 = [...byEdition2.keys()].sort((a, b) => a - b);
      let cursor2 = 0;
      let nextMetaUpload = editions2.find(e => e > metaResumeFrom) ?? offset + 1;
      const pendingMeta = new Map<number, { metaJson: string; imgCid: string; metaKey: string; imgKey: string }>();
      let drainingMeta = false;
      const META_MAX_LEAD = 20;

      async function drainMeta() {
        if (drainingMeta) return;
        drainingMeta = true;
        try {
          while (pendingMeta.has(nextMetaUpload)) {
            const { metaJson, imgCid, metaKey, imgKey } = pendingMeta.get(nextMetaUpload)!;
            pendingMeta.delete(nextMetaUpload);
            await putObjectWithRetry(s3, bucket, metaKey, metaJson, "application/json");
            let metaCid = "";
            try {
              const metaHead = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: metaKey }));
              metaCid = (metaHead.Metadata?.["cid"] ?? "").trim();
            } catch { }

            if (imgCid) {
              ipfsUpdates.push({ editionNumber: nextMetaUpload, ipfsImageCid: imgCid, ipfsMetadataCid: metaCid, imagePath: imgKey });
            }
            metaDone++;
            state.phase = `Phase 2 — Metadata uploaded… ${metaDone} / ${sliceTotal} (slice)`;
            nextMetaUpload++;
          }
        } finally {
          drainingMeta = false;
        }
      }

      async function processOneMeta() {
        while (cursor2 < editions2.length) {
          const editionNum = editions2[cursor2++];
          if (editionNum <= metaResumeFrom) continue;

          const { layers, rarityScore, rarityRank, rarityTier } = byEdition2.get(editionNum)!;
          const imgKey = `images/${editionNum}.${ext}`;
          const metaKey = `metadata/${editionNum}.json`;
          const imgCid = await pollCid(s3, bucket, imgKey, 30_000);
          if (!imgCid) missedCids.push({ editionNumber: editionNum, imgKey, metaKey });

          const nftName = applyNameFormat(dbNameFormat || (dbCollectionName ? `${dbCollectionName} #{{id}}` : "#{{id}}"), editionNum);
          const validLayers = layers.filter(l => l.file_path);
          const traitAttributes = validLayers.map(l => ({ trait_type: l.trait_type, value: l.trait_value }));
          const baseUrl = "https://www.imbearth.com";

          const metaJson = JSON.stringify({
            name: nftName,
            description: dbDescription,
            image: imgCid ? `ipfs://${imgCid}` : `ipfs://pending/${imgKey}`,
            external_url: baseUrl,
            attributes: [
              ...traitAttributes,
              { trait_type: "Rarity Score", value: rarityScore.toFixed(2) },
              { trait_type: "Rarity Rank", value: `#${rarityRank}` },
              { trait_type: "Rarity Tier", value: rarityTier || "Common" },
            ],
          }, null, 2);

          pendingMeta.set(editionNum, { metaJson, imgCid: imgCid || "", metaKey, imgKey });
          await drainMeta();

          while (editionNum - nextMetaUpload > META_MAX_LEAD) {
            await new Promise(r => setTimeout(r, 25));
          }
        }
      }

      await Promise.all(Array.from({ length: META_CONCURRENCY }, processOneMeta));
      await saveTask(exportId, 'export', { status: 'running', phase: state.phase, progress: state.progress, total: sliceTotal, meta: { jobId, rangeStart, rangeEnd } });

      if (ipfsUpdates.length > 0) {
        await batchUpdateItemIpfsCids({ jobId, items: ipfsUpdates });
        ipfsUpdates.length = 0;
      }
    }

    let unresolvedCids = 0;
    if (missedCids.length > 0) {
      state.phase = `Resolving ${missedCids.length} pending IPFS CID${missedCids.length === 1 ? '' : 's'} (slice)…`;
      const recovered: Array<{ editionNumber: number; ipfsImageCid: string; ipfsMetadataCid: string; imagePath: string }> = [];
      let mCursor = 0;
      async function retryOne() {
        while (mCursor < missedCids.length) {
          const { editionNumber, imgKey, metaKey } = missedCids[mCursor++];
          const imgCid = await pollCid(s3, bucket, imgKey, 60_000);
          if (!imgCid) { unresolvedCids++; continue; }
          try {
            const getResp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: metaKey }));
            const parsed = JSON.parse((await streamToBuffer(getResp.Body)).toString("utf8"));
            parsed.image = `ipfs://${imgCid}`;
            await s3.send(new PutObjectCommand({ Bucket: bucket, Key: metaKey, Body: JSON.stringify(parsed, null, 2), ContentType: "application/json" }));
          } catch { }
          let metaCid = "";
          try {
            const metaHead = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: metaKey }));
            metaCid = (metaHead.Metadata?.["cid"] ?? "").trim();
          } catch { }
          recovered.push({ editionNumber, ipfsImageCid: imgCid, ipfsMetadataCid: metaCid, imagePath: imgKey });
        }
      }
      await Promise.all(Array.from({ length: Math.min(META_CONCURRENCY, missedCids.length) }, retryOne));
      if (recovered.length > 0) await batchUpdateItemIpfsCids({ jobId, items: recovered });
    }

    state.status = "done";
    state.phase = `Complete — slice [${rangeStart + 1}-${rangeEnd}] done${unresolvedCids > 0 ? `, ${unresolvedCids} CID(s) still pending` : ''}`;
    await saveTask(exportId, 'export', { status: 'done', phase: state.phase, progress: sliceTotal, total: sliceTotal, meta: { jobId, rangeStart, rangeEnd } });
  }
}

export async function runPreview(
  previewId: string,
  jobId: string,
  opts: { width: number; height: number; total: number; previewDir: string },
) {
  const { total, previewDir } = opts;
  const state = previewMeta.jobs.get(previewId)!;
  const fetchLayerBuf = makeLayerFetcher();
  const resizedCache = new Map<string, Promise<Buffer>>();
  function getResized(filePath: string, raw: Buffer): Promise<Buffer> {
    if (!resizedCache.has(filePath)) {
      resizedCache.set(
        filePath,
        sharp(raw).resize(PREVIEW_THUMB, PREVIEW_THUMB, { fit: "cover" }).png().toBuffer(),
      );
    }
    return resizedCache.get(filePath)!;
  }

  for (let offset = 0; offset < total; offset += PREVIEW_BATCH) {
    const batchEnd = Math.min(offset + PREVIEW_BATCH, total);
    state.phase = `Compositing ${offset + 1}–${batchEnd} of ${total}…`;

    const rows = await fetchEditionRows(jobId, offset, batchEnd);

    const byEdition = new Map<number, LayerRow[]>();
    for (const row of rows) {
      if (!byEdition.has(row.edition_number)) byEdition.set(row.edition_number, []);
      byEdition.get(row.edition_number)!.push(row);
    }

    const uniquePaths = new Set<string>();
    for (const row of rows) { if (row.file_path) uniquePaths.add(row.file_path); }
    await Promise.all([...uniquePaths].map(async fp => {
      const raw = await fetchLayerBuf(fp);
      return raw ? getResized(fp, raw) : null;
    }));

    const editions = [...byEdition.keys()].sort((a, b) => a - b);
    let cursor = 0;

    async function processOnePreview() {
      while (cursor < editions.length) {
        const editionNum = editions[cursor++];
        const layerRows = byEdition.get(editionNum)!;
        const validLayers = layerRows.filter(l => l.file_path);

        const resized: Buffer[] = [];
        for (const layer of validLayers) {
          const raw = await fetchLayerBuf(layer.file_path!);
          if (!raw) throw new Error(`Missing layer image for edition #${editionNum}: "${layer.trait_type}" -> "${layer.file_path}" not found in storage.`);
          resized.push(await getResized(layer.file_path!, raw));
        }

        let imgBuf: Buffer;
        if (resized.length === 0) {
          imgBuf = await sharp({
            create: { width: PREVIEW_THUMB, height: PREVIEW_THUMB, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } },
          }).png().toBuffer();
        } else {
          const [base, ...rest] = resized;
          imgBuf = await sharp(base)
            .composite(rest.map(buf => ({ input: buf, blend: "over" as const })))
            .png()
            .toBuffer();
        }

        let invalidReason = "";
        if (validLayers.length === 0) {
          invalidReason = "No visible layers — solid black";
        } else {
          try {
            const stats = await sharp(imgBuf).stats();
            const rgbStdev = stats.channels.slice(0, 3).reduce((s, c) => s + ((c as any).stdev ?? (c as any).std ?? 0), 0);
            if (rgbStdev < 2) invalidReason = `Uniform image (rgb stdev=${rgbStdev.toFixed(1)}) — compositing may have failed`;
          } catch { invalidReason = "Could not validate image"; }
        }

        if (invalidReason) {
          state.invalidItems.push({ edition: editionNum, reason: invalidReason });
        } else {
          state.validCount++;
        }

        fs.writeFileSync(path.join(previewDir, `${editionNum}.png`), imgBuf);
        state.progress++;
        state.phase = `Validating… ${state.progress} / ${total}`;
      }
    }

    await Promise.all(Array.from({ length: PREVIEW_CONCURRENCY }, processOnePreview));
  }

  state.status = "done";
  state.phase = `Complete — ${state.validCount}/${total} valid${state.invalidItems.length ? `, ${state.invalidItems.length} issues` : ''}`;
}

export async function runRefreshCids(refreshId: string, bucket: string, format: string, jobId: string, syncToRecords: boolean) {
  const ext = format === "webp" ? "webp" : "png";
  const state = refreshCidMeta.jobs.get(refreshId)!;
  const s3 = getS3Client();
  const heartbeat = setInterval(() => { state.lastUpdatedAt = Date.now(); }, 10_000);
  try {
    return await runRefreshCidsBody();
  } finally {
    clearInterval(heartbeat);
  }

  async function runRefreshCidsBody() {

  state.phase = "Listing images in bucket…";
  const imageKeys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "images/",
      ContinuationToken: continuationToken,
    }));
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) imageKeys.push(obj.Key);
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  const { rows: ownEditionRows } = jobId
    ? await pool.query(`SELECT edition_number FROM nft_generated_items WHERE job_id = $1`, [jobId])
    : { rows: [] as { edition_number: number }[] };
  const ownEditions = new Set(ownEditionRows.map(r => r.edition_number));
  const scopedImageKeys = jobId
    ? imageKeys.filter(k => {
        const n = parseInt(k.replace(/^images\//, "").replace(/\.\w+$/, ""), 10);
        return !isNaN(n) && ownEditions.has(n);
      })
    : imageKeys;

  state.total = scopedImageKeys.length;
  state.phase = `Found ${scopedImageKeys.length} images — refreshing CIDs…`;

  const { rows: dbResolvedRows } = jobId
    ? await pool.query(`SELECT edition_number FROM nft_generated_items WHERE job_id = $1 AND ipfs_image_cid IS NOT NULL AND ipfs_image_cid != ''`, [jobId])
    : { rows: [] as { edition_number: number }[] };
  const dbResolvedEditions = new Set(dbResolvedRows.map(r => r.edition_number));

  let cursor = 0;
  const resolvedItems: Array<{ editionNumber: number; ipfsImageCid: string; ipfsMetadataCid: string; imagePath: string }> = [];

  async function processOne() {
    while (cursor < scopedImageKeys.length) {
      const imgKey = scopedImageKeys[cursor++];
      const basename = imgKey.replace(/^images\//, "").replace(/\.\w+$/, "");
      const editionNum = parseInt(basename, 10);
      if (isNaN(editionNum)) { state.progress++; state.skipped++; continue; }

      const metaKey = `metadata/${editionNum}.json`;

      let imgCid: string;
      let metaCid: string;
      try {
        const [imgHead, metaHead] = await Promise.all([
          s3.send(new HeadObjectCommand({ Bucket: bucket, Key: imgKey })),
          s3.send(new HeadObjectCommand({ Bucket: bucket, Key: metaKey })).catch(() => null),
        ]);
        imgCid = (imgHead.Metadata?.["cid"] ?? "").trim();
        metaCid = ((metaHead?.Metadata?.["cid"]) ?? "").trim();
      } catch {
        state.progress++; state.skipped++;
        state.phase = `Refreshing CIDs… ${state.progress} / ${state.total}`;
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        const getResp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: metaKey }));
        const raw = (await streamToBuffer(getResp.Body)).toString("utf8");
        parsed = JSON.parse(raw);
      } catch {
        state.progress++; state.skipped++;
        state.phase = `Refreshing CIDs… ${state.progress} / ${state.total}`;
        continue;
      }

      if (!imgCid) {
        const fileImageCid = String(parsed.image ?? "").match(/^ipfs:\/\/(\S+)$/)?.[1];
        if (fileImageCid) imgCid = fileImageCid;
      }

      if (!imgCid) {
        state.progress++; state.skipped++;
        state.phase = `Refreshing CIDs… ${state.progress} / ${state.total}`;
        continue;
      }

      const isPendingInFile = String(parsed.image ?? "").includes("pending");
      const missingInDb = jobId ? !dbResolvedEditions.has(editionNum) : false;

      if (!isPendingInFile && !missingInDb) {
        state.progress++; state.skipped++;
        state.phase = `Refreshing CIDs… ${state.progress} / ${state.total}`;
        continue;
      }

      if (isPendingInFile) {
        parsed.image = `ipfs://${imgCid}`;
        const newMeta = JSON.stringify(parsed, null, 2);

        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: metaKey,
          Body: newMeta,
          ContentType: "application/json",
        }));
      }

      resolvedItems.push({ editionNumber: editionNum, ipfsImageCid: imgCid, ipfsMetadataCid: metaCid, imagePath: imgKey });

      state.progress++;
      state.resolved++;
      state.phase = `Refreshing CIDs… ${state.progress} / ${state.total}`;
    }
  }

  await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, processOne));
  if (jobId && resolvedItems.length > 0) {
    state.phase = `Writing ${resolvedItems.length} CIDs to database…`;
    await batchUpdateItemIpfsCids({ jobId, items: resolvedItems });

    if (syncToRecords) {
      state.phase = "Syncing CIDs to NFT records…";
      await syncGeneratedItemsToNftRecords(jobId);
    }
  }

  state.status = "done";
  state.phase = `Complete — ${state.resolved} CIDs resolved${state.skipped > 0 ? `, ${state.skipped} skipped (not yet assigned)` : ""}`;
  await saveTask(refreshId, 'refresh_cids', { status: 'done', phase: state.phase, progress: state.progress, total: state.total, meta: { resolved: state.resolved, skipped: state.skipped } });
  }
}
