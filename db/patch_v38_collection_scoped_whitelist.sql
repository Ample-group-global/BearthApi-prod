-- The whitelist roster was entirely global: whitelist_addresses_all() read
-- every is_whitelisted=TRUE row in customer_wallets with no collection
-- filter at all, and whitelist_state (the merkle-root tracking table) was a
-- hardcoded singleton (id = 1). With 3 test collections live at once, this
-- meant whitelisting a wallet for Test1 silently whitelisted it for
-- Test2/Test3 too, and all 3 collections would fight over the same
-- merkle-root/push-status row -- a direct conflict with the standing
-- "test 3 collections together, zero conflict" requirement.
--
-- Also found live: customer_wallet_auto_register() sets is_whitelisted=TRUE
-- on every wallet that merely connects/registers, regardless of collection.
-- Left untouched here (out of scope for this fix) -- moving the real roster
-- to nft_collection_whitelist below makes that pre-existing flag irrelevant
-- to actual on-chain admission going forward, since the merkle tree is now
-- built from this new table, not from customer_wallets.is_whitelisted.
--
-- Fix: a genuine per-collection roster table, and whitelist_state keyed by
-- collection_id instead of a singleton row. Existing whitelisted addresses
-- and the existing whitelist_state row's data are backfilled into ALL 3
-- current test collections (test data only, verified before this migration
-- -- no real customer data affected), so testing can continue on any of
-- them without needing to rebuild the roster from scratch.

CREATE TABLE IF NOT EXISTS nft_collection_whitelist (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id  UUID NOT NULL REFERENCES nft_collections(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  source         TEXT,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (collection_id, wallet_address)
);

INSERT INTO nft_collection_whitelist (collection_id, wallet_address, source, added_at)
SELECT c.id, lower(cw.address), COALESCE(cw.source, 'migrated'), cw.added_at
  FROM customer_wallets cw
  CROSS JOIN nft_collections c
 WHERE cw.is_whitelisted = TRUE
ON CONFLICT (collection_id, wallet_address) DO NOTHING;

ALTER TABLE whitelist_state ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES nft_collections(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_state_collection ON whitelist_state (collection_id) WHERE collection_id IS NOT NULL;

-- Give every collection its own state row. The pre-existing singleton
-- (id = 1) carried real, currently-in-use data (Test1's pushed root) --
-- assign it to Test1 explicitly rather than leaving it collection-less.
UPDATE whitelist_state SET collection_id = (SELECT id FROM nft_collections WHERE name = 'Bearth Test1') WHERE id = 1;

-- whitelist_state.id has no sequence default (it's a hand-assigned singleton
-- key from before this migration) -- assign fresh ids explicitly.
INSERT INTO whitelist_state (id, collection_id)
SELECT (SELECT COALESCE(MAX(id), 0) FROM whitelist_state) + ROW_NUMBER() OVER (ORDER BY c.name), c.id
  FROM nft_collections c
 WHERE NOT EXISTS (SELECT 1 FROM whitelist_state ws WHERE ws.collection_id = c.id)
ON CONFLICT DO NOTHING;

DROP FUNCTION IF EXISTS whitelist_addresses_all();
CREATE OR REPLACE FUNCTION whitelist_addresses_for_collection(p_collection_id UUID)
RETURNS TABLE(address text) AS $$
  SELECT wallet_address FROM nft_collection_whitelist
   WHERE collection_id = p_collection_id
   ORDER BY added_at;
$$ LANGUAGE sql;

DROP FUNCTION IF EXISTS whitelist_state_update_root(text);
CREATE OR REPLACE FUNCTION whitelist_state_update_root(p_collection_id UUID, p_root text)
RETURNS void AS $$
  UPDATE whitelist_state
     SET merkle_root = p_root, last_updated = NOW()
   WHERE collection_id = p_collection_id;
$$ LANGUAGE sql;

DROP FUNCTION IF EXISTS whitelist_state_record_push_attempt(text, boolean, text);
CREATE OR REPLACE FUNCTION whitelist_state_record_push_attempt(p_collection_id UUID, p_root text, p_success boolean, p_error text DEFAULT NULL)
RETURNS void AS $$
  UPDATE whitelist_state
     SET last_push_attempted_at = NOW(),
         onchain_root           = CASE WHEN p_success THEN p_root ELSE onchain_root END,
         last_push_succeeded_at = CASE WHEN p_success THEN NOW() ELSE last_push_succeeded_at END,
         last_push_error        = CASE WHEN p_success THEN NULL ELSE p_error END
   WHERE collection_id = p_collection_id;
$$ LANGUAGE sql;

DROP VIEW IF EXISTS v_whitelist_sync_status;
CREATE OR REPLACE FUNCTION whitelist_sync_status_for_collection(p_collection_id UUID)
RETURNS TABLE(
  merkle_root text, onchain_root text, in_sync boolean,
  last_push_attempted_at timestamptz, last_push_succeeded_at timestamptz, last_push_error text
) AS $$
  SELECT merkle_root, onchain_root,
         NOT (merkle_root IS DISTINCT FROM onchain_root) AS in_sync,
         last_push_attempted_at, last_push_succeeded_at, last_push_error
    FROM whitelist_state
   WHERE collection_id = p_collection_id;
$$ LANGUAGE sql;
