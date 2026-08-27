import pool, { getClient } from "../pool";
import { toCamel } from "../utils/camel";
import { ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { getS3Client } from "../clients/s3";

const FILEBASE_GATEWAY = "https://amgbearth.myfilebase.com/ipfs";
const SYNC_CONCURRENCY = 100;

// ── Collections ──────────────────────────────────────────────────────────────

export async function listCollections(params: { limit?: number; offset?: number }) {
  const { limit = 50, offset = 0 } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_collections_list($1, $2)",
    [limit, offset],
  );
  return { collections: toCamel(rows), total: Number(rows[0]?.total_count ?? 0), limit, offset };
}

export async function getCollection(id: string) {
  const { rows } = await pool.query("SELECT nft_gen_collection_get($1::uuid) AS data", [id]);
  return rows[0]?.data ?? null;
}

export async function createCollection(params: {
  name: string; description?: string; symbol?: string; network?: string;
  royaltyBps?: number; creatorWallet?: string; formatWidth?: number; formatHeight?: number;
  smoothing?: boolean; bgGenerate?: boolean; bgStaticColor?: string;
  shuffleOutput?: boolean; dnaTolerance?: number; createdBy?: string;
  supply?: number; nameFormat?: string; formatType?: string; conflictRules?: unknown[];
}) {
  const {
    name, description, symbol, network, royaltyBps, creatorWallet,
    formatWidth, formatHeight, smoothing, bgGenerate, bgStaticColor,
    shuffleOutput, dnaTolerance, createdBy, supply, nameFormat, formatType, conflictRules,
  } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_collection_create($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
    [
      name, description ?? null, symbol ?? null, network ?? "eth", royaltyBps ?? 0, creatorWallet ?? null,
      formatWidth ?? null, formatHeight ?? null, smoothing ?? false, bgGenerate ?? false, bgStaticColor ?? null,
      shuffleOutput ?? true, dnaTolerance ?? 10000, createdBy ?? null,
      supply ?? null, nameFormat ?? null, formatType ?? null,
      conflictRules ? JSON.stringify(conflictRules) : null,
    ],
  );
  return rows[0] ?? null;
}

export async function updateCollection(id: string, params: {
  name?: string; description?: string; symbol?: string; network?: string;
  royaltyBps?: number; creatorWallet?: string; formatWidth?: number; formatHeight?: number;
  smoothing?: boolean; bgGenerate?: boolean; bgStaticColor?: string;
  shuffleOutput?: boolean; dnaTolerance?: number; baseUri?: string; status?: string;
  supply?: number; nameFormat?: string; formatType?: string; conflictRules?: unknown[];
}) {
  const {
    name, description, symbol, network, royaltyBps, creatorWallet,
    formatWidth, formatHeight, smoothing, bgGenerate, bgStaticColor,
    shuffleOutput, dnaTolerance, baseUri, status, supply, nameFormat, formatType, conflictRules,
  } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_collection_update($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)",
    [
      id, name ?? null, description ?? null, symbol ?? null, network ?? null, royaltyBps ?? null, creatorWallet ?? null,
      formatWidth ?? null, formatHeight ?? null, smoothing ?? null, bgGenerate ?? null, bgStaticColor ?? null,
      shuffleOutput ?? null, dnaTolerance ?? null, baseUri ?? null, status ?? null,
      supply ?? null, nameFormat ?? null, formatType ?? null,
      conflictRules ? JSON.stringify(conflictRules) : null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteCollection(id: string) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_collection_delete($1::uuid)", [id]);
  return rows[0] ?? null;
}

// ── Layers ───────────────────────────────────────────────────────────────────

export async function listLayers(collectionId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_layers_list($1::uuid)",
    [collectionId],
  );
  return toCamel(rows);
}

export async function getLayer(id: string) {
  const { rows } = await pool.query("SELECT nft_gen_layer_get($1::uuid) AS data", [id]);
  return rows[0]?.data ?? null;
}

export async function createLayer(params: {
  collectionId: string; name: string; displayName?: string;
  bypassDna?: boolean; sortOrder?: number; layerRarityPct?: number;
}) {
  const { collectionId, name, displayName, bypassDna, sortOrder, layerRarityPct } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_layer_create($1, $2, $3, $4, $5, $6)",
    [collectionId, name, displayName ?? null, bypassDna ?? false, sortOrder ?? null, layerRarityPct ?? 100],
  );
  return rows[0] ?? null;
}

