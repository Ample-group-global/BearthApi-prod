-- Regression from patch_v04: nft_traits.rarity_weight is NUMERIC, but
-- nft_gen_traits_create_bulk's jsonb_to_recordset parsed the incoming
-- rarity_weight as `int`, so any fractional weight (e.g. an artist's Excel
-- weight of 2.78) crashed the whole bulk insert with "invalid input syntax
-- for type integer". The RETURNS TABLE type was corrected to numeric during
-- patch_v04 (matching the real column), but this internal parsing clause was
-- missed. Fixing it to numeric so it matches the column exactly.
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
      FROM jsonb_to_recordset(p_traits) AS t(name text, file_path text, rarity_tier text, storage_provider text, rarity_weight numeric)
      ON CONFLICT ON CONSTRAINT uq_nft_traits_layer_filepath DO UPDATE SET
        storage_provider = EXCLUDED.storage_provider,
        rarity_tier      = COALESCE(EXCLUDED.rarity_tier, nft_traits.rarity_tier),
        is_active        = TRUE,
        updated_at       = NOW()
      RETURNING nft_traits.id, nft_traits.name, nft_traits.rarity_weight, nft_traits.rarity_tier, nft_traits.created_at;
    END;
    $function$
;
