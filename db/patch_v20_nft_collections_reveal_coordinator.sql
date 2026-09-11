-- Each collection-wise deploy also needs its own BearthRevealCoordinator
-- (Chainlink VRF v2.5) so reveal works at all on mainnet -- without one,
-- revealWave() hard-reverts forever there (WaveRandomnessNotSet, see
-- BearthNFT.sol's block.chainid == 1 guard). Testnet has a weaker fallback
-- (block.prevrandao) that mainnet deliberately refuses to use.
--
-- Found 2026-09-10: contract-deploy.service.ts never deployed/wired a
-- coordinator at all for collection-wise deploys -- this column plus the
-- deploy-time wiring fix are the actual fix, not just a schema addition.

ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_reveal_coordinator_address text;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_vrf_subscription_id text;
