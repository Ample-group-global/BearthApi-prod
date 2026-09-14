-- BearthAirdrop.sol is now deployed as part of the collection-wise deploy
-- flow (batch ETH distribution, ported from the old contract). Tracking its
-- per-collection address the same way Treasury/Timelock/Validator already are.

ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_airdrop_address TEXT;
