-- rarity_tier should mean "the artist (or a manual pick) explicitly
-- classified this trait" — a NOT NULL DEFAULT 'common' column can't express
-- "never classified" at all, so every trait silently looked deliberately
-- "Common" the moment it was created, indistinguishable from one nobody
-- ever touched. That made trusting the stored value for display unsafe:
-- every existing trait already had *some* value, mostly the blanket default,
-- not a real artist choice.

ALTER TABLE nft_traits ALTER COLUMN rarity_tier DROP DEFAULT;
ALTER TABLE nft_traits ALTER COLUMN rarity_tier DROP NOT NULL;

-- One-time cleanup: every trait currently sitting at the old blanket default
-- has that value because nothing ever set it, not because someone chose
-- Common — there was no code path before this fix that could persist a real
-- artist/manual "Common" choice (nft_gen_trait_update already preserved the
-- existing value when none was passed; only the two *_create paths below
-- ever wrote the literal default). Null them out so display correctly falls
-- back to live computation until a real classification is made.
UPDATE nft_traits SET rarity_tier = NULL WHERE rarity_tier = 'common';

-- ── nft_gen_trait_create — stop forcing 'common' into storage ──────────────
-- The weight-fallback CASE below keeps its own internal 'common' branch —
-- that's a reasonable starting *weight* for a brand-new trait with zero
-- other information, unrelated to what gets persisted as the tier label.
CREATE OR REPLACE FUNCTION public.nft_gen_trait_create(p_layer_id uuid, p_name character varying, p_file_path text, p_rarity_tier character varying DEFAULT NULL::character varying, p_storage_provider character varying DEFAULT 'filebase'::character varying, p_rarity_weight integer DEFAULT NULL::integer)
 RETURNS TABLE(id uuid, name character varying, rarity_weight integer, rarity_tier character varying, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE v_weight INT;
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

-- ── nft_gen_traits_create_bulk — same stored-value fix, plus: a re-sync
-- (re-dropping a layer folder / re-importing Excel for a collection that
-- already has these traits) previously updated only storage_provider and
-- is_active on conflict, silently discarding any fresh rarity_tier the
-- artist just supplied for traits that already existed. Now a real
-- incoming classification updates the stored value; an absent one
-- (COALESCE to the existing row) never wipes out whatever was already
-- there — including a prior manual UI pick, since those go through
-- nft_gen_trait_update, not this bulk path, at all.
CREATE OR REPLACE FUNCTION public.nft_gen_traits_create_bulk(p_layer_id uuid, p_traits jsonb)
 RETURNS TABLE(id uuid, name character varying, rarity_weight numeric, rarity_tier character varying, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM nft_layers WHERE nft_layers.id = p_layer_id) THEN
        RAISE EXCEPTION 'Layer not found' USING ERRCODE = 'P0002';
      END IF;

      RETURN QUERY
      INSERT INTO nft_traits (layer_id, name, file_path, storage_provider, rarity_weight, rarity_tier)
      SELECT
        p_layer_id,
        trim(t.name),
        trim(t.file_path),
        COALESCE(t.storage_provider, 'filebase'),
        COALESCE(t.rarity_weight, CASE COALESCE(lower(t.rarity_tier), 'common')
          WHEN 'legendary' THEN 3
          WHEN 'epic'      THEN 10
          WHEN 'rare'      THEN 30
          WHEN 'common'    THEN 100
          ELSE 100
        END),
        lower(t.rarity_tier)
      FROM jsonb_to_recordset(p_traits) AS t(name text, file_path text, rarity_tier text, storage_provider text, rarity_weight int)
      ON CONFLICT ON CONSTRAINT uq_nft_traits_layer_filepath DO UPDATE SET
        storage_provider = EXCLUDED.storage_provider,
        rarity_tier      = COALESCE(EXCLUDED.rarity_tier, nft_traits.rarity_tier),
        is_active        = TRUE,
        updated_at       = NOW()
      RETURNING nft_traits.id, nft_traits.name, nft_traits.rarity_weight, nft_traits.rarity_tier, nft_traits.created_at;
    END;
    $function$
;
