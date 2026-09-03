-- nft_records was scoped to hold exactly one collection's data at a time:
-- serial_number ("#1".."#9999") was globally UNIQUE, but every collection
-- independently numbers its own editions "#1".."#N", so a second collection
-- synced into nft_records would collide with the first's serial numbers.
-- This let Test1/Test2/Test3 (and future collections) coexist in the same
-- table, distinguished by collection_id, instead of nft_records being
-- limited to one collection at a time.

ALTER TABLE nft_records ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES nft_collections(id);

-- Backfill any pre-existing rows (synced before this migration existed) by
-- tracing generated_item_id -> nft_generated_items.job_id -> nft_generation_jobs.collection_id.
UPDATE nft_records nr
SET collection_id = gj.collection_id
FROM nft_generated_items gi
JOIN nft_generation_jobs gj ON gj.id = gi.job_id
WHERE nr.generated_item_id = gi.id
  AND nr.collection_id IS NULL;

ALTER TABLE nft_records DROP CONSTRAINT IF EXISTS nft_records_serial_number_key;
ALTER TABLE nft_records DROP CONSTRAINT IF EXISTS uq_nft_records_collection_serial;
ALTER TABLE nft_records ADD CONSTRAINT uq_nft_records_collection_serial UNIQUE (collection_id, serial_number);

-- v_nft_records: expose collection_name for admin UI display/filtering.
-- DROP + CREATE (not CREATE OR REPLACE) because nr.* now includes
-- collection_id, which shifts the position of every column after it —
-- Postgres refuses CREATE OR REPLACE VIEW when existing column
-- names/positions change.
DROP VIEW IF EXISTS v_nft_records;
CREATE VIEW v_nft_records AS
SELECT
  nr.*,
  ns.code  AS stage_code,
  ns.label AS stage_name,
  nt.code  AS type_code,
  nt.label AS type_name,
  ds.code  AS delivery_status_code,
  ds.label AS delivery_status_name,
  nc.name  AS collection_name
FROM nft_records nr
LEFT JOIN lookup_values ns ON nr.stage_id           = ns.id AND ns.category = 'nft_stage'
LEFT JOIN lookup_values nt ON nr.nft_type_id        = nt.id AND nt.category = 'nft_type'
LEFT JOIN lookup_values ds ON nr.delivery_status_id = ds.id AND ds.category = 'delivery_status'
LEFT JOIN nft_collections nc ON nr.collection_id    = nc.id;

GRANT SELECT ON v_nft_records TO PUBLIC;