export async function updateLayer(id: string, params: {
  name?: string; displayName?: string;
  bypassDna?: boolean; sortOrder?: number; layerRarityPct?: number; isActive?: boolean;
}) {
  const { name, displayName, bypassDna, sortOrder, layerRarityPct, isActive } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_layer_update($1, $2, $3, $4, $5, $6, $7)",
    [id, name ?? null, displayName ?? null, bypassDna ?? null, sortOrder ?? null, layerRarityPct ?? null, isActive ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteLayer(id: string) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_layer_delete($1::uuid)", [id]);
  return rows[0] ?? null;
}

export async function reconcileLayers(collectionId: string, activeNames: string[]) {
  const { rows } = await pool.query(
    "SELECT nft_gen_layers_reconcile($1::uuid, $2::text[]) AS deactivated",
    [collectionId, activeNames],
  );
  return { deactivated: Number(rows[0]?.deactivated ?? 0) };
}

export async function reorderLayers(collectionId: string, items: { id: string; sortOrder: number }[]) {
  const ids = items.map(i => i.id);
  const orders = items.map(i => i.sortOrder);
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_layers_reorder($1::uuid, $2::uuid[], $3::int[])",
    [collectionId, ids, orders],
  );
  return rows[0] ?? null;
}

// ── Traits ───────────────────────────────────────────────────────────────────

export async function listTraits(layerId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_traits_list($1::uuid)",
    [layerId],
  );
  return toCamel(rows);
}

export async function createTrait(params: {
  layerId: string; name: string; filePath: string | null;
  rarityTier?: string; storageProvider?: string; rarityWeight?: number;
}) {
  const { layerId, name, filePath, rarityTier, storageProvider, rarityWeight } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_trait_create($1, $2, $3, $4, $5, $6)",
    [layerId, name, filePath, rarityTier ?? null, storageProvider ?? "filebase", rarityWeight ?? null],
  );
  return rows[0] ?? null;
}

// Layer-folder sync used to call createTrait() once per file over HTTP, then
// (after a first fix) once per file over a single held connection — for a real
// layer set (200+ traits) that's still 200+ sequential round-trips to Railway's
// remote Postgres, each ~200-300ms, adding up to over a minute. This does the
// whole layer as ONE set-based INSERT via nft_gen_traits_create_bulk (db/patch_v56),
// cutting sync time from tens of seconds to under a second per layer (confirmed
// live 2026-08-17: user reported "Save & Continue" feeling stuck; the per-trait
// round-trip count, not HTTP overhead, was the real bottleneck).
export async function createTraitsBulk(
  layerId: string,
  traits: Array<{ name: string; filePath: string; rarityTier?: string; storageProvider?: string; rarityWeight?: number }>,
) {
  const payload = traits.map((t) => ({
    name: t.name,
    file_path: t.filePath,
    rarity_tier: t.rarityTier ?? null,
    storage_provider: t.storageProvider ?? "filebase",
    rarity_weight: t.rarityWeight ?? null,
  }));
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_traits_create_bulk($1, $2::jsonb)",
    [layerId, JSON.stringify(payload)],
  );
  return rows;
}

export async function updateTrait(id: string, params: {
  name?: string; filePath?: string; storageProvider?: string;
  rarityTier?: string; isActive?: boolean; rarityWeight?: number;
}) {
  const { name, filePath, storageProvider, rarityTier, isActive, rarityWeight } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_trait_update($1, $2, $3, $4, $5, $6, $7)",
    [id, name ?? null, filePath ?? null, storageProvider ?? null, rarityTier ?? null, isActive ?? null, rarityWeight ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteTrait(id: string) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_trait_delete($1::uuid)", [id]);
  return rows[0] ?? null;
}

export async function reconcileTraits(layerId: string, activeFilePaths: string[]) {
  const { rows } = await pool.query(
    "SELECT nft_gen_traits_reconcile($1::uuid, $2::text[]) AS deactivated",
    [layerId, activeFilePaths],
  );
  return { deactivated: Number(rows[0]?.deactivated ?? 0) };
}

// Applies artist-supplied display names to this layer's active traits, matched
// positionally against the artist's trait Excel (row order = file order, both
// sorted the same numeric-aware way traits are shown elsewhere in the UI).
// Traits otherwise default to their raw file stem (e.g. "1-16") — this is the
// only path that replaces that with the real name (e.g. "Luna Head").
// Throws if the counts don't match rather than silently mismapping names.
export async function applyTraitNamesFromExcel(layerId: string, names: string[]) {
  const { rows: traits } = await pool.query(
    `SELECT id, file_path FROM nft_traits WHERE layer_id = $1::uuid AND is_active = true`,
    [layerId],
  );
  if (traits.length !== names.length) {
    throw new Error(
      `Trait count mismatch for this layer: ${traits.length} active trait(s) in the DB vs ${names.length} row(s) in the Excel sheet. Refusing to apply names — fix the mismatch first.`,
    );
  }
  const stem = (filePath: string | null) => {
    if (!filePath) return "";
    const base = filePath.split("/").pop() ?? filePath;
    return base.replace(/\.[^.]+$/, "");
  };
  traits.sort((a, b) =>
    stem(a.file_path).localeCompare(stem(b.file_path), undefined, { numeric: true, sensitivity: "base" }),
  );

  const client = await getClient();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < traits.length; i++) {
      await client.query(`UPDATE nft_traits SET name = $1 WHERE id = $2::uuid`, [names[i], traits[i].id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { updated: traits.length };
}

// ── Generation Jobs ──────────────────────────────────────────────────────────

export async function createJob(params: { collectionId: string; editionSize: number; createdBy?: string }) {
  const { collectionId, editionSize, createdBy } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_job_create($1::uuid, $2, $3)",
    [collectionId, editionSize, createdBy ?? null],
  );
  return rows[0] ?? null;
}

export async function getJob(id: string) {
  const { rows } = await pool.query("SELECT nft_gen_job_get($1::uuid) AS data", [id]);
  return rows[0]?.data ?? null;
}

export async function startJob(id: string) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_job_start($1::uuid)", [id]);
  return rows[0] ?? null;
}

export async function updateJobProgress(id: string, progress: number) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_job_update_progress($1::uuid, $2)", [id, progress]);
  return rows[0] ?? null;
}

