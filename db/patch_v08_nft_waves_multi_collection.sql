-- nft_waves was a single global 7-wave schedule shared by every collection,
-- mirroring the same limitation nft_records had before patch_v07: once
-- multiple collections (Test1/Test2/Test3, and future ones) coexist, a
-- single set of 7 wave rows can't independently track each collection's own
-- schedule/pricing/reveal/treasury state. Splits nft_waves per-collection
-- the same way nft_records already is -- on-chain contract calls are NOT
-- touched by this migration: the deployed contract is a single fixed-supply
-- instance with no per-collection addressing, so it only ever knows "wave
-- number" regardless of which collection's DB row is being mirrored.

ALTER TABLE nft_waves ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES nft_collections(id);

-- Backfill: assign the existing 7 template rows to the first collection with
-- synced nft_records (arbitrary but low-stakes -- no wave has ever had a
-- sale or schedule set, sold_count is 0 for all 7), then clone a fresh copy
-- of those same 7 rows for every OTHER collection that has synced records.
-- The old single-column UNIQUE(wave_number) constraint MUST be dropped
-- before this backfill runs -- while it's still active, cloning wave_number
-- 1..7 for a second collection collides with it, and an untargeted
-- ON CONFLICT DO NOTHING silently swallows every clone insert with no error
-- (caught live: only one collection ended up with wave rows).
ALTER TABLE nft_waves DROP CONSTRAINT IF EXISTS nft_waves_wave_number_key;
ALTER TABLE nft_waves DROP CONSTRAINT IF EXISTS uq_nft_waves_collection_wave;
ALTER TABLE nft_waves ADD CONSTRAINT uq_nft_waves_collection_wave UNIQUE (collection_id, wave_number);

DO $$
DECLARE
  v_first_collection UUID;
  v_coll RECORD;
BEGIN
  SELECT DISTINCT collection_id INTO v_first_collection
  FROM nft_records WHERE collection_id IS NOT NULL
  ORDER BY collection_id LIMIT 1;

  IF v_first_collection IS NOT NULL THEN
    UPDATE nft_waves SET collection_id = v_first_collection WHERE collection_id IS NULL;

    FOR v_coll IN
      SELECT DISTINCT nr.collection_id
      FROM nft_records nr
      WHERE nr.collection_id IS NOT NULL AND nr.collection_id <> v_first_collection
    LOOP
      INSERT INTO nft_waves (
        collection_id, wave_number, name, stage_id, quantity, cumulative_start, cumulative_end,
        default_price_eth, sale_method, status, notes, sold_count, price_locked, wave_closed,
        unsold_strategy, whitelist_required, reveal_strategy, max_per_wallet
      )
      SELECT
        v_coll.collection_id, w.wave_number, w.name, w.stage_id, w.quantity, w.cumulative_start, w.cumulative_end,
        w.default_price_eth, w.sale_method, w.status, w.notes, 0, FALSE, FALSE,
        w.unsold_strategy, w.whitelist_required, w.reveal_strategy, w.max_per_wallet
      FROM nft_waves w
      WHERE w.collection_id = v_first_collection
      ON CONFLICT (collection_id, wave_number) DO NOTHING;
    END LOOP;
  END IF;
END $$;

-- v_wave_schedule_status: expose collection_id so the route can scope it.
DROP VIEW IF EXISTS v_wave_schedule_status;
CREATE VIEW v_wave_schedule_status AS
SELECT
  wave_number,
  collection_id,
  name AS wave_name,
  CASE
    WHEN is_revealed THEN 'revealed'
    WHEN wave_closed THEN 'closed'
    WHEN wave_start_triggered AND NOT wave_end_triggered THEN 'active'
    WHEN scheduled_start IS NOT NULL AND scheduled_start <= now() AND (scheduled_end IS NULL OR scheduled_end > now()) THEN 'active'
    WHEN scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL AND scheduled_end <= now() THEN 'closed'
    WHEN scheduled_start IS NOT NULL THEN 'scheduled'
    ELSE 'pending'
  END AS status,
  scheduled_start,
  scheduled_end,
  reveal_scheduled_at,
  wave_start_triggered,
  wave_end_triggered,
  wave_reveal_triggered,
  is_revealed,
  wave_revealed_at,
  sold_count,
  (SELECT COUNT(*)::integer FROM nft_records nr
    WHERE nr.on_chain_wave_num = w.wave_number AND nr.collection_id = w.collection_id AND nr.token_id IS NOT NULL) AS minted_count,
  quantity,
  reveal_strategy,
  CASE
    WHEN wave_start_triggered AND NOT wave_end_triggered THEN 'started'
    WHEN wave_end_triggered THEN 'ended'
    WHEN scheduled_start IS NOT NULL AND scheduled_start <= now() AND (scheduled_end IS NULL OR scheduled_end > now()) THEN 'active_window'
    WHEN scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL AND scheduled_end <= now() THEN 'pending_end'
    WHEN scheduled_start IS NOT NULL AND scheduled_start > now() THEN 'pending_start'
    WHEN wave_reveal_triggered THEN 'revealed'
    WHEN reveal_scheduled_at IS NOT NULL AND reveal_scheduled_at > now() THEN 'pending_reveal'
    ELSE 'not_scheduled'
  END AS auto_trigger_state
