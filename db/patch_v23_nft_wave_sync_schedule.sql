CREATE OR REPLACE FUNCTION nft_wave_sync_schedule(
  p_wave_number int,
  p_start timestamptz,
  p_end timestamptz,
  p_tx_hash text,
  p_collection_id uuid
) RETURNS void AS $$
BEGIN
  UPDATE nft_waves SET
    scheduled_start      = p_start,
    scheduled_end        = p_end,
    wave_start_triggered = FALSE,
    wave_end_triggered   = FALSE,
    last_tx_hash         = COALESCE(p_tx_hash, last_tx_hash),
    synced_at            = NOW(),
    updated_at           = NOW()
  WHERE wave_number = p_wave_number
    AND collection_id = p_collection_id;
END;
$$ LANGUAGE plpgsql;