export async function completeJob(id: string) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_job_complete($1::uuid)", [id]);
  return rows[0] ?? null;
}

export async function failJob(id: string, errorMessage: string) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_job_fail($1::uuid, $2)", [id, errorMessage]);
  return rows[0] ?? null;
}

export async function deleteFailedJob(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "DELETE FROM nft_generation_jobs WHERE id = $1::uuid AND status = 'failed'",
    [id]
  );
  return (rowCount ?? 0) > 0;
}

// ── Generated Items ──────────────────────────────────────────────────────────

export async function insertItemsBatch(params: {
  jobId: string;
  items: Array<{
    editionNumber: number;
    dnaHash: string;
    score?: number;
    rank?: number;
    tier?: string;
    traits?: Array<{ traitType: string; traitValue: string; rarityTier?: string }>;
  }>;
}) {
  const { jobId, items } = params;
  if (!items.length) return [];

  const client = await getClient();
  try {
    await client.query("BEGIN");

    // ON CONFLICT DO NOTHING → idempotent: safe to retry the same batch
    await client.query(
      `INSERT INTO nft_generated_items (job_id, edition_number, dna_hash, metadata_json)
       SELECT $1::uuid, t.edition_number, t.dna_hash, t.metadata_json::jsonb
       FROM UNNEST($2::int[], $3::text[], $4::text[]) AS t(edition_number, dna_hash, metadata_json)
       ON CONFLICT (job_id, edition_number) DO NOTHING`,
      [
        jobId,
        items.map(i => i.editionNumber),
        items.map(i => i.dnaHash),
        items.map(i => JSON.stringify({ score: i.score, rank: i.rank, tier: i.tier })),
      ],
    );

    // SELECT all items for this batch — includes rows that conflicted (already existed)
    const { rows: itemRows } = await client.query(
      `SELECT id, edition_number FROM nft_generated_items
       WHERE job_id = $1::uuid AND edition_number = ANY($2::int[])`,
      [jobId, items.map(i => i.editionNumber)],
    );

    const editionToId: Record<number, string> = {};
    for (const row of itemRows) editionToId[row.edition_number] = row.id;

    const itemIds: string[] = [];
    const traitTypes: string[] = [];
    const traitValues: string[] = [];
    const rarityTiers: (string | null)[] = [];

    for (const item of items) {
      const itemId = editionToId[item.editionNumber];
      if (!itemId) continue;
      for (const t of (item.traits ?? [])) {
        itemIds.push(itemId);
        traitTypes.push(t.traitType);
        traitValues.push(t.traitValue);
        rarityTiers.push(t.rarityTier ?? null);
      }
    }

    if (itemIds.length > 0) {
      // ON CONFLICT DO NOTHING → idempotent: uq_nft_item_traits_item_trait (item_id, trait_type)
      await client.query(
        `INSERT INTO nft_item_traits (item_id, trait_type, trait_value, rarity_tier)
         SELECT t.item_id::uuid, t.trait_type, t.trait_value, t.rarity_tier
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[]) AS t(item_id, trait_type, trait_value, rarity_tier)
         ON CONFLICT (item_id, trait_type) DO NOTHING`,
        [itemIds, traitTypes, traitValues, rarityTiers],
      );

      // Backfill trait_id where still missing — safe to re-run (WHERE trait_id IS NULL)
      const allItemUuids = itemRows.map(r => r.id);
      await client.query(
        `UPDATE nft_item_traits nit
         SET trait_id    = nt.id,
             rarity_tier = nt.rarity_tier
         FROM nft_generated_items gi,
              nft_generation_jobs j,
              nft_layers nl,
              nft_traits nt
         WHERE nit.item_id = ANY($1::uuid[])
           AND gi.id        = nit.item_id
           AND j.id         = gi.job_id
           AND nl.collection_id = j.collection_id
           AND nl.display_name  = nit.trait_type
           AND nt.layer_id  = nl.id
           AND nt.name      = nit.trait_value
           AND nit.trait_id IS NULL`,
        [allItemUuids],
      );
    }

    await client.query("COMMIT");
    return itemRows.map(r => ({ itemId: r.id as string, editionNumber: r.edition_number as number }));
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { });
    throw e;
  } finally {
    client.release();
  }
}