FROM nft_waves w
ORDER BY wave_number;

-- ── nft_wave_get_all: now scoped to one collection ──────────────────────────
DROP FUNCTION IF EXISTS public.nft_wave_get_all();
CREATE OR REPLACE FUNCTION public.nft_wave_get_all(p_collection_id uuid)
 RETURNS json
 LANGUAGE sql
 STABLE
AS $function$
  SELECT json_agg(
    json_build_object(
      'id', w.id, 'waveNumber', w.wave_number, 'name', w.name,
      'quantity', w.quantity, 'defaultPriceEth', w.default_price_eth,
      'saleMethod', w.sale_method, 'scheduledStart', w.scheduled_start,
      'scheduledEnd', w.scheduled_end, 'revealScheduledAt', w.reveal_scheduled_at,
      'tierPrices', w.tier_prices,
      'soldCount', (SELECT COUNT(*) FROM nft_records nr
                     WHERE nr.wave_id = w.id AND nr.token_id IS NOT NULL
                       AND nr.mint_type IN ('free', 'paid')),
      'treasuryPendingCount', (SELECT COUNT(*) FROM nft_records nr
                                JOIN lookup_values lv ON nr.delivery_status_id = lv.id
                               WHERE nr.wave_id = w.id
                                 AND lv.category = 'delivery_status'
                                 AND lv.code = 'treasury_pending'),
      'reservedCount', (SELECT COUNT(*) FROM nft_records nr
                         JOIN lookup_values lv ON nr.delivery_status_id = lv.id
                        WHERE nr.wave_id = w.id
                          AND lv.category = 'delivery_status'
                          AND lv.code = 'reserved'),
      'treasuryWalletCount', (SELECT COUNT(*) FROM nft_records nr
                               WHERE nr.wave_id = w.id AND nr.mint_type = 'treasury'
                                 AND nr.token_id IS NOT NULL),
      'priceLocked', w.price_locked, 'waveClosed', w.wave_closed,
      'waveRevealed', w.is_revealed, 'waveRevealedAt', w.wave_revealed_at,
      'waveRevealUri', w.wave_reveal_uri, 'closeAction', w.close_action,
      'status', CASE
        WHEN w.is_revealed                                                           THEN 'revealed'
        WHEN w.wave_closed                                                           THEN 'closed'
        WHEN w.wave_start_triggered AND NOT w.wave_end_triggered                     THEN 'active'
        WHEN w.scheduled_start IS NOT NULL AND w.scheduled_start <= NOW()
          AND (w.scheduled_end IS NULL OR w.scheduled_end > NOW())                  THEN 'active'
        WHEN w.scheduled_start IS NOT NULL AND w.scheduled_end IS NOT NULL
          AND w.scheduled_end <= NOW()                                               THEN 'closed'
        WHEN w.scheduled_start IS NOT NULL                                           THEN 'scheduled'
        ELSE 'pending'
      END,
      'auctionListingId', w.auction_listing_id,
      'waveStartTriggered', w.wave_start_triggered, 'waveEndTriggered', w.wave_end_triggered,
      'waveRevealTriggered', w.wave_reveal_triggered, 'syncedAt', w.synced_at,
      'nftCount', (SELECT COUNT(*) FROM nft_records nr WHERE nr.wave_id = w.id),
      'unsoldStrategy', w.unsold_strategy,
      'revealStrategy', w.reveal_strategy,
      'whitelistRequired', w.whitelist_required,
      'maxPerWallet', w.max_per_wallet
    ) ORDER BY w.wave_number
  )
  FROM nft_waves w
  WHERE w.collection_id = p_collection_id;
$function$;

