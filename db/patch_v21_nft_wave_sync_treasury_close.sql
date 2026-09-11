-- nft_wave_sync_treasury_close was called from contract.service.ts's
-- WaveClosedTreasury event handler but was never actually created --
-- every real treasuryClose() call has been silently failing this sync
-- step since it was first wired up (confirmed 2026-09-11 via
-- "function nft_wave_sync_treasury_close(unknown, unknown, unknown, unknown)
-- does not exist"). Mirrors the real nft_waves columns (wave_closed,
-- treasury_recipient, treasury_minted_count, close_action, last_tx_hash).
--
-- p_collection_id is REQUIRED: wave_number is NOT unique across collections
-- (every collection has its own waves 1-7) -- filtering by wave_number alone
-- would silently update a DIFFERENT collection's same-numbered wave.
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
