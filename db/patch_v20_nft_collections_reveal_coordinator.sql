ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_reveal_coordinator_address text;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_vrf_subscription_id text;