-- ── nft_wave_get: now scoped to one collection ──────────────────────────────
DROP FUNCTION IF EXISTS public.nft_wave_get(integer);
CREATE OR REPLACE FUNCTION public.nft_wave_get(p_wave_num integer, p_collection_id uuid)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE v_result JSON;
BEGIN
  IF p_wave_num < 1 OR p_wave_num > 7 THEN
    RAISE EXCEPTION 'Wave number must be 1-7' USING ERRCODE = 'P0001';
  END IF;
  SELECT json_build_object(
    'id', w.id, 'waveNum', w.wave_number, 'name', w.name,
    'quantity', w.quantity, 'defaultPriceEth', w.default_price_eth,
    'saleMethod', w.sale_method, 'scheduledStart', w.scheduled_start,
    'scheduledEnd', w.scheduled_end, 'revealScheduledAt', w.reveal_scheduled_at,
    'tierPrices', w.tier_prices, 'soldCount', w.sold_count,
    'priceLocked', w.price_locked, 'waveClosed', w.wave_closed,
    'waveRevealed', w.is_revealed, 'waveRevealedAt', w.wave_revealed_at,
    'closeAction', w.close_action, 'status', w.status,
    'auctionListingId', w.auction_listing_id,
    'waveStartTriggered', w.wave_start_triggered, 'waveEndTriggered', w.wave_end_triggered,
    'waveRevealTriggered', w.wave_reveal_triggered, 'syncedAt', w.synced_at,
    'maxPerWallet', w.max_per_wallet
  ) INTO v_result FROM nft_waves w WHERE w.wave_number = p_wave_num AND w.collection_id = p_collection_id;
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Wave % not found', p_wave_num USING ERRCODE = 'P0002';
  END IF;
  RETURN v_result;
END;
$function$;

-- ── nft_wave_update_artist_config ────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.nft_wave_update_artist_config(integer, character varying, character varying, integer, boolean);
CREATE OR REPLACE FUNCTION public.nft_wave_update_artist_config(p_wave_num integer, p_name character varying, p_wallet character varying, p_royalty_bps integer, p_is_edition boolean, p_collection_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  UPDATE nft_waves
  SET artist_name = p_name, artist_wallet = p_wallet,
      artist_royalty_bps = p_royalty_bps, is_artist_edition = p_is_edition
  WHERE wave_number = p_wave_num AND collection_id = p_collection_id;
$function$;

-- ── nft_wave_update_flash_sale ───────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.nft_wave_update_flash_sale(integer, boolean, numeric);
CREATE OR REPLACE FUNCTION public.nft_wave_update_flash_sale(p_wave_num integer, p_is_flash boolean, p_discount_pct numeric, p_collection_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  UPDATE nft_waves SET is_flash_sale = p_is_flash, flash_discount_pct = p_discount_pct
  WHERE wave_number = p_wave_num AND collection_id = p_collection_id;
$function$;

-- ── nft_wave_update_holder_priority ──────────────────────────────────────────
DROP FUNCTION IF EXISTS public.nft_wave_update_holder_priority(integer, timestamp with time zone, timestamp with time zone);
CREATE OR REPLACE FUNCTION public.nft_wave_update_holder_priority(p_wave_num integer, p_start timestamp with time zone, p_end timestamp with time zone, p_collection_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  UPDATE nft_waves SET holder_priority_start = p_start, holder_priority_end = p_end
  WHERE wave_number = p_wave_num AND collection_id = p_collection_id;
$function$;

-- ── nft_wave_update_tier_prices ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.nft_wave_update_tier_prices(integer, jsonb);
CREATE OR REPLACE FUNCTION public.nft_wave_update_tier_prices(p_wave_num integer, p_tier_prices jsonb, p_collection_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  UPDATE nft_waves SET tier_prices = p_tier_prices WHERE wave_number = p_wave_num AND collection_id = p_collection_id;
$function$;

-- ── nft_treasury_nfts_list: scoped to one collection ─────────────────────────
DROP FUNCTION IF EXISTS public.nft_treasury_nfts_list();
CREATE OR REPLACE FUNCTION public.nft_treasury_nfts_list(p_collection_id uuid)
 RETURNS json
 LANGUAGE sql
AS $function$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.token_id), '[]')
  FROM (
    SELECT r.id, r.token_id, r.owner_address AS owner_wallet,
      r.on_chain_wave_num AS origin_wave, w.name AS wave_name,
      r.rarity_tier, r.metadata_uri, r.minted_at, r.last_tx_hash
    FROM nft_records r
    LEFT JOIN nft_waves w ON w.wave_number = r.on_chain_wave_num AND w.collection_id = r.collection_id
    WHERE r.collection_id = p_collection_id
      AND r.on_chain_wave_num IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM nft_waves nw
        WHERE nw.wave_number = r.on_chain_wave_num
          AND nw.collection_id = p_collection_id
          AND nw.close_action = 'treasury'
          AND LOWER(nw.treasury_recipient) = LOWER(r.owner_address)
      )
    ORDER BY r.token_id
  ) t;
$function$;

-- ── nft_holder_snapshot: scoped to one collection ────────────────────────────
DROP FUNCTION IF EXISTS public.nft_holder_snapshot(integer);
CREATE OR REPLACE FUNCTION public.nft_holder_snapshot(p_up_to_wave_num integer, p_collection_id uuid)
 RETURNS text[]
 LANGUAGE sql
AS $function$
  SELECT ARRAY_AGG(DISTINCT LOWER(owner_address))
  FROM nft_records
  WHERE on_chain_wave_num < p_up_to_wave_num
    AND collection_id = p_collection_id
    AND owner_address IS NOT NULL
    AND is_burned = FALSE;
$function$;
