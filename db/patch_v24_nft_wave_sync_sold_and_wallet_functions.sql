-- Three of the eight missing SQL sync functions confirmed 2026-09-11 (task
-- #54) -- all called from contract.service.ts's event handlers, all
-- silently failing (caught+logged) since they were never created.
--
-- customer_wallets has no collection_id column at all (a real, separate
-- architectural gap -- see feedback-no-shared-contract-standing-policy.md),
-- so nft_wallet_sync_mint/nft_wallet_set_vip filter by wallet address only,
-- matching the table's current (collection-agnostic) design. Not fixed here
-- -- that's a bigger decision tracked separately, not a "straightforward" fix.

CREATE OR REPLACE FUNCTION nft_wave_sync_sold(
  p_wave_number int,
  p_sold_count int,
  p_tx_hash text,
  p_collection_id uuid
) RETURNS void AS $$
BEGIN
  UPDATE nft_waves SET
    sold_count   = p_sold_count,
    last_tx_hash = COALESCE(p_tx_hash, last_tx_hash),
    synced_at    = NOW(),
    updated_at   = NOW()
  WHERE wave_number = p_wave_number
    AND collection_id = p_collection_id;
END;
$$ LANGUAGE plpgsql;

-- No unique constraint exists on customer_wallets.address (only the
-- surrogate `id` PK is unique) -- confirmed 2026-09-11 via pg_constraint.
-- ON CONFLICT (address) would fail outright. Using an explicit
-- update-then-insert-if-not-found instead of adding a new constraint,
-- which is a bigger schema change than this "straightforward" fix scope.
CREATE OR REPLACE FUNCTION nft_wallet_sync_mint(
  p_address text,
  p_qty int,
  p_is_whitelist_mint boolean,
  p_tx_hash text
) RETURNS void AS $$
BEGIN
  UPDATE customer_wallets SET
    wallet_total_minted = wallet_total_minted + p_qty,
    wl_claimed           = wl_claimed OR COALESCE(p_is_whitelist_mint, false),
    last_tx_hash         = COALESCE(p_tx_hash, last_tx_hash),
    synced_at             = NOW()
  WHERE address = p_address;

  IF NOT FOUND THEN
    INSERT INTO customer_wallets (address, wallet_total_minted, wl_claimed, last_tx_hash, synced_at, source)
    VALUES (p_address, p_qty, COALESCE(p_is_whitelist_mint, false), p_tx_hash, NOW(), 'on_chain_mint');
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nft_wallet_set_vip(
  p_address text,
  p_status boolean,
  p_tx_hash text
) RETURNS void AS $$
BEGIN
  UPDATE customer_wallets SET
    is_vip       = p_status,
    last_tx_hash = COALESCE(p_tx_hash, last_tx_hash),
    synced_at    = NOW()
  WHERE address = p_address;

  IF NOT FOUND THEN
    INSERT INTO customer_wallets (address, is_vip, last_tx_hash, synced_at, source)
    VALUES (p_address, p_status, p_tx_hash, NOW(), 'on_chain_vip');
  END IF;
END;
$$ LANGUAGE plpgsql;
