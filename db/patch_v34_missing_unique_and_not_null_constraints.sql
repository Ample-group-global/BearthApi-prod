-- Found via the 2026-09-11 4-codebase audit: several columns are treated
-- as unique/required by application code but have no DB-level constraint
-- enforcing it, leaving real race-condition and data-integrity gaps.

-- customer_wallets.address: every write path (customer_wallets_add,
-- customer_whitelist_upsert, wallet_connect, customer_wallet_auto_register,
-- nft_wallet_sync_mint, nft_wallet_set_vip) does a manual check-then-insert
-- with no locking -- two concurrent calls for the same new address can both
-- pass the check and both insert, producing two rows for one wallet.
-- Case-insensitive since addresses are compared lowercased throughout.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_wallets_address_lower
  ON customer_wallets (LOWER(address));

-- nft_records: token_id is unique per contract (per-collection), but only
-- (collection_id, serial_number) was ever constrained. A race between the
-- live event listener and a manual resyncFromBlock() replay could assign
-- the same on-chain token_id to two different placeholder rows with
-- nothing at the DB level to reject it. Partial index since unminted rows
-- have token_id NULL (and NULL is correctly never unique-checked).
CREATE UNIQUE INDEX IF NOT EXISTS uq_nft_records_collection_token
  ON nft_records (collection_id, token_id) WHERE token_id IS NOT NULL;

-- nft_collections.contract_address: resolveCollectionIdFromContractAddress()
-- looks up a collection by contract address with no ORDER BY/LIMIT --  if
-- two rows ever shared an address (deploy bug, manual data fix, copy-pasted
-- config), on-chain events would nondeterministically sync into whichever
-- collection matches first, corrupting both. Partial index since a
-- not-yet-deployed collection has contract_address NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_nft_collections_contract_address
  ON nft_collections (LOWER(contract_address)) WHERE contract_address IS NOT NULL;
