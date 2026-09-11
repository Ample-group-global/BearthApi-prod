-- Three bugs fixed together since they all live in the same function:
--
-- 1. CRITICAL (task #29): the FCFS unassigned-row lookup was hardcoded
--    `AND c.symbol = 'BRTEST1'` -- would silently break or misassign for
--    any other collection. Now takes p_collection_id explicitly (already
--    resolved per-event in contract.service.ts's syncEvent() as of the
--    2026-09-11 collection-scoping fix) and filters on it directly.
--
-- 2. The "already minted" idempotency lookup (`WHERE token_id = p_token_id`)
--    was ALSO not scoped by collection_id -- token_id is per-contract, not
--    globally unique, so two collections both having a token #1 could
--    collide and update the wrong collection's row.
--
-- 3. mint_type has been defaulting to the schema-level 'paid' on every
--    single mint across the whole DB (confirmed 2026-09-11: 29997/29997
--    rows show 'paid', including genuine free-mint tokens) because nothing
--    ever set it otherwise. Now derived from the wave's actual
--    default_price_eth (NULL or 0 = free) at mint time.
--
-- All pre-existing is_revealed/revealed_at/delivery_status_id logic from the
-- prior version is preserved unchanged.
DROP FUNCTION IF EXISTS nft_record_sync_mint(bigint, text, integer, text, boolean);
DROP FUNCTION IF EXISTS nft_record_sync_mint(bigint, text, integer, text);

CREATE OR REPLACE FUNCTION nft_record_sync_mint(
  p_token_id bigint,
  p_owner_address text,
  p_wave_num int,
  p_tx_hash text,
  p_collection_id uuid,
  p_is_treasury boolean DEFAULT false
) RETURNS void AS $$
DECLARE
  v_row_id UUID;
  v_status_id UUID;
  v_wave_revealed BOOLEAN;
  v_wave_price NUMERIC;
  v_mint_type TEXT;
BEGIN
  SELECT id INTO v_status_id FROM lookup_values WHERE category = 'delivery_status' AND code = (CASE WHEN p_is_treasury THEN 'treasury_wallet' ELSE 'sold' END);
  SELECT default_price_eth, wave_revealed INTO v_wave_price, v_wave_revealed
    FROM nft_waves WHERE collection_id = p_collection_id AND wave_number = p_wave_num;
  v_mint_type := CASE WHEN v_wave_price IS NULL OR v_wave_price = 0 THEN 'free' ELSE 'paid' END;

  SELECT id INTO v_row_id FROM nft_records WHERE token_id = p_token_id AND collection_id = p_collection_id;
  IF v_row_id IS NOT NULL THEN
    UPDATE nft_records
       SET owner_address = p_owner_address,
           mint_tx_hash  = COALESCE(mint_tx_hash, p_tx_hash),
           delivery_status_id = v_status_id,
           is_revealed = COALESCE(v_wave_revealed, false),
           revealed_at = CASE WHEN COALESCE(v_wave_revealed, false) AND revealed_at IS NULL THEN NOW() ELSE revealed_at END,
           updated_at    = NOW()
     WHERE id = v_row_id;
    RETURN;
  END IF;

  SELECT nr.id INTO v_row_id
    FROM nft_records nr
   WHERE nr.wave_num = p_wave_num
     AND nr.collection_id = p_collection_id
     AND nr.token_id IS NULL
   ORDER BY CAST(REPLACE(nr.serial_number, '#', '') AS INTEGER)
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF v_row_id IS NULL THEN
    RAISE EXCEPTION 'nft_record_sync_mint: no unassigned nft_records row for wave % / collection % (token_id %)', p_wave_num, p_collection_id, p_token_id;
  END IF;

  UPDATE nft_records
     SET token_id           = p_token_id,
         owner_address      = p_owner_address,
         minted_at          = NOW(),
         mint_tx_hash       = p_tx_hash,
         on_chain_wave_num  = p_wave_num,
         mint_type          = v_mint_type,
         delivery_status_id = v_status_id,
         is_revealed        = COALESCE(v_wave_revealed, false),
         revealed_at        = CASE WHEN COALESCE(v_wave_revealed, false) THEN NOW() ELSE NULL END,
         updated_at         = NOW()
   WHERE id = v_row_id;
END;
$$ LANGUAGE plpgsql;
