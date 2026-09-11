DROP FUNCTION IF EXISTS nft_wave_sync_treasury_close(int, varchar, int, text);

CREATE OR REPLACE FUNCTION nft_wave_sync_treasury_close(
  p_wave_number int,
  p_recipient varchar,
  p_qty int,
  p_tx_hash text,
  p_collection_id uuid
) RETURNS void AS $$
BEGIN
  UPDATE nft_waves SET
    wave_closed            = TRUE,
    treasury_recipient      = p_recipient,
    treasury_minted_count   = p_qty,
    close_action            = 'treasury',
    last_tx_hash            = COALESCE(p_tx_hash, last_tx_hash),
    updated_at              = NOW()
  WHERE wave_number = p_wave_number
    AND collection_id = p_collection_id;
END;
$$ LANGUAGE plpgsql;