export async function listItems(params: { jobId: string; limit?: number; offset?: number }) {
  const { jobId, limit = 50, offset = 0 } = params;
  const { rows } = await pool.query(`
    SELECT
      gi.id, gi.edition_number, gi.dna_hash, gi.image_path,
      gi.ipfs_image_cid, gi.ipfs_metadata_cid,
      (gi.metadata_json->>'rank')::int       AS rank,
      (gi.metadata_json->>'score')::numeric  AS score,
      gi.metadata_json->>'tier'              AS tier,
      COUNT(DISTINCT it.id)                  AS trait_count,
      gi.created_at,
      COUNT(*) OVER()                        AS total_count
    FROM nft_generated_items gi
    LEFT JOIN nft_item_traits it ON it.item_id = gi.id
    WHERE gi.job_id = $1::uuid
    GROUP BY gi.id
    ORDER BY gi.edition_number ASC
    LIMIT $2 OFFSET $3
  `, [jobId, limit, offset]);
  return { items: toCamel(rows), total: Number(rows[0]?.total_count ?? 0), limit, offset };
}

export async function updateItemIpfs(id: string, params: { ipfsImageCid: string; ipfsMetadataCid: string }) {
  const { ipfsImageCid, ipfsMetadataCid } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_item_update_ipfs($1::uuid, $2, $3)",
    [id, ipfsImageCid, ipfsMetadataCid],
  );
  return rows[0] ?? null;
}

export async function getRarityReport(jobId: string) {
  const { rows } = await pool.query("SELECT nft_gen_rarity_report($1::uuid) AS data", [jobId]);
  return rows[0]?.data ?? null;
}

// ── Upload Batches ───────────────────────────────────────────────────────────

export async function createUploadBatch(params: {
  jobId: string; provider: string; batchType: string; totalItems: number;
}) {
  const { jobId, provider, batchType, totalItems } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_upload_batch_create($1::uuid, $2, $3, $4)",
    [jobId, provider, batchType, totalItems],
  );
  return rows[0] ?? null;
}

export async function getUploadBatch(id: string) {
  const { rows } = await pool.query("SELECT nft_gen_upload_batch_get($1::uuid) AS data", [id]);
  return rows[0]?.data ?? null;
}

export async function startUploadBatch(id: string) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_upload_batch_start($1::uuid)", [id]);
  return rows[0] ?? null;
}

export async function progressUploadBatch(id: string, uploadedItems: number) {
  const { rows } = await pool.query(
    "SELECT * FROM nft_gen_upload_batch_progress($1::uuid, $2)",
    [id, uploadedItems],
  );
  return rows[0] ?? null;
}

export async function completeUploadBatch(id: string) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_upload_batch_complete($1::uuid)", [id]);
  return rows[0] ?? null;
}

export async function failUploadBatch(id: string, error: string) {
  const { rows } = await pool.query("SELECT * FROM nft_gen_upload_batch_fail($1::uuid, $2)", [id, error]);
  return rows[0] ?? null;
}

export async function batchUpdateItemIpfsCids(params: {
  jobId: string;
  items: Array<{ editionNumber: number; ipfsImageCid: string; ipfsMetadataCid: string; imagePath?: string }>;
}) {
  const { jobId, items } = params;
  if (!items.length) return 0;
  const hasImagePaths = items.some(i => i.imagePath);
  const { rows } = await pool.query(
    "SELECT nft_gen_items_batch_update_ipfs($1::uuid, $2::int[], $3::text[], $4::text[], $5::text[]) AS updated",
    [
      jobId,
      items.map(i => i.editionNumber),
      items.map(i => i.ipfsImageCid),
      items.map(i => i.ipfsMetadataCid),
      hasImagePaths ? items.map(i => i.imagePath ?? null) : null,
    ],
  );
  return rows[0]?.updated ?? 0;
}

