ALTER TABLE nft_waves ADD COLUMN IF NOT EXISTS purchase_limit_confirmed boolean NOT NULL DEFAULT false;
