import pool from "../pool";
import { toCamel } from "../utils/camel";

const SORT_COLS: Record<string, string> = {
  serial_number:   "REGEXP_REPLACE(nr.serial_number, '[^0-9]', '', 'g')::INTEGER",
  token_id:        "nr.token_id",
  wave:            "w.wave_number",
  price_eth:       "COALESCE(nr.price_eth, w.default_price_eth)",
  stage:           "nr.stage_name",
  type:            "nr.type_name",
  is_revealed:     "nr.is_revealed",
  delivery_status: "nr.delivery_status_code",
  delivered_at:    "nr.delivered_at",
  rarity_score:    "nr.rarity_score",
  rarity_rank:     "nr.rarity_rank",
};

export async function listNft(params: {
  search?: string | null;
  ownerAddress?: string | null;
  deliveryStatusCode?: string | null;
  stageCode?: string | null;
  revealed?: boolean | null;
  minted?: boolean | null;
  waveId?: string | null;
  waveNumber?: number | null;
  mintedFrom?: string | null;
  mintedTo?: string | null;
  mintType?: string | null;
  rarityTier?: string | null;
  limit?: number;
  offset?: number;
  sortBy?: string | null;
  sortDir?: "asc" | "desc" | null;
}) {
  const {
    search = null, ownerAddress = null, deliveryStatusCode = null, stageCode = null,
    revealed = null, minted = null, waveId = null, waveNumber = null,
    mintedFrom = null, mintedTo = null, mintType = null, rarityTier = null,
    limit = 20, offset = 0, sortBy = null, sortDir = null,
  } = params;

  const sortCol = sortBy && SORT_COLS[sortBy] ? SORT_COLS[sortBy] : null;
  const dir     = sortDir === "desc" ? "DESC" : "ASC";
  const orderBy = sortCol
    ? `${sortCol} ${dir} NULLS LAST`
    : "nr.token_id ASC NULLS LAST, REGEXP_REPLACE(nr.serial_number, '[^0-9]', '', 'g')::INTEGER ASC";

  const { rows } = await pool.query(
    `SELECT
       nr.id, nr.serial_number, nr.token_id,
       nr.image_ipfs_hash, nr.metadata_uri, nr.blind_box_uri,
       nr.is_revealed, nr.revealed_at, nr.minted_at, nr.sold_at,
       nr.owner_address, nr.traits,
       nr.mint_tx_hash, nr.last_tx_hash,
       nr.mint_type,
       nr.rarity_tier, nr.rarity_score, nr.rarity_rank, nr.last_sale_price_eth,
       nr.notes, nr.delivered_at, nr.created_at, nr.updated_at,
       nr.stage_id, nr.stage_name,
       nr.nft_type_id, nr.type_name,
       nr.delivery_status_id, nr.delivery_status_code, nr.delivery_status_name,
       nr.wave_id, w.wave_number, w.name AS wave_name,
       w.quantity AS wave_quantity,
       w.starting_index AS wave_starting_index,
       w.scheduled_start AS wave_scheduled_start,
       w.scheduled_end   AS wave_scheduled_end,
       w.reveal_scheduled_at AS wave_reveal_scheduled_at,
       w.last_tx_hash AS wave_reveal_tx_hash,
       nr.price_eth,
       COALESCE(nr.price_eth, w.default_price_eth) AS effective_price_eth,
       COUNT(*) OVER() AS total_count
     FROM v_nft_records nr
     LEFT JOIN nft_waves w ON nr.wave_id = w.id
     WHERE ($1::TEXT IS NULL OR nr.serial_number ILIKE '%' || $1 || '%' OR nr.token_id::TEXT = $1)
       AND ($2::VARCHAR IS NULL OR (CASE WHEN $2 = 'treasury_wallet' THEN nr.delivery_status_code IN ('treasury_wallet','transferred') WHEN $2 = 'unsold' THEN nr.delivery_status_code IN ('reserved','treasury_pending') ELSE nr.delivery_status_code = $2 END))
       AND ($3::VARCHAR IS NULL OR nr.stage_code = $3)
       AND ($4::BOOLEAN IS NULL OR nr.is_revealed = $4)
       AND ($5::UUID IS NULL OR nr.wave_id = $5::UUID)
       AND ($6::INT IS NULL OR w.wave_number = $6)
       AND ($9::BOOLEAN IS NULL OR (nr.token_id IS NOT NULL) = $9)
       AND ($10::DATE IS NULL OR nr.minted_at >= $10::DATE)
       AND ($11::DATE IS NULL OR nr.minted_at <  ($11::DATE + interval '1 day'))
       AND ($12::VARCHAR IS NULL OR nr.mint_type = $12)
       AND ($13::VARCHAR IS NULL OR LOWER(nr.rarity_tier) = LOWER($13))
       AND ($14::TEXT IS NULL OR LOWER(nr.owner_address) = LOWER($14))
     ORDER BY ${orderBy}
     LIMIT $7 OFFSET $8`,
    [search, deliveryStatusCode, stageCode, revealed, waveId, waveNumber, limit, offset, minted, mintedFrom, mintedTo, mintType, rarityTier, ownerAddress],
  );
  const { rows: statsRows } = await pool.query(
    `SELECT
      COUNT(*)                                                                AS total_all,
      COUNT(*) FILTER (WHERE nr.delivery_status_code = 'pending')            AS pre_mint_count,
      COUNT(*) FILTER (WHERE nr.delivery_status_code = 'reserved')           AS reserved_count,
      COUNT(*) FILTER (WHERE nr.delivery_status_code = 'treasury_pending')      AS treasury_pending_count,
      COUNT(*) FILTER (WHERE nr.delivery_status_code IN ('treasury_wallet','transferred')) AS treasury_wallet_count,
      COUNT(*) FILTER (WHERE nr.token_id IS NOT NULL AND NOT nr.is_revealed) AS blind_count,
      COUNT(*) FILTER (WHERE nr.is_revealed AND nr.token_id IS NOT NULL)     AS revealed_count,
      COUNT(*) FILTER (WHERE nr.delivery_status_code = 'revealed')             AS customer_wallet_count,
      COUNT(*) FILTER (WHERE nr.token_id IS NOT NULL)                        AS minted_count,
      COUNT(*) FILTER (WHERE nr.delivery_status_code = 'sold')               AS sold_count,
      COUNT(*) FILTER (WHERE nr.delivery_status_code = 'delivered')          AS delivered_count
    FROM v_nft_records nr`,
  );
  const st = statsRows[0] ?? {};

  return {
    nftRecords:          toCamel(rows),
    total:               Number(rows[0]?.total_count      ?? 0),
    totalAll:            Number(st.total_all              ?? 0),
    preMintCount:        Number(st.pre_mint_count         ?? 0),
    reservedCount:       Number(st.reserved_count         ?? 0),
    treasuryPendingCount: Number(st.treasury_pending_count  ?? 0),
    treasuryWalletCount: Number(st.treasury_wallet_count  ?? 0),
    blindCount:          Number(st.blind_count            ?? 0),
    revealedCount:       Number(st.revealed_count         ?? 0),
    mintedCount:         Number(st.minted_count           ?? 0),
    soldCount:           Number(st.sold_count             ?? 0),
    customerWalletCount: Number(st.customer_wallet_count   ?? 0),
    deliveredCount:      Number(st.delivered_count        ?? 0),
    limit,
    offset,
  };
}