// ── Sync generated items → nft_records ───────────────────────────────────────
// Promotes exported items into nft_records for wave selling. Pass a jobId
// to promote just that job's items, or omit it to sweep every job — when
// sweeping all jobs, DISTINCT ON + created_at DESC picks the most recent
// item per edition_number in case more than one job produced that edition.
export async function syncGeneratedItemsToNftRecords(jobId?: string, force = false): Promise<number> {
  // nft_records is meant to hold exactly one collection's data at a time —
  // syncing a second collection into it used to just upsert on top,
  // silently leaving a mix of two collections' rows behind. Block that
  // unless the caller explicitly opts in with force (e.g. after
  // deliberately clearing nft_records to switch to a new collection).
  if (jobId && !force) {
    const { rows: existingJobRows } = await pool.query(
      `SELECT DISTINCT gi.job_id FROM nft_records nr
       JOIN nft_generated_items gi ON gi.id = nr.generated_item_id
       WHERE nr.generated_item_id IS NOT NULL AND gi.job_id <> $1::uuid`,
      [jobId],
    );
    if (existingJobRows.length) {
      const { rows: collRows } = await pool.query(
        `SELECT DISTINCT c.name FROM nft_generated_items gi
         JOIN nft_generation_jobs j ON j.id = gi.job_id
         JOIN nft_collections c ON c.id = j.collection_id
         WHERE gi.job_id = ANY($1::uuid[])`,
        [existingJobRows.map(r => r.job_id)],
      );
      const names = collRows.map(r => r.name).join(", ") || "a different collection";
      throw new Error(`nft_records already holds data for ${names}. Clear it first (or pass force) before syncing a different collection.`);
    }
  }

  const { rows: lookupRows } = await pool.query(
    `SELECT id, category, code FROM lookup_values
     WHERE (category = 'nft_stage'       AND code = 'genesis')
        OR (category = 'delivery_status' AND code = 'pending')`,
  );
  const genesisStageId = lookupRows.find((r: { category: string; code: string }) => r.category === 'nft_stage' && r.code === 'genesis')?.id as string | undefined;
  const pendingStatusId = lookupRows.find((r: { category: string; code: string }) => r.category === 'delivery_status' && r.code === 'pending')?.id as string | undefined;

  if (!genesisStageId || !pendingStatusId) {
    throw new Error("Required lookup values (nft_stage:genesis, delivery_status:pending) not found");
  }

  const blindBoxUri = await getBlindboxUri();

  // Traits live in nft_item_traits, not on nft_generated_items.metadata_json —
  // that column only ever stores the rarity summary ({rank, tier, score}),
  // never an "attributes" array. Reading meta.attributes here always found
  // nothing and silently wrote an empty traits object for every single row.
  const { rows: items } = jobId
    ? await pool.query(
        `SELECT gi.id AS generated_item_id, gi.edition_number, gi.ipfs_image_cid, gi.ipfs_metadata_cid, gi.metadata_json,
           COALESCE(jsonb_object_agg(nit.trait_type, nit.trait_value) FILTER (WHERE nit.trait_type IS NOT NULL), '{}'::jsonb) AS traits
         FROM nft_generated_items gi
         LEFT JOIN nft_item_traits nit ON nit.item_id = gi.id
         WHERE gi.job_id = $1::uuid
           AND gi.ipfs_image_cid    IS NOT NULL
           AND gi.ipfs_metadata_cid IS NOT NULL
         GROUP BY gi.id, gi.edition_number, gi.ipfs_image_cid, gi.ipfs_metadata_cid, gi.metadata_json
         ORDER BY gi.edition_number ASC`,
        [jobId],
      )
    : await pool.query(
        `SELECT DISTINCT ON (gi.edition_number)
           gi.id AS generated_item_id, gi.edition_number, gi.ipfs_image_cid, gi.ipfs_metadata_cid, gi.metadata_json,
           COALESCE(jsonb_object_agg(nit.trait_type, nit.trait_value) FILTER (WHERE nit.trait_type IS NOT NULL), '{}'::jsonb) AS traits
         FROM nft_generated_items gi
         LEFT JOIN nft_item_traits nit ON nit.item_id = gi.id
         WHERE gi.ipfs_image_cid    IS NOT NULL
           AND gi.ipfs_metadata_cid IS NOT NULL
         GROUP BY gi.id, gi.edition_number, gi.ipfs_image_cid, gi.ipfs_metadata_cid, gi.metadata_json, gi.created_at
         ORDER BY gi.edition_number ASC, gi.created_at DESC`,
      );

  if (!items.length) return 0;

  const rows = items.map(item => {
    const meta = typeof item.metadata_json === 'string'
      ? JSON.parse(item.metadata_json) as Record<string, unknown>
      : (item.metadata_json as Record<string, unknown>) ?? {};
    // Mirror the real Filebase metadata.json's attributes array, which
    // includes Rarity Score/Rank/Tier as regular trait_type/value entries
    // alongside the physical traits — not just the separate typed columns
    // below (those exist for SQL querying/filtering; this keeps `traits`
    // itself a complete match of what's actually on IPFS).
    const traits: Record<string, string> = { ...(item.traits ?? {}) };
    if (meta.score != null) traits['Rarity Score'] = Number(meta.score).toFixed(2);
    if (meta.rank != null) traits['Rarity Rank'] = `#${meta.rank}`;
    if (meta.tier != null) traits['Rarity Tier'] = String(meta.tier);
    return {
      serial_number: `#${item.edition_number}`,
      stage_id: genesisStageId,
      delivery_status_id: pendingStatusId,
      generated_item_id: item.generated_item_id,
      image_ipfs_hash: item.ipfs_image_cid,
      metadata_ipfs_hash: item.ipfs_metadata_cid,
      metadata_uri: `ipfs://${item.ipfs_metadata_cid}`,
      blind_box_uri: blindBoxUri,
      traits,
      rarity_score: meta.score != null ? Number(meta.score) : null,
      rarity_rank: meta.rank != null ? Number(meta.rank) : null,
      rarity_tier: meta.tier != null ? String(meta.tier).toLowerCase() : null,
    };
  });

  const { rowCount } = await pool.query(
    `INSERT INTO nft_records (serial_number, stage_id, delivery_status_id, generated_item_id, image_ipfs_hash, metadata_ipfs_hash, metadata_uri, blind_box_uri, traits, rarity_score, rarity_rank, rarity_tier)
     SELECT
       x.serial_number,
       x.stage_id::uuid,
       x.delivery_status_id::uuid,
       x.generated_item_id::uuid,
       x.image_ipfs_hash,
       x.metadata_ipfs_hash,
       x.metadata_uri,
       x.blind_box_uri,
       x.traits,
       x.rarity_score,
       x.rarity_rank,
       x.rarity_tier
     FROM json_to_recordset($1::json) AS x(
       serial_number text, stage_id text, delivery_status_id text, generated_item_id text,
       image_ipfs_hash text, metadata_ipfs_hash text, metadata_uri text, blind_box_uri text, traits jsonb,
       rarity_score numeric, rarity_rank int, rarity_tier text
     )
     ON CONFLICT (serial_number) DO UPDATE SET
       image_ipfs_hash    = EXCLUDED.image_ipfs_hash,
       metadata_ipfs_hash = EXCLUDED.metadata_ipfs_hash,
       metadata_uri       = EXCLUDED.metadata_uri,
       generated_item_id  = COALESCE(EXCLUDED.generated_item_id, nft_records.generated_item_id),
       blind_box_uri      = COALESCE(EXCLUDED.blind_box_uri, nft_records.blind_box_uri),
       traits             = EXCLUDED.traits,
       rarity_score       = COALESCE(EXCLUDED.rarity_score, nft_records.rarity_score),
       rarity_rank        = COALESCE(EXCLUDED.rarity_rank,  nft_records.rarity_rank),
       rarity_tier        = COALESCE(EXCLUDED.rarity_tier,  nft_records.rarity_tier),
       updated_at         = NOW()`,
    [JSON.stringify(rows)],
  );

  return rowCount ?? items.length;
}

