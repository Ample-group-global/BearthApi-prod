-- The on-chain allowlistRoot silently desynced from whitelist_state.merkle_root
-- on 2026-09-09 (root cause: customer-whitelist.service.ts's rebuildMerkleAndPush()
-- runs unawaited after the HTTP response is sent, with no Vercel waitUntil() --
-- the serverless function was very likely torn down mid-push, and the only
-- failure signal was a console.error that nobody was watching). This adds
-- columns to track push attempts/failures durably so a future desync is
-- immediately visible via a query instead of silently blocking real mints
-- until someone happens to hit it and report it.

ALTER TABLE whitelist_state
  ADD COLUMN IF NOT EXISTS onchain_root text,
  ADD COLUMN IF NOT EXISTS last_push_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_push_succeeded_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_push_error text;

CREATE OR REPLACE FUNCTION public.whitelist_state_record_push_attempt(
  p_root text,
  p_success boolean,
  p_error text DEFAULT NULL
)
 RETURNS void
 LANGUAGE sql
AS $function$
  UPDATE whitelist_state
  SET last_push_attempted_at = NOW(),
      onchain_root           = CASE WHEN p_success THEN p_root ELSE onchain_root END,
      last_push_succeeded_at = CASE WHEN p_success THEN NOW() ELSE last_push_succeeded_at END,
      last_push_error        = CASE WHEN p_success THEN NULL ELSE p_error END
  WHERE id = 1;
$function$;

-- Quick drift check: SELECT * FROM v_whitelist_sync_status;
-- in_sync = false means merkle_root (DB's intended root) and onchain_root
-- (last confirmed on-chain push) have diverged -- exactly today's bug.
CREATE OR REPLACE VIEW public.v_whitelist_sync_status AS
SELECT
  merkle_root,
  onchain_root,
  (merkle_root IS NOT DISTINCT FROM onchain_root) AS in_sync,
  last_push_attempted_at,
  last_push_succeeded_at,
  last_push_error
FROM whitelist_state
WHERE id = 1;
