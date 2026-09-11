CREATE OR REPLACE FUNCTION nft_record_sync_mint(
  p_token_id BIGINT,
  p_owner_address TEXT,
  p_wave_num INTEGER,
  p_tx_hash TEXT
) RETURNS VOID AS $$
DECLARE
  v_row_id UUID;
BEGIN
  SELECT id INTO v_row_id FROM nft_records WHERE token_id = p_token_id;
  IF v_row_id IS NOT NULL THEN
    UPDATE nft_records
       SET owner_address = p_owner_address,
           mint_tx_hash  = COALESCE(mint_tx_hash, p_tx_hash),
           updated_at    = NOW()
     WHERE id = v_row_id;
    RETURN;
  END IF;

  SELECT nr.id INTO v_row_id
    FROM nft_records nr
    JOIN nft_collections c ON c.id = nr.collection_id
   WHERE nr.wave_num = p_wave_num
     AND nr.token_id IS NULL
     AND c.symbol = 'BRTEST1'
   ORDER BY CAST(REPLACE(nr.serial_number, '#', '') AS INTEGER)
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF v_row_id IS NULL THEN
    RAISE EXCEPTION 'nft_record_sync_mint: no unassigned nft_records row for wave % (token_id %)', p_wave_num, p_token_id;
  END IF;

  UPDATE nft_records
     SET token_id          = p_token_id,
         owner_address     = p_owner_address,
         minted_at         = NOW(),
         mint_tx_hash      = p_tx_hash,
         on_chain_wave_num = p_wave_num,
         updated_at        = NOW()
   WHERE id = v_row_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nft_record_sync_transfer(
  p_token_id BIGINT,
  p_new_owner TEXT,
  p_reserved TEXT,
  p_tx_hash TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE nft_records
     SET owner_address = p_new_owner,
         last_tx_hash  = p_tx_hash,
         updated_at    = NOW()
   WHERE token_id = p_token_id;

  IF NOT FOUND THEN
    RAISE WARNING 'nft_record_sync_transfer: no nft_records row found for token_id % (mint sync may not have run yet)', p_token_id;
  END IF;
END;
$$ LANGUAGE plpgsql;
