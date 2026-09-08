-- patch_v16: create the nft_event_log table + function
--
-- ROOT CAUSE (broader than patch_v15): syncEvent() in contract.service.ts calls
-- nft_event_log($1..$7) as the VERY FIRST statement, before its switch(eventName)
-- block -- and this function has never existed either. Because that call sat
-- inside the same top-level try/catch as everything else, its failure aborted
-- syncEvent() immediately: NOT ONE of the ~13 other nft_*_sync_*/nft_wallet_*/
-- nft_royalty_*/nft_purchase_limit_* functions the switch cases call has EVER
-- executed for ANY on-chain event, for as long as this contract has been live.
-- Confirmed by inventory: of every function contract.service.ts's syncEvent
-- references, only nft_record_sync_mint/nft_record_sync_transfer exist as of
-- patch_v15 (created earlier the same session) -- everything else referenced
-- there (nft_wave_sync_sold, nft_wallet_sync_mint, nft_wave_sync_schedule,
-- nft_wave_sync_price, nft_wave_sync_treasury_close, nft_collection_config_update,
-- nft_wave_sync_reveal, nft_wallet_set_vip, nft_purchase_limit_upsert,
-- nft_royalty_config_get, nft_royalty_config_upsert) is STILL MISSING.
--
-- Scope of this patch: only unblock the gate (nft_event_log) so events reach
-- their switch case at all, which lets the already-fixed mint/transfer sync
-- (patch_v15) actually run. The other ~10 missing sync functions are a
-- separate, larger piece of business logic (wave sold-counts, schedule/price
-- sync, treasury close, VIP status, purchase limits, royalty config) that
-- needs its own dedicated pass -- NOT invented here under time pressure.
-- Each of those switch cases will still fail (same silently-caught pattern)
-- until that follow-up work happens; flagged separately to the user.

CREATE TABLE IF NOT EXISTS nft_event_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name   TEXT NOT NULL,
  tx_hash      TEXT,
  block_number BIGINT,
  log_index    INTEGER,
  -- Positions 5/6 of the call signature are always NULL at the only call site
  -- (contract.service.ts:152) -- reserved, unused today; kept generic rather
  -- than guessing a specific meaning.
  param5       TEXT,
  param6       TEXT,
  payload      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nft_event_log_tx_hash ON nft_event_log (tx_hash);
CREATE INDEX IF NOT EXISTS idx_nft_event_log_event_name ON nft_event_log (event_name);

CREATE OR REPLACE FUNCTION nft_event_log(
  p_event_name TEXT,
  p_tx_hash TEXT,
  p_block_number BIGINT,
  p_log_index INTEGER,
  p_param5 TEXT,
  p_param6 TEXT,
  p_payload JSONB
) RETURNS VOID AS $$
BEGIN
  INSERT INTO nft_event_log
    (event_name, tx_hash, block_number, log_index, param5, param6, payload)
  VALUES
    (p_event_name, p_tx_hash, p_block_number, p_log_index, p_param5, p_param6, p_payload);
END;
$$ LANGUAGE plpgsql;
