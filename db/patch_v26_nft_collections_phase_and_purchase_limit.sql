ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS current_phase varchar DEFAULT 'Whitelist';
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS purchase_limit_enabled boolean DEFAULT true;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS normal_max_per_wallet int DEFAULT 5;

CREATE OR REPLACE FUNCTION nft_collection_config_update(
  p_collection_id uuid,
  p_current_phase varchar
) RETURNS void AS $$
BEGIN
  UPDATE nft_collections SET
    current_phase = COALESCE(p_current_phase, current_phase),
    updated_at    = NOW()
  WHERE id = p_collection_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nft_purchase_limit_upsert(
  p_enabled boolean,
  p_max_per_wallet int,
  p_collection_id uuid
) RETURNS void AS $$
BEGIN
  UPDATE nft_collections SET
    purchase_limit_enabled = p_enabled,
    normal_max_per_wallet   = p_max_per_wallet,
    updated_at               = NOW()
  WHERE id = p_collection_id;
END;
$$ LANGUAGE plpgsql;
