-- Two related fixes to the collection <-> waves relationship:
--
-- 1. LOOSEN deletion: nft_waves.collection_id -> nft_collections was NO ACTION
--    (the implicit default from patch_v08's plain ADD COLUMN ... REFERENCES),
--    so deleting a collection failed outright once it had any wave rows.
--    Switch to CASCADE so a collection can always be deleted cleanly, waves
--    included -- matches nft_layers/nft_traits, which already cascade.
--
-- 2. TIGHTEN creation: previously nothing created a collection's 7 wave rows
--    automatically -- they only existed if someone manually ran a backfill/
--    clone step after the fact (patch_v08's DO block, and a manual session
--    backfill for the "Bearth V1" production collection on 2026-09-04).
--    Every new collection should be wave-ready the moment it's created, with
--    no separate step. Only applies when supply = 9999 (the standard
--    Fibonacci wave template's quantities only sum correctly for that
--    supply); a non-standard-supply collection is left with zero waves, same
--    as today, and can still have rows created manually via the Waves UI.

ALTER TABLE nft_waves DROP CONSTRAINT IF EXISTS nft_waves_collection_id_fkey;
ALTER TABLE nft_waves ADD CONSTRAINT nft_waves_collection_id_fkey
  FOREIGN KEY (collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.nft_gen_collection_create(p_name character varying, p_description text DEFAULT NULL::text, p_symbol character varying DEFAULT NULL::character varying, p_network character varying DEFAULT 'eth'::character varying, p_royalty_bps integer DEFAULT 0, p_creator_wallet text DEFAULT NULL::text, p_format_width integer DEFAULT 512, p_format_height integer DEFAULT 512, p_smoothing boolean DEFAULT false, p_bg_generate boolean DEFAULT false, p_bg_static_color character varying DEFAULT NULL::character varying, p_shuffle_output boolean DEFAULT true, p_dna_tolerance integer DEFAULT 10000, p_created_by uuid DEFAULT NULL::uuid, p_supply integer DEFAULT 100, p_name_format text DEFAULT '#{{id}}'::text, p_format_type text DEFAULT 'png'::text, p_conflict_rules jsonb DEFAULT '[]'::jsonb)
 RETURNS TABLE(id uuid, name character varying, status character varying, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Collection name is required' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO nft_collections (
    name, description, symbol, network, royalty_bps, creator_wallet,
    format_width, format_height, smoothing, bg_generate, bg_static_color,
    shuffle_output, dna_tolerance, created_by,
    supply, name_format, format_type, conflict_rules
  ) VALUES (
    trim(p_name), p_description, p_symbol, COALESCE(p_network, 'eth'),
    COALESCE(p_royalty_bps, 0), p_creator_wallet,
    COALESCE(p_format_width, 512), COALESCE(p_format_height, 512),
    COALESCE(p_smoothing, FALSE), COALESCE(p_bg_generate, FALSE), p_bg_static_color,
    COALESCE(p_shuffle_output, TRUE), COALESCE(p_dna_tolerance, 10000), p_created_by,
    COALESCE(p_supply, 100), COALESCE(p_name_format, '#{{id}}'), COALESCE(p_format_type, 'png'),
    COALESCE(p_conflict_rules, '[]'::jsonb)
  )
  RETURNING nft_collections.id INTO v_id;

  IF COALESCE(p_supply, 100) = 9999 THEN
    INSERT INTO nft_waves (
      collection_id, wave_number, name, stage_id, quantity, cumulative_start, cumulative_end,
      default_price_eth, sale_method, status, unsold_strategy, whitelist_required,
      reveal_strategy, max_per_wallet
    )
    SELECT
      v_id, w.wave_number, w.name, lv.id, w.quantity, w.cumulative_start, w.cumulative_end,
      w.default_price_eth, w.sale_method, 'upcoming', 'auto_treasury', TRUE,
      w.reveal_strategy, w.max_per_wallet
    FROM (VALUES
      (1, 'Genesis — Free Mint',   'genesis',   303,  1,    303,  NULL::numeric, 'free_mint',   'auto',   0),
      (2, 'Genesis — Fixed Price', 'genesis',   303,  304,  606,  0.0303,        'fixed_price', 'manual', 2),
      (3, 'Ascension',             'ascension', 606,  607,  1212, 0.114,         'fixed_price', 'auto',   0),
      (4, 'Odyssey',               'odyssey',   909,  1213, 2121, 0.382,         'fixed_price', 'auto',   0),
      (5, 'Awakening',             'awakening', 1515, 2122, 3636, 0.5,           'fixed_price', 'auto',   0),
      (6, 'Continuum',             'continuum', 2424, 3637, 6060, 0.618,         'fixed_price', 'auto',   0),
      (7, 'Eternity',              'eternity',  3939, 6061, 9999, 0.886,         'fixed_price', 'auto',   0)
    ) AS w(wave_number, name, stage_code, quantity, cumulative_start, cumulative_end, default_price_eth, sale_method, reveal_strategy, max_per_wallet)
    JOIN lookup_values lv ON lv.category = 'nft_stage' AND lv.code = w.stage_code;
  END IF;

  RETURN QUERY SELECT c.id, c.name, c.status, c.created_at FROM nft_collections c WHERE c.id = v_id;
END;
$function$;
