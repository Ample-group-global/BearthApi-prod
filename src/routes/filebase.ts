import { Router } from "express";
import multer from "multer";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requirePermission } from "../adminAuth";
import { getS3Client } from "../clients/s3";
import { pollCid } from "../utils/pollCid";
import { deleteObjectsChunked } from "../utils/deleteObjects";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

router.post("/buckets", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { name, region } = req.body as { name?: string; region?: string };
    if (!name) { res.status(422).json({ error: "name is required." }); return; }

    await getS3Client().send(new CreateBucketCommand({ Bucket: name }));
    res.status(201).json({ name, region: region ?? "us-east-1" });
  } catch (e) { next(e); }
});

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

router.get("/objects", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const bucket = req.query.bucket as string | undefined;
    const prefix = req.query.prefix as string | undefined;
    if (!bucket) { res.status(422).json({ error: "bucket query param is required." }); return; }

    const s3 = getS3Client();
    const objects: Array<{ key?: string; size?: number; lastModified?: Date; etag?: string }> = [];
    let continuationToken: string | undefined;
    do {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: continuationToken,
      }));
      for (const o of result.Contents ?? []) {
        objects.push({ key: o.Key, size: o.Size, lastModified: o.LastModified, etag: o.ETag });
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    res.json({ bucket, count: objects.length, objects });
  } catch (e) { next(e); }
});

router.post("/presigned-urls", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { bucket, keys } = req.body as { bucket?: string; keys?: string[] };
    if (!bucket) { res.status(422).json({ error: "bucket is required." }); return; }
    if (!Array.isArray(keys) || keys.length === 0) { res.status(422).json({ error: "keys array is required." }); return; }
    if (keys.length > 5000) { res.status(422).json({ error: "Max 5000 keys per request." }); return; }

    const keyList = keys;
    const s3 = getS3Client();
    const urls: Record<string, string> = {};
    const CONCURRENCY = 50;
    let cursor = 0;
    async function worker() {
      while (cursor < keyList.length) {
        const key = keyList[cursor++];
        urls[key] = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    res.json({ urls });
  } catch (e) { next(e); }
});

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
