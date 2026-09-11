ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS royalty_enforced boolean DEFAULT true;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS blind_box_uri text;
