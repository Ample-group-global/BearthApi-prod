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
