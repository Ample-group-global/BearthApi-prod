ALTER TABLE treasury_timelock_ops ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES nft_collections(id);
ALTER TABLE treasury_timelock_ops ALTER COLUMN collection_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_treasury_timelock_ops_purpose_collection
  ON treasury_timelock_ops (purpose, collection_id, created_at DESC);
