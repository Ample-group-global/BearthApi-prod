CREATE TABLE IF NOT EXISTS nft_event_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name   TEXT NOT NULL,
  tx_hash      TEXT,
  block_number BIGINT,
  log_index    INTEGER,
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
