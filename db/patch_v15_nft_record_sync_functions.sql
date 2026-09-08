-- patch_v15: create nft_record_sync_mint / nft_record_sync_transfer
--
-- ROOT CAUSE FIX: contract.service.ts's on-chain event listener (and the
-- resyncFromBlock() backfill path) have always called these two functions on
-- every mint/transfer, but neither was ever created in the database. Every
-- call has been silently failing (caught by syncEvent()'s try/catch, logged
-- to the server console only) since this contract went live -- nft_records
-- has had 0 of 9999 rows with owner_address/token_id populated despite real
-- on-chain mints already having happened. Discovered 2026-09-08 while
-- investigating why Bearth-FE's "Memory Hall" (customer's owned-NFT gallery)
-- always showed empty.
--
-- Blind-box mint / later random reveal (confirmed by user 2026-09-08, see
-- memory project-mint-time-vs-reveal-time-assignment.md): nft_record_sync_mint
-- must NEVER set is_revealed, image_ipfs_hash, or any rarity/metadata field --
-- only token_id/owner/wave/mint-time bookkeeping. Reveal is a separate,
-- already-implemented step elsewhere in the codebase.

CREATE OR REPLACE FUNCTION nft_record_sync_mint(
  p_token_id BIGINT,
  p_owner_address TEXT,
  p_wave_num INTEGER,
  p_tx_hash TEXT
) RETURNS VOID AS $$
DECLARE
  v_row_id UUID;
BEGIN
  -- Idempotent: a redelivered event or an overlapping resync for a token_id
  -- that's already synced just refreshes owner/tx instead of re-assigning a
  -- second nft_records row to the same on-chain token.
  SELECT id INTO v_row_id FROM nft_records WHERE token_id = p_token_id;
  IF v_row_id IS NOT NULL THEN
    UPDATE nft_records
       SET owner_address = p_owner_address,
           mint_tx_hash  = COALESCE(mint_tx_hash, p_tx_hash),
           updated_at    = NOW()
     WHERE id = v_row_id;
    RETURN;
  END IF;

  -- FCFS assignment: the lowest-serial, not-yet-minted row already linked to
  -- this wave (wave_id/wave_num are set ahead of time by the admin wave-save
  -- flow's serial-range linking -- see waves.ts PUT /:id). Only one collection
  -- is expected to ever hold real on-chain token assignments at a time (single
  -- fixed-supply contract -- same assumption the reveal sync route makes). The
  -- DB has no formal collection<->live-contract-address link yet (nft_collections
  -- .contract_address is null for all seeded test collections, and
  -- nft_collection_config -- the one table that does carry contract_address --
  -- is an unpopulated global singleton with no collection_id to join on), so
  -- this pins to 'BRTEST1' by symbol, matching the same convention already
  -- used in GET /api/waves/public for the same "which collection is live" gap.
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
  p_reserved TEXT, -- unused; kept for call-site signature compatibility (contract.service.ts always passes NULL)
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
