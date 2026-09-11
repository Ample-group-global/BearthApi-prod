-- nft_event_log() marked an event "delivered" as soon as the log-insert
-- succeeded, BEFORE its downstream side effects (the switch-case in
-- syncEvent()) ran. If a side effect then failed partway through -- e.g. an
-- RPC call inside the handler hit a 429 -- the event was already recorded,
-- so every future resyncFromBlock() call saw it as a known duplicate and
-- permanently skipped re-running its side effects. Caught live 2026-09-11:
-- a 301-token treasury-close mint stalled at 281/301 synced records because
-- ~20 Transfer events got logged but their nft_record_sync_mint() call never
-- completed, and a manual resyncFromBlock() re-run skipped all of them as
-- "already processed" -- the exact gap flagged (but deferred) earlier today.
--
-- Fix: split "logged" from "processed". nft_event_log() now returns whether
-- the event still NEEDS its side effects run (true if genuinely new, OR if
-- it exists but was never marked processed) instead of just "was this
-- insert new". Callers must now explicitly call nft_event_mark_processed()
-- after their side effects complete successfully -- syncEvent() in
-- contract.service.ts does this right after its switch statement, inside
-- the same try block, so a thrown error skips the mark and the event
-- remains retryable on the next resync.

ALTER TABLE nft_event_log ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Every pre-existing row predates this column and was processed under the
-- old always-mark-on-insert behavior -- backfill so this migration doesn't
-- suddenly mark years of history as "needs reprocessing".
UPDATE nft_event_log SET processed_at = created_at WHERE processed_at IS NULL;

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
  v_processed_at TIMESTAMPTZ;
BEGIN
  INSERT INTO nft_event_log
    (event_name, tx_hash, block_number, log_index, param5, param6, payload)
  VALUES
    (p_event_name, p_tx_hash, p_block_number, p_log_index, p_param5, p_param6, p_payload)
  ON CONFLICT (tx_hash, log_index) WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL
  DO NOTHING;

  SELECT processed_at INTO v_processed_at
    FROM nft_event_log WHERE tx_hash = p_tx_hash AND log_index = p_log_index;

  RETURN v_processed_at IS NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nft_event_mark_processed(
  p_tx_hash TEXT,
  p_log_index INTEGER
) RETURNS void AS $$
BEGIN
  UPDATE nft_event_log SET processed_at = NOW()
   WHERE tx_hash = p_tx_hash AND log_index = p_log_index;
END;
$$ LANGUAGE plpgsql;
