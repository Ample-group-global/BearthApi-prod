-- nft_wallet_sync_mint() used a non-atomic UPDATE-then-INSERT pattern:
-- UPDATE ... WHERE address = p_address (exact, case-sensitive), and only
-- if NOT FOUND, INSERT a new row. But customer_wallets' real uniqueness
-- constraint is case-INSENSITIVE (uq_customer_wallets_address_lower, on
-- LOWER(address)). If a row already exists for the same address in a
-- different letter-case (e.g. registered earlier via whitelist admin
-- entry with mixed case, while this function is always called with a
-- lowercased address from the event listener), the exact-match UPDATE
-- silently misses it, falls through to NOT FOUND, and the INSERT then
-- violates the case-insensitive unique index -- the whole sync throws and
-- a real on-chain mint's wallet_total_minted/wl_claimed update is lost.
--
-- Caught live 2026-09-11: a real customer mint (CW2) succeeded on-chain
-- but this exact error broke its wallet sync during backfill.
--
-- Fix: a genuinely atomic INSERT ... ON CONFLICT upsert targeting the
-- real unique index, eliminating both the case-sensitivity bug and the
-- underlying check-then-act race condition (two concurrent mints from the
-- same wallet could otherwise both see NOT FOUND and both try to INSERT).
CREATE OR REPLACE FUNCTION nft_wallet_sync_mint(
  p_address text,
  p_qty int,
  p_is_whitelist_mint boolean,
  p_tx_hash text
) RETURNS void AS $$
BEGIN
  INSERT INTO customer_wallets (address, wallet_total_minted, wl_claimed, last_tx_hash, synced_at, source)
  VALUES (p_address, p_qty, COALESCE(p_is_whitelist_mint, false), p_tx_hash, NOW(), 'on_chain_mint')
  ON CONFLICT (LOWER(address)) DO UPDATE SET
    wallet_total_minted = customer_wallets.wallet_total_minted + EXCLUDED.wallet_total_minted,
    wl_claimed          = customer_wallets.wl_claimed OR EXCLUDED.wl_claimed,
    last_tx_hash         = COALESCE(EXCLUDED.last_tx_hash, customer_wallets.last_tx_hash),
    synced_at             = NOW();
END;
$$ LANGUAGE plpgsql;
