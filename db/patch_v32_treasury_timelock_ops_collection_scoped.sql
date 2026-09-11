-- treasury_timelock_ops has zero rows ever (this feature has never actually
-- been used) -- safe to add collection_id as NOT NULL with no backfill.
-- Without it, scheduleTreasuryWalletChange() always targeted the legacy
-- global CONTRACT_ADDRESS regardless of which collection was intended, and
-- getLatestTimelockOp() could return one collection's pending operation
-- while looking up status for a completely different one.
ALTER TABLE treasury_timelock_ops ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES nft_collections(id);
ALTER TABLE treasury_timelock_ops ALTER COLUMN collection_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_treasury_timelock_ops_purpose_collection
  ON treasury_timelock_ops (purpose, collection_id, created_at DESC);
