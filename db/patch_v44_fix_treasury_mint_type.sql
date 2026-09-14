-- nft_record_sync_mint() (patch_v22) computed mint_type purely from the
-- wave's price (free vs paid), completely ignoring the p_is_treasury flag
-- it already receives and already uses correctly for delivery_status_id.
-- Result: every treasury-swept token (treasuryClose() sweeping a wave's
-- unsold remainder) got mint_type='free'/'paid' matching its wave's price,
-- never 'treasury' -- even though 'treasury' is a documented valid value
-- (VALID_MINT_TYPES in routes/nfts.ts) and the NFT List page's "Mint Type:
-- Treasury" filter relies on it. Confirmed live 2026-09-15: all 298
-- treasury-held tokens in Bearth Test1 have mint_type='free', so that
-- filter option can never match a real row.
--
-- Fix: check p_is_treasury first in both branches that touch mint_type.
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
  v_mint_type := CASE
    WHEN p_is_treasury THEN 'treasury'
    WHEN v_wave_price IS NULL OR v_wave_price = 0 THEN 'free'
    ELSE 'paid'
  END;

  SELECT id INTO v_row_id FROM nft_records WHERE token_id = p_token_id AND collection_id = p_collection_id;
  IF v_row_id IS NOT NULL THEN
    UPDATE nft_records
       SET owner_address = p_owner_address,
           mint_tx_hash  = COALESCE(mint_tx_hash, p_tx_hash),
           mint_type     = v_mint_type,
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
