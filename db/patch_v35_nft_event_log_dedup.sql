-- nft_event_log had no uniqueness on (tx_hash, log_index), so the same
-- on-chain event (WS reconnect replay, resyncFromBlock overlap, duplicate
-- listener registration) could be recorded and re-processed more than
-- once. Side effects like nft_wallet_sync_mint's wallet_total_minted +=
-- qty are pure increments, not idempotent -- a duplicate delivery would
-- permanently double-count a customer's mint total with no way to detect
-- it after the fact.
--
-- Fix: make nft_event_log itself the idempotency ledger. A partial unique
-- index (ignoring the pre-existing rows that may already contain
-- duplicates from before this fix) lets ON CONFLICT DO NOTHING short-
-- circuit exact re-deliveries going forward; the function now reports
-- back whether the row was actually new so callers can skip side effects
-- on a duplicate instead of re-running them.

-- One-time cleanup: a prior double-processed treasury-close transaction
-- (2026-09, treasury-repair debugging) left 299 exact-duplicate
-- (tx_hash, log_index) rows in nft_event_log (596 Transfer + 2
-- WaveClosedTreasury). Both side-effect functions those events drove
-- (nft_wave_sync_treasury_close, and the Transfer-driven token_id
-- assignment) are idempotent SETs, so no wallet/count corruption resulted
-- -- but the duplicate rows must be removed before the unique index below
-- can be created. Keep the earliest row per (tx_hash, log_index), drop
-- the rest.
DELETE FROM nft_event_log a USING nft_event_log b
  WHERE a.tx_hash = b.tx_hash
    AND a.log_index = b.log_index
    AND a.tx_hash IS NOT NULL AND a.log_index IS NOT NULL
    AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_nft_event_log_tx_log
  ON nft_event_log (tx_hash, log_index)
  WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL;

DROP FUNCTION IF EXISTS nft_event_log(TEXT, TEXT, BIGINT, INTEGER, TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION nft_event_log(
  p_event_name TEXT,
  p_tx_hash TEXT,
  p_block_number BIGINT,
  p_log_index INTEGER,
  p_param5 TEXT,
  p_param6 TEXT,
  p_payload JSONB
) RETURNS BOOLEAN AS $$
DECLARE
  v_row_count INTEGER;
BEGIN
  INSERT INTO nft_event_log
    (event_name, tx_hash, block_number, log_index, param5, param6, payload)
  VALUES
    (p_event_name, p_tx_hash, p_block_number, p_log_index, p_param5, p_param6, p_payload)
  ON CONFLICT (tx_hash, log_index) WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL
  DO NOTHING;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RETURN v_row_count > 0;
END;
$$ LANGUAGE plpgsql;
