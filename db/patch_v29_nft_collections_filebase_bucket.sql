-- The link between a collection and its Filebase bucket was pure naming
-- convention (e.g. "Bearth Test1" -> bucket "bearthnft-test1") with nothing
-- stored in the database -- if a collection were ever renamed, or a bucket
-- named inconsistently, nothing would catch it. Documentation-only for now
-- (see feedback-no-shared-contract-standing-policy.md) -- actual generation/
-- upload code still needs to be updated separately to read from this column
-- instead of deriving the bucket name from the collection's own name/symbol.
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS filebase_bucket text;

UPDATE nft_collections SET filebase_bucket = 'bearthnft-test1' WHERE symbol = 'BRTEST1';
UPDATE nft_collections SET filebase_bucket = 'bearthnft-test2' WHERE symbol = 'BRTEST2';
UPDATE nft_collections SET filebase_bucket = 'bearthnft-test3' WHERE symbol = 'BRTEST3';