// ── Sync directly from a Filebase bucket ─────────────────────────────────────

async function filebaseHead(bucket: string, key: string): Promise<string | null> {
  try {
    const r = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return r.Metadata?.cid ?? null;
  } catch { return null; }
}

async function filebaseGetJson(
  bucket: string, key: string,
): Promise<{ cid: string | null; body: Record<string, unknown> }> {
  try {
    const r = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const cid = r.Metadata?.cid ?? null;
    const text = await r.Body?.transformToString();
    return { cid, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  } catch { return { cid: null, body: {} }; }
}

// The blindbox placeholder is shared, collection-independent infra — not
// artist data — so it always lives in one fixed shared bucket, never a
// per-collection export bucket. Gateway URLs are content-addressed by CID,
// so which bucket pinned it never matters to whatever reads blind_box_uri
// downstream — only this lookup needs to agree on where to find it, and
// every caller must resolve it exactly the same way. Config-driven, no
// hardcoded bucket literal; a genuine miss just means no blindbox URL this
// sync, never a blocked sync.
async function getBlindboxUri(): Promise<string | null> {
  const bucket = process.env.FILEBASE_ASSETS_BUCKET || process.env.FILEBASE_LAYERS_BUCKET;
  if (!bucket) return null;
  const cid = await filebaseHead(bucket, "AssetBlindbox/bearthblindboximage1.png");
  return cid ? `${FILEBASE_GATEWAY}/${cid}` : null;
}

function parseFilebaseTraits(json: Record<string, unknown>): Record<string, unknown> {
  const raw = (json.attributes ?? json.traits ?? {}) as unknown;
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      (raw as Record<string, unknown>[]).map(a => [a.trait_type ?? a.traitType, a.value ?? a.traitValue]),
    );
  }
  return (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
}