export async function getNft(id: string) {
  const { rows } = await pool.query("SELECT * FROM nft_get($1::uuid)", [id]);
  return rows[0] ?? null;
}

export async function createNft(params: {
  serialNumber: string; stageId: string;
  nftTypeId?: string; deliveryStatusId?: string; notes?: string;
}) {
  const { serialNumber, stageId, nftTypeId, deliveryStatusId, notes } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_create($1, $2, $3, $4, $5)",
    [serialNumber, stageId, nftTypeId ?? null, deliveryStatusId ?? null, notes ?? null],
  );
  return rows[0] ?? null;
}

export async function updateNft(id: string, params: {
  stageId?: string; nftTypeId?: string; deliveryStatusId?: string; notes?: string;
  waveId?: string; priceEth?: number | null; clearPriceEth?: boolean;
}) {
  const { stageId, nftTypeId, deliveryStatusId, notes, waveId, priceEth, clearPriceEth } = params;
  const { rows } = await pool.query(
    "SELECT * FROM nft_update($1::uuid, $2, $3, $4, $5, $6, $7, $8)",
    [id, stageId ?? null, nftTypeId ?? null, deliveryStatusId ?? null, notes ?? null, waveId ?? null, priceEth ?? null, clearPriceEth ?? false],
  );
  return rows[0] ?? null;
}

export async function confirmNftDelivery(id: string, deliveryStatusId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM nft_confirm_delivery($1::uuid, $2)",
    [id, deliveryStatusId],
  );
  return rows[0] ?? null;
}

export async function bulkCreateNft(records: Array<{
  serialNumber: string;
  stageId?: string | null; stageName?: string | null; stageCode?: string | null;
  nftTypeId?: string | null; nftTypeName?: string | null;
  deliveryStatusId?: string | null; deliveryStatusCode?: string | null;
  notes?: string | null;
}>) {
  // Pre-fetch lookup tables once
  const [stagesRes, typesRes, statusRes] = await Promise.all([
    pool.query("SELECT id, code, label AS name FROM lookup_values WHERE category = 'nft_stage'"),
    pool.query("SELECT id, code, label AS name FROM lookup_values WHERE category = 'nft_type'"),
    pool.query("SELECT id, code, label AS name FROM lookup_values WHERE category = 'delivery_status'"),
  ]);
  const stages   = stagesRes.rows;
  const types    = typesRes.rows;
  const statuses = statusRes.rows;

  const resolveId = (
    rows: Array<{ id: string; code: string; name: string }>,
    id?: string | null, name?: string | null, code?: string | null
  ): string | undefined => {
    if (id) return id;
    const q = (s: string) => s?.toLowerCase().trim();
    if (code) { const r = rows.find(x => q(x.code) === q(code)); if (r) return r.id; }
    if (name) { const r = rows.find(x => q(x.name) === q(name)); if (r) return r.id; }
    return undefined;
  };

  const results: Array<{ nftRecord: unknown; error?: string }> = [];
  for (const rec of records) {
    try {
      const stageId          = resolveId(stages,   rec.stageId,          rec.stageName,           rec.stageCode);
      const nftTypeId        = resolveId(types,    rec.nftTypeId,        rec.nftTypeName,          undefined);
      const deliveryStatusId = resolveId(statuses, rec.deliveryStatusId, undefined,                rec.deliveryStatusCode);
      const row = await createNft({
        serialNumber: rec.serialNumber,
        stageId:      stageId ?? "",
        nftTypeId,
        deliveryStatusId,
        notes: rec.notes ?? undefined,
      });
      results.push({ nftRecord: row });
    } catch (e: any) {
      results.push({ nftRecord: null, error: e.message ?? "Insert failed" });
    }
  }
  return results;
}
