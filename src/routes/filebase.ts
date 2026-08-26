import { Router } from "express";
import multer from "multer";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { requirePermission } from "../adminAuth";
import { getS3Client } from "../clients/s3";
import { pollCid } from "../utils/pollCid";
import { deleteObjectsChunked } from "../utils/deleteObjects";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── GET /api/filebase/buckets — list all buckets ──────────────────────────────

router.get("/buckets", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const result = await getS3Client().send(new ListBucketsCommand({}));
    const buckets = (result.Buckets ?? []).map(b => ({
      name:      b.Name,
      createdAt: b.CreationDate,
    }));
    res.json({ buckets });
  } catch (e) { next(e); }
});

// ── GET /api/filebase/buckets/:bucket — exists check ─────────────────────────

router.get("/buckets/:bucket", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { bucket } = req.params;
    try {
      await getS3Client().send(new HeadBucketCommand({ Bucket: bucket }));
      res.json({ bucket, exists: true });
    } catch (e) {
      const err = e as { name?: string };
      if (err.name === "NotFound" || err.name === "NoSuchBucket") {
        res.json({ bucket, exists: false });
        return;
      }
      throw e;
    }
  } catch (e) { next(e); }
});

// ── POST /api/filebase/buckets — create bucket ────────────────────────────────

router.post("/buckets", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { name, region } = req.body as { name?: string; region?: string };
    if (!name) { res.status(422).json({ error: "name is required." }); return; }

    await getS3Client().send(new CreateBucketCommand({ Bucket: name }));
    res.status(201).json({ name, region: region ?? "us-east-1" });
  } catch (e) { next(e); }
});

// ── POST /api/filebase/nft-upload/image ──────────────────────────────────────
// multipart/form-data: file (binary), bucket (string), key (string)

router.post("/nft-upload/image", upload.single("file"), async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const file   = req.file;
    const bucket = req.body.bucket as string | undefined;
    const key    = (req.body.key    as string | undefined) ?? file?.originalname;

    if (!file)   { res.status(422).json({ error: "file field is required." }); return; }
    if (!bucket) { res.status(422).json({ error: "bucket is required." }); return; }
    if (!key)    { res.status(422).json({ error: "key is required." }); return; }

    const s3 = getS3Client();
    await s3.send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        file.buffer,
      ContentType: file.mimetype,
    }));

    const cid = await pollCid(s3, bucket, key);

    res.status(201).json({ bucket, key, size: file.size, cid: cid || null });
  } catch (e) { next(e); }
});

// ── POST /api/filebase/nft-upload/metadata ────────────────────────────────────
// Body: { bucket: string, items: [{ key: string, content: string }] }

router.post("/nft-upload/metadata", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { bucket, items } = req.body as {
      bucket?: string;
      items?:  { key: string; content: string }[];
    };

    if (!bucket)        { res.status(422).json({ error: "bucket is required." }); return; }
    if (!items?.length) { res.status(422).json({ error: "items[] is required." }); return; }

    const s3 = getS3Client();
    const CONCURRENCY = 10;
    const results: { key: string; cid: string | null }[] = items.map(i => ({ key: i.key, cid: null }));
    let cursor = 0;

    async function worker() {
      while (cursor < items!.length) {
        const idx  = cursor++;
        const item = items![idx];

        await s3.send(new PutObjectCommand({
          Bucket:      bucket,
          Key:         item.key,
          Body:        item.content,
          ContentType: "application/json",
        }));

        results[idx].cid = (await pollCid(s3, bucket!, item.key)) || null;
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    res.json(results);
  } catch (e) { next(e); }
});

// ── GET /api/filebase/objects?bucket=&prefix= — list objects ──────────────────

router.get("/objects", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const bucket = req.query.bucket as string | undefined;
    const prefix = req.query.prefix as string | undefined;
    if (!bucket) { res.status(422).json({ error: "bucket query param is required." }); return; }

    const result = await getS3Client().send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 1000,
    }));

    const objects = (result.Contents ?? []).map(o => ({
      key:          o.Key,
      size:         o.Size,
      lastModified: o.LastModified,
      etag:         o.ETag,
    }));

    res.json({ bucket, count: objects.length, objects });
  } catch (e) { next(e); }
});

// ── DELETE /api/filebase/objects — delete a single object ─────────────────────
// Body: { bucket: string, key: string }

router.delete("/objects", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { bucket, key } = req.body as { bucket?: string; key?: string };
    if (!bucket) { res.status(422).json({ error: "bucket is required." }); return; }
    if (!key)    { res.status(422).json({ error: "key is required." }); return; }

    await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    res.json({ deleted: true, bucket, key });
  } catch (e) { next(e); }
});

// ── DELETE /api/filebase/objects/batch — delete multiple objects ───────────────
// Body: { bucket: string, keys: string[] }

router.delete("/objects/batch", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { bucket, keys } = req.body as { bucket?: string; keys?: string[] };
    if (!bucket)       { res.status(422).json({ error: "bucket is required." }); return; }
    if (!keys?.length) { res.status(422).json({ error: "keys[] is required." }); return; }

    const deleted = await deleteObjectsChunked(getS3Client(), bucket, keys);
    res.json({ deleted, bucket, total: keys.length });
  } catch (e) { next(e); }
});

export default router;
