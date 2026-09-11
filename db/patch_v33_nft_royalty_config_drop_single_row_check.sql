-- patch_v30 added collection_id + a unique index to nft_royalty_config but
-- never removed the ORIGINAL "id integer PRIMARY KEY DEFAULT 1" +
-- "CHECK (id = 1)" constraint from patch_v18 -- meaning the table could
-- still structurally hold only ONE row ever, defeating the entire point
-- of the collection-scoping fix. nft_royalty_config_upsert's INSERT
-- fallback omits id (relying on the default), so any second collection's
-- first royalty save would default id to 1 and hit a duplicate-key
-- violation on nft_royalty_config_pkey.
ALTER TABLE nft_royalty_config DROP CONSTRAINT nft_royalty_config_single_row;

CREATE SEQUENCE IF NOT EXISTS nft_royalty_config_id_seq OWNED BY nft_royalty_config.id;
SELECT setval('nft_royalty_config_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM nft_royalty_config), 1));
ALTER TABLE nft_royalty_config ALTER COLUMN id SET DEFAULT nextval('nft_royalty_config_id_seq');

-- collection_id is already unique-indexed (patch_v30) and every write path
-- (nft_royalty_config_upsert) always supplies it -- make that explicit.
ALTER TABLE nft_royalty_config ALTER COLUMN collection_id SET NOT NULL;
