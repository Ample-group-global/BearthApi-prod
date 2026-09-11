ALTER TABLE nft_royalty_config ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES nft_collections(id);
UPDATE nft_royalty_config SET collection_id = '5cf741b7-c3ac-4c69-9d1e-348fc0fbe09c' WHERE id = 1 AND collection_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS nft_royalty_config_collection_id_key ON nft_royalty_config(collection_id);

DROP FUNCTION IF EXISTS nft_royalty_config_get();
CREATE OR REPLACE FUNCTION nft_royalty_config_get(p_collection_id uuid)
RETURNS TABLE (
  id int, royalty_pct_bps int, receiver_address text, enforce_royalty boolean,
  last_tx_hash text, synced_at timestamptz, updated_at timestamptz, collection_id uuid
) AS $$
  SELECT id, royalty_pct_bps, receiver_address, enforce_royalty, last_tx_hash, synced_at, updated_at, collection_id
  FROM nft_royalty_config WHERE collection_id = p_collection_id;
$$ LANGUAGE sql;

DROP FUNCTION IF EXISTS nft_royalty_config_upsert(int, text, boolean, text);
CREATE OR REPLACE FUNCTION nft_royalty_config_upsert(
  p_fee_bps int,
  p_receiver text,
  p_enforce boolean,
  p_tx_hash text,
  p_collection_id uuid
) RETURNS void AS $$
BEGIN
  UPDATE nft_royalty_config SET
    royalty_pct_bps   = p_fee_bps,
    receiver_address  = p_receiver,
    enforce_royalty   = p_enforce,
    last_tx_hash       = COALESCE(p_tx_hash, last_tx_hash),
    synced_at           = NOW(),
    updated_at          = NOW()
  WHERE collection_id = p_collection_id;

  IF NOT FOUND THEN
    INSERT INTO nft_royalty_config (royalty_pct_bps, receiver_address, enforce_royalty, last_tx_hash, synced_at, updated_at, collection_id)
    VALUES (p_fee_bps, p_receiver, p_enforce, p_tx_hash, NOW(), NOW(), p_collection_id);
  END IF;
END;
$$ LANGUAGE plpgsql;
