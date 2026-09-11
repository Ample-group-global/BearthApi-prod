CREATE OR REPLACE FUNCTION nft_wave_sync_price(
  p_wave_number int,
  p_price_eth numeric,
  p_price_locked boolean,
  p_tx_hash text,
  p_collection_id uuid
) RETURNS void AS $$
BEGIN
  UPDATE nft_waves SET
    default_price_eth = p_price_eth,
    price_locked       = p_price_locked,
    last_tx_hash        = COALESCE(p_tx_hash, last_tx_hash),
    synced_at            = NOW(),
    updated_at           = NOW()
  WHERE wave_number = p_wave_number
    AND collection_id = p_collection_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nft_wave_sync_reveal(
  p_wave_number int,
  p_uri text,
  p_tx_hash text,
  p_collection_id uuid
) RETURNS void AS $$
BEGIN
  UPDATE nft_waves SET
    is_revealed       = TRUE,
    wave_revealed      = TRUE,
    wave_reveal_uri     = p_uri,
    wave_revealed_at     = COALESCE(wave_revealed_at, NOW()),
    last_tx_hash          = COALESCE(p_tx_hash, last_tx_hash),
    synced_at              = NOW(),
    updated_at             = NOW()
  WHERE wave_number = p_wave_number
    AND collection_id = p_collection_id;
END;
$$ LANGUAGE plpgsql;
