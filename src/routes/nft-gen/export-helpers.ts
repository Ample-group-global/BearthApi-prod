import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import sharp from "sharp";
import pool from "../../pool";
import { getS3Client } from "../../clients/s3";

export interface EditionRow {
  edition_number: number;
  trait_type: string;
  trait_value: string;
  file_path: string | null;
  sort_order: number;
  rarity_score: string | null;
  rarity_rank: string | null;
  rarity_tier: string | null;
}

export type LayerRow = { trait_type: string; trait_value: string; file_path: string | null; sort_order: number };
export type EditionData = { layers: LayerRow[]; rarityScore: number; rarityRank: number; rarityTier: string };

export async function streamToBuffer(body: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const readable = body as Readable;
    readable.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

export function layersBucket(): string | null {
  return process.env.LAYERS_BUCKET || process.env.FILEBASE_LAYERS_BUCKET || null;
}

export function hasLayerSource(): boolean {
  return !!layersBucket();
}

export function makeLayerFetcher() {
  const pending = new Map<string, Promise<Buffer | null>>();
  const bucket = layersBucket();

  return async function fetchLayerBuf(filePath: string): Promise<Buffer | null> {
    if (pending.has(filePath)) return pending.get(filePath)!;
    if (!bucket) return null;

    const promise = (async (): Promise<Buffer | null> => {
      const attempts = 3;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: filePath }));
          return await streamToBuffer(res.Body);
        } catch (err) {
          if (attempt === attempts) {
            console.error(`[fetchLayerBuf] giving up on ${bucket}/${filePath} after ${attempts} attempts:`, err instanceof Error ? err.message : err);
            return null;
          }
          await new Promise(r => setTimeout(r, attempt * 300));
        }
      }
      return null;
    })().finally(() => pending.delete(filePath));

    pending.set(filePath, promise);
    return promise;
  };
}

export async function putObjectWithRetry(
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType: string,
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.warn(`[putObjectWithRetry] attempt ${attempt}/${attempts} failed for ${bucket}/${key}:`, err instanceof Error ? err.message : err);
      await new Promise(r => setTimeout(r, attempt * 500));
    }
  }
}

export function makeResizedFetcher(
  fetchLayerBuf: (fp: string) => Promise<Buffer | null>,
  width: number,
  height: number,
) {
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer | null>>();

  return async function fetchLayerResized(filePath: string): Promise<Buffer | null> {
    if (cache.has(filePath)) return cache.get(filePath)!;
    if (pending.has(filePath)) return pending.get(filePath)!;

    const promise = fetchLayerBuf(filePath)
      .then(async raw => {
        if (!raw) return null;
        const buf = await sharp(raw).resize(width, height, { kernel: sharp.kernel.lanczos3, fit: "fill" }).toBuffer();
        cache.set(filePath, buf);
        return buf;
      })
      .catch(() => null)
      .finally(() => pending.delete(filePath));

    pending.set(filePath, promise);
    return promise;
  };
}

export async function fetchEditionRows(jobId: string, offset: number, batchEnd: number): Promise<EditionRow[]> {
  const { rows } = await pool.query<EditionRow>(`
    SELECT gi.edition_number, nit.trait_type, nit.trait_value, nt.file_path, nl.sort_order,
           (gi.metadata_json->>'score') AS rarity_score,
           (gi.metadata_json->>'rank')  AS rarity_rank,
           (gi.metadata_json->>'tier')  AS rarity_tier
    FROM   nft_generated_items gi
    JOIN   nft_item_traits        nit ON nit.item_id        = gi.id
    JOIN   nft_generation_jobs    j   ON j.id               = gi.job_id
    JOIN   nft_layers             nl  ON nl.collection_id   = j.collection_id
                                    AND nl.display_name     = nit.trait_type
    LEFT JOIN nft_traits          nt  ON nt.layer_id        = nl.id
                                    AND nt.name             = nit.trait_value
    WHERE  gi.job_id = $1::uuid
      AND  gi.edition_number >  $2
      AND  gi.edition_number <= $3
    ORDER BY gi.edition_number,
             nl.sort_order
  `, [jobId, offset, batchEnd]);
  return rows;
}

export function applyNameFormat(fmt: string, id: number): string {
  return fmt.replace(/\{\{id\}\}/g, String(id));
}
