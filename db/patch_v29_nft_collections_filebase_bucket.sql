ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS filebase_bucket text;

UPDATE nft_collections SET filebase_bucket = 'bearthnft-test1' WHERE symbol = 'BRTEST1';
UPDATE nft_collections SET filebase_bucket = 'bearthnft-test2' WHERE symbol = 'BRTEST2';
UPDATE nft_collections SET filebase_bucket = 'bearthnft-test3' WHERE symbol = 'BRTEST3';
