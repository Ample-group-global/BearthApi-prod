-- nft_traits.rarity_weight is NUMERIC, but nft_gen_trait_update,
-- nft_gen_trait_create, and nft_gen_traits_list all still declared it as
-- integer (both as a parameter and in RETURNS TABLE). Any manual tier/weight
-- edit through the RarityModal dropdown for a trait with a fractional
-- weight (which is now every trait, since the artist's Excel weights are
-- fractional — 2.78%, 5.56%, 2.99%, etc.) failed outright: either
-- "invalid input syntax for type integer" when the fractional value was
-- passed in, or "structure of query does not match function result type"
-- on the RETURNING clause even for a whole-number update. Confirmed live
-- through the browser: picking "Common" for a "Rare" trait silently failed
-- and the dropdown snapped back to "Rare". Same fix pattern as patch_v05.

-- Postgres refuses CREATE OR REPLACE when the return type changes (integer
-- -> numeric here) — DROP first, matching the pattern from patch_v04.
DROP FUNCTION public.nft_gen_trait_update(p_id uuid, p_name character varying, p_file_path text, p_storage_provider character varying, p_rarity_tier character varying, p_is_active boolean, p_rarity_weight integer);
DROP FUNCTION public.nft_gen_traits_list(p_layer_id uuid);
DROP FUNCTION public.nft_gen_trait_create(p_layer_id uuid, p_name character varying, p_file_path text, p_rarity_tier character varying, p_storage_provider character varying, p_rarity_weight integer);

CREATE OR REPLACE FUNCTION public.nft_gen_trait_update(p_id uuid, p_name character varying DEFAULT NULL::character varying, p_file_path text DEFAULT NULL::text, p_storage_provider character varying DEFAULT NULL::character varying, p_rarity_tier character varying DEFAULT NULL::character varying, p_is_active boolean DEFAULT NULL::boolean, p_rarity_weight numeric DEFAULT NULL::numeric)
 RETURNS TABLE(id uuid, name character varying, rarity_weight numeric, rarity_tier character varying, is_active boolean, updated_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE v_tier_weight INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_traits WHERE nft_traits.id = p_id) THEN
    RAISE EXCEPTION 'Trait not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_rarity_weight IS NOT NULL AND p_rarity_weight <= 0 THEN
    RAISE EXCEPTION 'rarity_weight must be > 0 — use is_active=false to disable a trait' USING ERRCODE = 'P0001';
  END IF;

  IF p_rarity_tier IS NOT NULL THEN
    v_tier_weight := CASE lower(p_rarity_tier)
      WHEN 'legendary' THEN 3
      WHEN 'epic'      THEN 10
      WHEN 'rare'      THEN 30
      WHEN 'common'    THEN 100
      ELSE 100
    END;
  END IF;

  RETURN QUERY
  UPDATE nft_traits SET
    name             = COALESCE(NULLIF(trim(p_name), ''),      nft_traits.name),
    file_path        = COALESCE(NULLIF(trim(p_file_path), ''), nft_traits.file_path),
    storage_provider = COALESCE(p_storage_provider,            nft_traits.storage_provider),
    rarity_tier      = COALESCE(lower(p_rarity_tier),          nft_traits.rarity_tier),
    rarity_weight     = COALESCE(p_rarity_weight, v_tier_weight, nft_traits.rarity_weight),
    is_active        = COALESCE(p_is_active,                   nft_traits.is_active),
    updated_at       = NOW()
  WHERE nft_traits.id = p_id
  RETURNING nft_traits.id, nft_traits.name, nft_traits.rarity_weight, nft_traits.rarity_tier, nft_traits.is_active, nft_traits.updated_at;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_trait_create(p_layer_id uuid, p_name character varying, p_file_path text, p_rarity_tier character varying DEFAULT NULL::character varying, p_storage_provider character varying DEFAULT 'filebase'::character varying, p_rarity_weight numeric DEFAULT NULL::numeric)
 RETURNS TABLE(id uuid, name character varying, rarity_weight numeric, rarity_tier character varying, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE v_weight NUMERIC;
BEGIN
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Trait name is required' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM nft_layers WHERE nft_layers.id = p_layer_id) THEN
    RAISE EXCEPTION 'Layer not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_rarity_weight IS NOT NULL AND p_rarity_weight <= 0 THEN
    RAISE EXCEPTION 'rarity_weight must be > 0 — use is_active=false to disable a trait' USING ERRCODE = 'P0001';
  END IF;

  v_weight := COALESCE(p_rarity_weight, CASE COALESCE(lower(p_rarity_tier), 'common')
    WHEN 'legendary' THEN 3
    WHEN 'epic'      THEN 10
    WHEN 'rare'      THEN 30
    WHEN 'common'    THEN 100
    ELSE 100
  END);

  RETURN QUERY
  INSERT INTO nft_traits (layer_id, name, file_path, storage_provider, rarity_weight, rarity_tier)
  VALUES (
    p_layer_id, trim(p_name), NULLIF(trim(COALESCE(p_file_path, '')), ''),
    COALESCE(p_storage_provider, 'filebase'),
    v_weight,
    lower(p_rarity_tier)
  )
  ON CONFLICT ON CONSTRAINT uq_nft_traits_layer_filepath DO UPDATE SET
    name             = EXCLUDED.name,
    storage_provider = EXCLUDED.storage_provider,
    is_active        = TRUE,
    updated_at       = NOW()
  RETURNING nft_traits.id, nft_traits.name, nft_traits.rarity_weight, nft_traits.rarity_tier, nft_traits.created_at;
END;
$function$
;

-- nft_gen_traits_list — read path; same output type had the identical
-- mismatch (only rarity_weight int -> numeric changed; logic unchanged from
-- the live function — verified against pg_get_functiondef before editing).
CREATE OR REPLACE FUNCTION public.nft_gen_traits_list(p_layer_id uuid)
 RETURNS TABLE(id uuid, layer_id uuid, name character varying, file_path text, storage_provider character varying, rarity_weight numeric, rarity_tier character varying, is_active boolean, rarity_pct numeric, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE v_total_weight NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_layers WHERE nft_layers.id = p_layer_id) THEN
    RAISE EXCEPTION 'Layer not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(SUM(t.rarity_weight), 0) INTO v_total_weight
  FROM nft_traits t WHERE t.layer_id = p_layer_id AND t.is_active = TRUE;
  RETURN QUERY
  SELECT
    nt.id, nt.layer_id, nt.name, nt.file_path, nt.storage_provider,
    nt.rarity_weight, nt.rarity_tier, nt.is_active,
    CASE WHEN v_total_weight > 0
      THEN ROUND(nt.rarity_weight::NUMERIC / v_total_weight * 100, 2)
      ELSE 0::NUMERIC
    END AS rarity_pct,
    nt.created_at
  FROM nft_traits nt
  WHERE nt.layer_id = p_layer_id
  ORDER BY nt.rarity_weight DESC;
END;
$function$
;
