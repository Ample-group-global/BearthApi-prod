import pool from "../pool";
import { toCamel } from "../utils/camel";

export async function listWaves() {
  const { rows } = await pool.query("SELECT * FROM wave_list()");
  return toCamel(rows);
}

export async function getWave(id: string) {
  const { rows } = await pool.query("SELECT * FROM wave_get($1::uuid)", [id]);
  return rows[0] ? toCamel([rows[0]])[0] : null;
}

export async function updateWave(id: string, params: {
  defaultPriceEth?: number | null;
  saleMethod?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  status?: string | null;
  notes?: string | null;
  clearSchedule?: boolean;
  revealScheduledAt?: string | null;
  tierPrices?: { legendary?: number; epic?: number; rare?: number; common?: number } | null;
}) {
  const { defaultPriceEth, saleMethod, scheduledStart, scheduledEnd, status, notes, clearSchedule, revealScheduledAt, tierPrices } = params;
  await pool.query(
    "SELECT * FROM wave_upsert($1::uuid, $2, $3, $4, $5, $6, $7, $8)",
    [id, defaultPriceEth ?? null, saleMethod ?? null, scheduledStart ?? null, scheduledEnd ?? null, status ?? null, notes ?? null, clearSchedule ?? false],
  );

  const hasScheduleChange = scheduledStart !== undefined || scheduledEnd !== undefined || clearSchedule;
  if (revealScheduledAt !== undefined || tierPrices !== undefined || hasScheduleChange) {
    await pool.query(
      `UPDATE nft_waves SET
         reveal_scheduled_at   = CASE WHEN $2::boolean THEN $3 ELSE reveal_scheduled_at END,
         tier_prices           = CASE WHEN $4::boolean THEN $5::jsonb ELSE tier_prices END,
         wave_start_triggered  = CASE WHEN $6::boolean AND $7 IS DISTINCT FROM scheduled_start THEN FALSE ELSE wave_start_triggered END,
         wave_end_triggered    = CASE WHEN $6::boolean AND $8 IS DISTINCT FROM scheduled_end   THEN FALSE ELSE wave_end_triggered   END,
         wave_reveal_triggered = CASE WHEN $2::boolean AND $3 IS DISTINCT FROM reveal_scheduled_at THEN FALSE ELSE wave_reveal_triggered END,
         updated_at            = NOW()
       WHERE id = $1::uuid`,
      [
        id,
        revealScheduledAt !== undefined,
        revealScheduledAt ?? null,
        tierPrices !== undefined,
        tierPrices ? JSON.stringify(tierPrices) : null,
        hasScheduleChange,
        scheduledStart ?? null,
        scheduledEnd ?? null,
      ],
    );
  }

  const { rows: fresh } = await pool.query("SELECT * FROM nft_waves WHERE id = $1::uuid", [id]);
  return fresh[0] ? toCamel([fresh[0]])[0] : null;
}
