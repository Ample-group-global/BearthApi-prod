-- max_per_wallet defaults to 0 (NOT NULL) and 0 is itself a valid,
-- meaningful choice ("use the global limit") -- so it's impossible to tell
-- "admin explicitly confirmed this wave's limit" from "admin never touched
-- this at all" just by reading the value. Add an explicit flag instead
-- (task #45/#22).
ALTER TABLE nft_waves ADD COLUMN IF NOT EXISTS purchase_limit_confirmed boolean NOT NULL DEFAULT false;
