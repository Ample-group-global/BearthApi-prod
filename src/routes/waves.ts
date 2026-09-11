import { Router } from "express";
import pool from "../pool";
import { requireAdmin } from "../adminAuth";
import { _syncRevealedMetadata } from "../services/reveal.service";
import { contractSetWaveSchedule } from "../services/contract.service";
import { logger } from "../logger";

const router = Router();

router.get("/public", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.wave_number, w.name, w.sale_method, w.default_price_eth, w.quantity
         FROM nft_waves w
         JOIN nft_collections c ON c.id = w.collection_id
        WHERE c.symbol = 'BRTEST1'
        ORDER BY w.wave_number`,
    );
    res.json({
      waves: rows.map((r) => ({
        waveNumber: Number(r.wave_number),
        name: r.name as string,
        saleMethod: r.sale_method as string,
        priceEth: r.default_price_eth !== null ? Number(r.default_price_eth) : 0,
        qty: Number(r.quantity),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      defaultPriceEth,
      saleMethod,
      scheduledStart,
      scheduledEnd,
      status,
      notes,
      clearSchedule,
      revealScheduledAt,
      tierPrices,
      unsoldStrategy,
      whitelistRequired,
      revealStrategy,
      waveRevealUri,
    } = req.body as {
      defaultPriceEth?:    number | null;
      saleMethod?:         string | null;
      scheduledStart?:     string | null;
      scheduledEnd?:       string | null;
      status?:             string | null;
      notes?:              string | null;
      clearSchedule?:      boolean;
      revealScheduledAt?:  string | null;
      tierPrices?:         { legendary?: number; epic?: number; rare?: number; common?: number } | null;
      unsoldStrategy?:     'auto_treasury' | 'manual';
      whitelistRequired?:   boolean;
      revealStrategy?:     'auto' | 'manual';
      waveRevealUri?:      string | null;
    };

    if (!id) return res.status(400).json({ error: "Wave id required" });

    const { rows: existing } = await pool.query(
      "SELECT id, wave_number, collection_id, status, scheduled_start, scheduled_end, wave_closed, wave_start_triggered, wave_reveal_triggered, price_locked, is_revealed FROM nft_waves WHERE id = $1::uuid",
      [id],
    );
    if (!existing.length) return res.status(404).json({ error: "Wave not found" });

    const wave       = existing[0];
    const waveNumber = Number(wave.wave_number);
    const collectionId = wave.collection_id as string;
    const existingStart = wave.scheduled_start ? new Date(wave.scheduled_start) : null;
    const existingEnd   = wave.scheduled_end   ? new Date(wave.scheduled_end)   : null;
    const now = new Date();

    const updateStart  = clearSchedule === true || scheduledStart !== undefined;
    const updateEnd    = clearSchedule === true || scheduledEnd   !== undefined;
    const updateReveal = revealScheduledAt !== undefined;

    const startVal  = clearSchedule ? null : (scheduledStart ?? null);
    const endVal    = clearSchedule ? null : (scheduledEnd   ?? null);
    const revealVal = revealScheduledAt ?? null;

    const effectiveEnd = endVal ? new Date(endVal) : existingEnd;

    if (revealScheduledAt !== undefined && revealScheduledAt !== null && !wave.wave_closed) {
      return res.status(409).json({
        error: `Wave ${waveNumber} must be closed before a reveal date can be set.`,
      });
    }

    if (revealScheduledAt !== undefined && revealScheduledAt !== null && wave.wave_reveal_triggered) {
      return res.status(409).json({
        error: `Wave ${waveNumber} reveal is already in progress – the reveal date cannot be changed.`,
      });
    }
    if (revealScheduledAt !== undefined && revealScheduledAt !== null && wave.is_revealed) {
      return res.status(409).json({
        error: `Wave ${waveNumber} has already been revealed – the reveal date cannot be changed.`,
      });
    }

    if (defaultPriceEth !== undefined && defaultPriceEth !== null && wave.wave_closed) {
      return res.status(409).json({
        error: `Wave ${waveNumber} is closed – price cannot be changed after the wave ends.`,
      });
    }

    if (defaultPriceEth !== undefined && defaultPriceEth !== null && wave.price_locked) {
      return res.status(409).json({
        error: `Wave ${waveNumber} price is locked – the first sale has already occurred. Price cannot be changed.`,
      });
    }

    if (unsoldStrategy !== undefined && wave.is_revealed) {
      return res.status(409).json({
        error: `Wave ${waveNumber} has already been revealed – unsold strategy cannot be changed.`,
      });
    }
    if (unsoldStrategy !== undefined && !['auto_treasury', 'manual'].includes(unsoldStrategy)) {
      return res.status(400).json({ error: "unsoldStrategy must be 'auto_treasury' or 'manual'" });
    }

    if (revealStrategy !== undefined && wave.is_revealed) {
      return res.status(409).json({
        error: `Wave ${waveNumber} has already been revealed - reveal strategy cannot be changed.`,
      });
    }
    if (revealStrategy !== undefined && wave.wave_reveal_triggered) {
      return res.status(409).json({
        error: `Wave ${waveNumber} reveal is already in progress - reveal strategy cannot be changed.`,
      });
    }
    if (revealStrategy !== undefined && !['auto', 'manual'].includes(revealStrategy)) {
      return res.status(400).json({ error: "revealStrategy must be 'auto' or 'manual'" });
    }

    const isDateChange = clearSchedule === true ||
      (scheduledStart !== undefined && scheduledStart !== null) ||
      (scheduledEnd   !== undefined && scheduledEnd   !== null);
    if (isDateChange && existingStart && now >= existingStart) {
      return res.status(409).json({
        error: `Wave ${waveNumber} schedule is locked – the start date (${existingStart.toISOString()}) has already arrived. No date changes are allowed.`,
      });
    }

    if (waveNumber > 1 && (startVal || endVal)) {
      const { rows: prevRows } = await pool.query(
        "SELECT scheduled_end FROM nft_waves WHERE wave_number = $1 AND collection_id = $2",
        [waveNumber - 1, collectionId],
      );
      const prevEnd = prevRows[0]?.scheduled_end ? new Date(prevRows[0].scheduled_end) : null;
      if (!prevEnd) {
        return res.status(409).json({
          error: `Wave ${waveNumber - 1} has no schedule yet – set Wave ${waveNumber - 1} schedule first.`,
        });
      }
      if (startVal && new Date(startVal) <= prevEnd) {
        return res.status(409).json({
          error: `Wave ${waveNumber} start must be strictly after Wave ${waveNumber - 1} end (${prevEnd.toISOString()}).`,
        });
      }
    }

    if (endVal && waveNumber < 7) {
      const { rows: nextRows } = await pool.query(
        "SELECT scheduled_start FROM nft_waves WHERE wave_number = $1 AND collection_id = $2",
        [waveNumber + 1, collectionId],
      );
      const nextStart = nextRows[0]?.scheduled_start ? new Date(nextRows[0].scheduled_start) : null;
      if (nextStart && new Date(endVal) >= nextStart) {
        return res.status(409).json({
          error: `Wave ${waveNumber} end must be strictly before Wave ${waveNumber + 1} start (${nextStart.toISOString()}). Reschedule Wave ${waveNumber + 1} first.`,
        });
      }
    }

    if (startVal && endVal && new Date(startVal) >= new Date(endVal)) {
      return res.status(400).json({ error: "Scheduled end must be after start" });
    }

    if (revealScheduledAt && effectiveEnd && new Date(revealScheduledAt) <= effectiveEnd) {
      return res.status(400).json({ error: "Reveal date must be strictly after wave end date" });
    }

    await pool.query(
      `UPDATE nft_waves SET
        default_price_eth    = COALESCE($2, default_price_eth),
        sale_method          = COALESCE($3, sale_method),
        scheduled_start      = CASE WHEN $11::boolean THEN $4::timestamptz ELSE scheduled_start END,
        scheduled_end        = CASE WHEN $12::boolean THEN $5::timestamptz ELSE scheduled_end END,
        status               = COALESCE($6, status),
        notes                = COALESCE($7, notes),
        reveal_scheduled_at  = CASE WHEN $13::boolean THEN $8::timestamptz ELSE reveal_scheduled_at END,
        tier_prices          = COALESCE($9::jsonb, tier_prices),
        unsold_strategy      = COALESCE($10, unsold_strategy),
        whitelist_required   = COALESCE($14, whitelist_required),
        reveal_strategy      = COALESCE($15, reveal_strategy),
        wave_reveal_uri      = COALESCE($16, wave_reveal_uri),
        wave_start_triggered = CASE WHEN $11::boolean AND $4::timestamptz IS DISTINCT FROM scheduled_start THEN FALSE ELSE wave_start_triggered END,
        wave_end_triggered   = CASE WHEN $12::boolean AND $5::timestamptz IS DISTINCT FROM scheduled_end   THEN FALSE ELSE wave_end_triggered   END,
        wave_reveal_triggered= CASE WHEN $13::boolean AND $8::timestamptz IS DISTINCT FROM reveal_scheduled_at THEN FALSE ELSE wave_reveal_triggered END,
        updated_at           = NOW()
       WHERE id = $1::uuid`,
      [
        id,
        defaultPriceEth ?? null,
        saleMethod      ?? null,
        startVal,
        endVal,
        status          ?? null,
        notes           ?? null,
        revealVal,
        tierPrices ? JSON.stringify(tierPrices) : null,
        unsoldStrategy  ?? null,
        updateStart,
        updateEnd,
        updateReveal,
        whitelistRequired ?? null,
        revealStrategy    ?? null,
        waveRevealUri     ?? null,
      ],
    );

    if (startVal && endVal && new Date(startVal) > now && !wave.wave_closed &&
        process.env.ETH_RPC_URL && process.env.FIXED_PRIVATE_KEY) {
      const startUnix = Math.floor(new Date(startVal).getTime() / 1000);
      const endUnix   = Math.floor(new Date(endVal).getTime() / 1000);
      contractSetWaveSchedule(waveNumber, startUnix, endUnix, collectionId)
        .then(() => logger.info(`[waves-save] Wave ${waveNumber} schedule pre-pushed on-chain (start=${startVal})`))
        .catch(e => logger.warn(`[waves-save] Wave ${waveNumber} on-chain pre-push failed – auto-trigger will retry`, e));
    }


    await pool.query(
      `UPDATE nft_records
          SET wave_id    = $1::uuid,
              wave_num   = $2,
              updated_at = NOW()
        WHERE wave_id IS NULL
          AND collection_id = $3::uuid
          AND CAST(REPLACE(serial_number, '#', '') AS INTEGER)
              BETWEEN (SELECT cumulative_start FROM nft_waves WHERE id = $1::uuid)
                  AND (SELECT cumulative_end   FROM nft_waves WHERE id = $1::uuid)`,
      [id, waveNumber, collectionId],
    );
    const { rows } = await pool.query("SELECT * FROM nft_waves WHERE id = $1::uuid", [id]);
    res.json({ ok: true, wave: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post("/:waveNumber/sync-metadata", requireAdmin, async (req, res, next) => {
  try {
    const waveNum = parseInt(req.params.waveNumber, 10);
    if (isNaN(waveNum)) { res.status(400).json({ error: "Invalid wave number" }); return; }

    const { rows: mintedColl } = await pool.query<{ collection_id: string }>(
      `SELECT DISTINCT collection_id FROM nft_records WHERE on_chain_wave_num = $1 AND token_id IS NOT NULL AND collection_id IS NOT NULL LIMIT 1`,
      [waveNum],
    );
    if (!mintedColl.length) {
      res.status(404).json({ error: `No minted tokens found for wave ${waveNum}` });
      return;
    }
    await _syncRevealedMetadata(waveNum, mintedColl[0].collection_id);
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS synced FROM nft_records WHERE on_chain_wave_num = $1 AND collection_id = $2 AND image_ipfs_hash IS NOT NULL`,
      [waveNum, mintedColl[0].collection_id],
    );
    res.json({ ok: true, waveNumber: waveNum, synced: Number(rows[0].synced) });
  } catch (err) { next(err); }
});

export default router;