export async function syncFromFilebaseBucket(bucket: string): Promise<{ synced: number; skipped: number }> {
  const { rows: lv } = await pool.query(
    `SELECT id, code FROM lookup_values
     WHERE (category = 'nft_stage' AND code = 'genesis')
        OR (category = 'delivery_status' AND code = 'pending')`,
  );
  const genesisStageId = lv.find(r => r.code === "genesis")?.id as string | undefined;
  const pendingStatusId = lv.find(r => r.code === "pending")?.id as string | undefined;
  if (!genesisStageId || !pendingStatusId) throw new Error("Required lookup values not found");

  const blindUri = await getBlindboxUri();

  const imageKeys: string[] = [];
  let listToken: string | undefined;
  do {
    const r = await getS3Client().send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: "images/", MaxKeys: 1000, ContinuationToken: listToken,
    }));
    imageKeys.push(
      ...(r.Contents?.filter(o => !o.Key!.endsWith("/") && o.Key!.endsWith(".png")).map(o => o.Key!) ?? []),
    );
    listToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (listToken);

  const editions = imageKeys
    .map(k => parseInt(k.replace("images/", "").replace(".png", ""), 10))
    .filter(n => !isNaN(n) && n > 0)
    .sort((a, b) => a - b);

  type ItemRow = {
    serial_number: string; stage_id: string; delivery_status_id: string;
    image_ipfs_hash: string; metadata_ipfs_hash: string; metadata_uri: string;
    blind_box_uri: string | null; traits: Record<string, unknown>;
    rarity_score: number | null; rarity_rank: number | null; rarity_tier: string | null;
  };

  const fbRows: ItemRow[] = [];
  let skipped = 0;

  for (let i = 0; i < editions.length; i += SYNC_CONCURRENCY) {
    const batch = editions.slice(i, i + SYNC_CONCURRENCY);
    const results = await Promise.all(batch.map(async n => {
      const [imageCid, { cid: metaCid, body: metaJson }] = await Promise.all([
        filebaseHead(bucket, `images/${n}.png`),
        filebaseGetJson(bucket, `metadata/${n}.json`),
      ]);
      if (!imageCid || !metaCid) return null;
      return {
        serial_number: `#${n}`,
        stage_id: genesisStageId,
        delivery_status_id: pendingStatusId,
        image_ipfs_hash: imageCid,
        metadata_ipfs_hash: metaCid,
        metadata_uri: `ipfs://${metaCid}`,
        blind_box_uri: blindUri,
        traits: parseFilebaseTraits(metaJson),
        rarity_score: metaJson.rarity_score != null ? Number(metaJson.rarity_score) : null,
        rarity_rank: metaJson.rarity_rank != null ? Number(metaJson.rarity_rank) : null,
        rarity_tier: metaJson.rarity_tier != null ? String(metaJson.rarity_tier) : null,
      } as ItemRow;
    }));
    for (const r of results) { if (r) fbRows.push(r); else skipped++; }
  }

  if (!fbRows.length) return { synced: 0, skipped };

  let totalSynced = 0;
  for (let i = 0; i < fbRows.length; i += 2000) {
    const chunk = fbRows.slice(i, i + 2000);
    const { rowCount } = await pool.query(
      `INSERT INTO nft_records
         (serial_number, stage_id, delivery_status_id, image_ipfs_hash, metadata_ipfs_hash,
          metadata_uri, blind_box_uri, traits, rarity_score, rarity_rank, rarity_tier)
       SELECT x.serial_number, x.stage_id::uuid, x.delivery_status_id::uuid,
              x.image_ipfs_hash, x.metadata_ipfs_hash, x.metadata_uri, x.blind_box_uri, x.traits,
              x.rarity_score, x.rarity_rank, x.rarity_tier
       FROM json_to_recordset($1::json) AS x(
         serial_number text, stage_id text, delivery_status_id text,
         image_ipfs_hash text, metadata_ipfs_hash text, metadata_uri text,
         blind_box_uri text, traits jsonb,
         rarity_score numeric, rarity_rank int, rarity_tier text
       )
       ON CONFLICT (serial_number) DO UPDATE SET
         image_ipfs_hash    = EXCLUDED.image_ipfs_hash,
         metadata_ipfs_hash = EXCLUDED.metadata_ipfs_hash,
         metadata_uri       = EXCLUDED.metadata_uri,
         blind_box_uri      = EXCLUDED.blind_box_uri,
         traits             = EXCLUDED.traits,
         rarity_score       = COALESCE(EXCLUDED.rarity_score, nft_records.rarity_score),
         rarity_rank        = COALESCE(EXCLUDED.rarity_rank,  nft_records.rarity_rank),
         rarity_tier        = COALESCE(EXCLUDED.rarity_tier,  nft_records.rarity_tier),
         updated_at         = NOW()`,
      [JSON.stringify(chunk)],
    );
    totalSynced += rowCount ?? 0;
  }

  return { synced: totalSynced, skipped };
}

