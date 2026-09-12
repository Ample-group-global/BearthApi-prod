-- nft_records had TWO unique constraints on token_id: the old global
-- uq_nft_records_token_id (token_id) and the correct, already-present
-- uq_nft_records_collection_token (collection_id, token_id). The global one
-- was never dropped when the composite one was added. Every fresh contract
-- restarts token_id from 1, so the first real mint on Test2/Test3 would
-- collide with Test1's already-used token_id values and fail the global
-- constraint before the correct composite one ever got a chance to matter.
-- Found via audit 2026-09-13. No code referenced the old constraint by name
-- (checked src/ and all SQL function bodies) and it has zero data today
-- across Test1/2/3 that would violate the composite constraint on its own.

ALTER TABLE nft_records DROP CONSTRAINT IF EXISTS uq_nft_records_token_id;

-- uq_nft_records_collection_token already exists and is correct -- no
-- action needed there. idx_nft_records_token_id (non-unique, for lookups)
-- also stays as-is.
