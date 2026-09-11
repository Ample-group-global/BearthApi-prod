-- nft_collections had royalty_bps but no royalty_enforced flag -- the
-- Contract Operations page's "royalty enforcement" toggle was reading it
-- from the legacy global nft_collection_config singleton instead
-- (task #42/#43, explicit feature list from feedback-no-shared-contract-standing-policy.md).
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS royalty_enforced boolean DEFAULT true;
-- Same gap: the Contract Operations page's "update blind box URI" action was
-- writing to the legacy global nft_collection_config singleton instead of
-- this collection's own row. (blind_box_uri IS passed as a param at deploy
-- time -- see contract-deploy.service.ts -- but was never persisted back to
-- nft_collections afterward.)
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS blind_box_uri text;