export async function fetchLayerImage(rel: string): Promise<Buffer | null> {
  if (!rel || rel.includes('..') || rel.startsWith('/')) return null;

  const bucket = process.env.FILEBASE_LAYERS_BUCKET || 'bearth-layers';
  try {
    const resp = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: rel }));
    if (!resp.Body) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

function thumbKeyFor(rel: string, size: number): string {
  return `_thumbs/${size}/${rel}`;
}

export async function uploadLayerImage(rel: string, buf: Buffer): Promise<void> {
  const ext = rel.split('.').pop()?.toLowerCase() ?? '';
  const bucket = process.env.FILEBASE_LAYERS_BUCKET || 'bearth-layers';
  await getS3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: rel,
    Body: buf,
    ContentType: MIME_MAP[ext] ?? 'image/png',
  }));
}

// Generates the display thumbnail once, at upload time, from the buffer
// already in memory (no extra S3 round-trip to re-fetch the original) and
// stores it durably in S3 next to the source. This is what makes Organize/
// Preview loads fast for anything uploaded from here on — no per-request
// resize, no in-process cache that's lost on every restart.
const THUMB_SIZE = 200;
export async function uploadLayerImageWithThumb(rel: string, buf: Buffer): Promise<void> {
  const bucket = process.env.FILEBASE_LAYERS_BUCKET || 'bearth-layers';
  const thumbBuf = await sharp(buf).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside' }).png().toBuffer().catch(() => null);
  await Promise.all([
    uploadLayerImage(rel, buf),
    thumbBuf
      ? getS3Client().send(new PutObjectCommand({ Bucket: bucket, Key: thumbKeyFor(rel, THUMB_SIZE), Body: thumbBuf, ContentType: 'image/png' }))
      : Promise.resolve(),
  ]);
}

// Organize/Preview only ever display these at a few hundred px. Tries the
// pre-generated thumbnail first (fast S3 GetObject, no resize work at all —
// this is what uploadLayerImageWithThumb produces going forward). Falls back
// to resizing the original on demand for anything uploaded before this
// existed, and self-heals by writing the result back to S3 so it's a
// persistent thumb from then on — no manual backfill needed, and nothing
// breaks for pre-existing collections in the meantime.
const thumbMemCache = new Map<string, Buffer>();
export async function fetchLayerThumb(rel: string, size = THUMB_SIZE): Promise<Buffer | null> {
  const cacheKey = `${size}:${rel}`;
  const mem = thumbMemCache.get(cacheKey);
  if (mem) return mem;

  const persisted = await fetchLayerImage(thumbKeyFor(rel, size));
  if (persisted) {
    thumbMemCache.set(cacheKey, persisted);
    return persisted;
  }

  const full = await fetchLayerImage(rel);
  if (!full) return null;
  try {
    const thumb = await sharp(full).resize(size, size, { fit: 'inside' }).png().toBuffer();
    thumbMemCache.set(cacheKey, thumb);
    const bucket = process.env.FILEBASE_LAYERS_BUCKET || 'bearth-layers';
    getS3Client().send(new PutObjectCommand({ Bucket: bucket, Key: thumbKeyFor(rel, size), Body: thumb, ContentType: 'image/png' })).catch(() => {});
    return thumb;
  } catch {
    return full; // fall back to original if it isn't a decodable image
  }
}
