-- BearthTreasury.sol and BearthTimelock.sol were never actually deployed as
-- part of the collection-wise deploy flow -- BearthNFT's treasuryWallet was
-- just the deploy wallet's own EOA, and UPGRADER_ROLE/TREASURY_TIMELOCK_ROLE
-- were granted directly to a human-controlled wallet with no real 48h
-- governance delay behind them. Adding columns to track both contracts now
-- that they're wired into the deploy flow for real mainnet-grade security.

ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_treasury_address TEXT;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_timelock_address TEXT;
