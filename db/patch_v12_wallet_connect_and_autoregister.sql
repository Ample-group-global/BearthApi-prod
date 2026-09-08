-- Completes the customer-registration pipeline started in patch_v11.
-- Bearth-FE ALREADY calls POST /api/wallets/connect on every wallet connect
-- (src/lib/wallet-register.ts, wired since before this session -- confirmed
-- live in the Bearth-FE codebase, no frontend change needed) but BearthApi-V1
-- has never had a route to receive it, so every call has been silently
-- failing (fire-and-forget with .catch(() => {})). This patch + the matching
-- route/service port makes that already-wired call actually register the
-- customer + wallet in the DB and show up in the Customers page.
--
-- Ported as-is from the legacy BearthDev db, matching V1's customer_wallets
-- schema exactly (already has is_blocked/blocked_reason/blocked_at/
-- is_whitelisted from the RBAC migration). The one genuinely new piece is
-- whitelist_state, which V1 never had.

CREATE TABLE IF NOT EXISTS whitelist_state (
  id integer PRIMARY KEY,
  merkle_root text,
  manual_override boolean NOT NULL DEFAULT false,
  last_updated timestamptz
);
INSERT INTO whitelist_state (id, merkle_root, manual_override)
SELECT 1, NULL, false
WHERE NOT EXISTS (SELECT 1 FROM whitelist_state WHERE id = 1);

CREATE OR REPLACE FUNCTION public.wallet_connect(p_address text)
 RETURNS TABLE(id uuid, address text, user_id uuid, is_whitelisted boolean, is_blocked boolean, blocked_reason text, blocked_at timestamp with time zone, added_at timestamp with time zone, registered boolean)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_lower TEXT    := lower(p_address);
  v_new   BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_wallets cw WHERE lower(cw.address) = v_lower) THEN
    INSERT INTO customer_wallets(address, is_whitelisted, is_blocked, source)
    VALUES (v_lower, TRUE, FALSE, 'wallet_connect');
    v_new := TRUE;
  END IF;

  RETURN QUERY
  SELECT cw.id, cw.address, cw.user_id,
         cw.is_whitelisted, cw.is_blocked,
         cw.blocked_reason, cw.blocked_at, cw.added_at,
         v_new
  FROM customer_wallets cw
  WHERE lower(cw.address) = v_lower
  LIMIT 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.wallet_get(p_address text)
 RETURNS TABLE(id uuid, address text, user_id uuid, is_whitelisted boolean, is_blocked boolean, blocked_reason text, blocked_at timestamp with time zone, added_at timestamp with time zone)
 LANGUAGE sql
AS $function$
  SELECT id, address, user_id,
         is_whitelisted, is_blocked,
         blocked_reason, blocked_at, added_at
  FROM customer_wallets
  WHERE lower(address) = lower(p_address)
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.wallets_list(p_limit integer, p_offset integer, p_blocked_only boolean DEFAULT false)
 RETURNS TABLE(id uuid, address text, user_id uuid, is_whitelisted boolean, is_blocked boolean, blocked_reason text, blocked_at timestamp with time zone, added_at timestamp with time zone, total_count bigint)
 LANGUAGE sql
AS $function$
  SELECT id, address, user_id,
         is_whitelisted, is_blocked,
         blocked_reason, blocked_at, added_at,
         COUNT(*) OVER() AS total_count
  FROM customer_wallets
  WHERE NOT p_blocked_only OR is_blocked = TRUE
  ORDER BY added_at DESC
  LIMIT p_limit OFFSET p_offset;
$function$;

CREATE OR REPLACE FUNCTION public.wallet_block(p_address text, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(address text, is_blocked boolean, blocked_reason text, blocked_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_lower TEXT := lower(p_address);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_wallets WHERE lower(address) = v_lower) THEN
    RAISE EXCEPTION 'Wallet not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE customer_wallets
  SET is_blocked     = TRUE,
      blocked_reason = p_reason,
      blocked_at     = NOW()
  WHERE lower(address) = v_lower;
  RETURN QUERY
  SELECT cw.address, cw.is_blocked, cw.blocked_reason, cw.blocked_at
  FROM customer_wallets cw
  WHERE lower(cw.address) = v_lower
  LIMIT 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.wallet_unblock(p_address text)
 RETURNS TABLE(address text, is_blocked boolean)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_lower TEXT := lower(p_address);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_wallets WHERE lower(address) = v_lower) THEN
    RAISE EXCEPTION 'Wallet not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE customer_wallets
  SET is_blocked     = FALSE,
      blocked_reason = NULL,
      blocked_at     = NULL
  WHERE lower(address) = v_lower;
  RETURN QUERY
  SELECT cw.address, cw.is_blocked
  FROM customer_wallets cw
  WHERE lower(cw.address) = v_lower
  LIMIT 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.whitelist_addresses_all()
 RETURNS TABLE(address text)
 LANGUAGE sql
AS $function$
  SELECT address FROM customer_wallets WHERE is_whitelisted = TRUE ORDER BY added_at;
$function$;

CREATE OR REPLACE FUNCTION public.whitelist_state_update_root(p_root text)
 RETURNS void
 LANGUAGE sql
AS $function$
  UPDATE whitelist_state
  SET merkle_root = p_root, last_updated = NOW()
  WHERE id = 1;
$function$;

-- The actual stub-customer-creation function customer-whitelist.service.ts's
-- autoRegisterAndSync() calls -- this is the piece that makes a wallet
-- connect actually produce a Customer row, not just a customer_wallets row.
CREATE OR REPLACE FUNCTION public.customer_wallet_auto_register(p_address text, p_source character varying DEFAULT 'wallet_connect'::character varying)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_lower   TEXT        := lower(p_address);
  v_user_id UUID;
  v_role_id UUID;
  v_code    VARCHAR(10);
BEGIN
  SELECT cw.user_id INTO v_user_id
  FROM customer_wallets cw
  WHERE lower(cw.address) = v_lower AND cw.user_id IS NOT NULL
  LIMIT 1;

  IF v_user_id IS NOT NULL THEN
    UPDATE customer_wallets SET is_whitelisted = TRUE WHERE lower(address) = v_lower;
    RETURN v_user_id;
  END IF;

  SELECT r.id INTO v_role_id FROM roles r WHERE r.code = 'customer';
  v_code := 'CU' || LPAD(nextval('seq_user_cu')::TEXT, 3, '0');
  INSERT INTO users (user_code, first_name, last_name, role_id)
  VALUES (v_code, 'Customer', '', v_role_id)
  RETURNING id INTO v_user_id;

  IF NOT EXISTS (SELECT 1 FROM customer_wallets cw WHERE lower(cw.address) = v_lower) THEN
    INSERT INTO customer_wallets (address, user_id, is_whitelisted, source)
    VALUES (v_lower, v_user_id, TRUE, p_source);
  ELSE
    UPDATE customer_wallets
    SET user_id = v_user_id, is_whitelisted = TRUE, source = p_source
    WHERE lower(address) = v_lower;
  END IF;

  RETURN v_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.customer_wallet_get_user_id(p_address text)
 RETURNS uuid
 LANGUAGE sql
AS $function$
  SELECT cw.user_id
  FROM customer_wallets cw
  WHERE lower(cw.address) = lower(p_address) AND cw.user_id IS NOT NULL
  LIMIT 1;
$function$;

-- Permission for the admin wallet list/block endpoints -- reuses the
-- customers.* keys from patch_v11 (view/edit) since wallets are just the
-- other half of the same Customers page, not a separate permission concept.

-- Extends patch_v11's customers_list() to also return each customer's actual
-- wallet addresses (not just a count) -- the Customers page shows these
-- inline per row now that customers routinely have real linked wallets from
-- the auto-register flow above, instead of requiring a click into each row.
-- Postgres won't let CREATE OR REPLACE change a function's return shape, so
-- the old 6-arg signature must be dropped first.
DROP FUNCTION IF EXISTS public.customers_list(text, boolean, integer, integer, text, text);
CREATE OR REPLACE FUNCTION public.customers_list(
  p_search text DEFAULT NULL::text,
  p_active_only boolean DEFAULT true,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_sort_by text DEFAULT 'created_at'::text,
  p_sort_dir text DEFAULT 'desc'::text
)
 RETURNS TABLE(id uuid, user_code character varying, first_name character varying, last_name character varying, name text, phone character varying, email character varying, line_id character varying, referrer_id uuid, referrer_name text, notes text, is_active boolean, created_at timestamp with time zone, updated_at timestamp with time zone, wallet_count bigint, wallet_addresses text[], total_count bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE v_dir TEXT := CASE WHEN lower(p_sort_dir) = 'asc' THEN 'asc' ELSE 'desc' END;
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      u.id,
      u.user_code,
      u.first_name,
      u.last_name,
      TRIM(u.first_name || ' ' || u.last_name)       AS full_name,
      u.phone, u.email, u.line_id,
      u.referrer_id,
      TRIM(ref.first_name || ' ' || ref.last_name)   AS ref_name,
      u.notes, u.is_active, u.created_at, u.updated_at,
      (SELECT COUNT(*) FROM customer_wallets cw WHERE cw.user_id = u.id) AS wlt_count,
      (SELECT COALESCE(array_agg(cw.address ORDER BY cw.added_at), ARRAY[]::text[])
       FROM customer_wallets cw WHERE cw.user_id = u.id) AS wlt_addresses,
      COUNT(*) OVER ()                                                    AS tot_count
    FROM users u
    LEFT JOIN users  ref ON u.referrer_id = ref.id
    WHERE u.role_id = (SELECT roles.id FROM roles WHERE roles.code = 'customer')
      AND (NOT p_active_only OR u.is_active = TRUE)
      AND (p_search IS NULL
           OR u.user_code       ILIKE '%' || p_search || '%'
           OR u.first_name      ILIKE '%' || p_search || '%'
           OR u.last_name       ILIKE '%' || p_search || '%'
           OR u.email           ILIKE '%' || p_search || '%'
           OR u.phone           ILIKE '%' || p_search || '%'
           OR u.line_id         ILIKE '%' || p_search || '%'
           OR EXISTS (SELECT 1 FROM customer_wallets cw WHERE cw.user_id = u.id AND cw.address ILIKE '%' || p_search || '%'))
  )
  SELECT base.id, base.user_code, base.first_name, base.last_name, base.full_name,
         base.phone, base.email, base.line_id, base.referrer_id, base.ref_name,
         base.notes, base.is_active, base.created_at, base.updated_at,
         base.wlt_count, base.wlt_addresses, base.tot_count
  FROM base
  ORDER BY
    CASE WHEN p_sort_by='user_code' AND v_dir='asc'  THEN base.user_code END ASC  NULLS LAST,
    CASE WHEN p_sort_by='user_code' AND v_dir='desc' THEN base.user_code END DESC NULLS LAST,
    CASE WHEN p_sort_by='first_name'      AND v_dir='asc'  THEN base.first_name      END ASC  NULLS LAST,
    CASE WHEN p_sort_by='first_name'      AND v_dir='desc' THEN base.first_name      END DESC NULLS LAST,
    CASE WHEN p_sort_by='last_name'       AND v_dir='asc'  THEN base.last_name       END ASC  NULLS LAST,
    CASE WHEN p_sort_by='last_name'       AND v_dir='desc' THEN base.last_name       END DESC NULLS LAST,
    CASE WHEN p_sort_by='full_name'       AND v_dir='asc'  THEN base.full_name       END ASC  NULLS LAST,
    CASE WHEN p_sort_by='full_name'       AND v_dir='desc' THEN base.full_name       END DESC NULLS LAST,
    CASE WHEN p_sort_by='phone'           AND v_dir='asc'  THEN base.phone           END ASC  NULLS LAST,
    CASE WHEN p_sort_by='phone'           AND v_dir='desc' THEN base.phone           END DESC NULLS LAST,
    CASE WHEN p_sort_by='email'           AND v_dir='asc'  THEN base.email           END ASC  NULLS LAST,
    CASE WHEN p_sort_by='email'           AND v_dir='desc' THEN base.email           END DESC NULLS LAST,
    CASE WHEN p_sort_by='line_id'         AND v_dir='asc'  THEN base.line_id         END ASC  NULLS LAST,
    CASE WHEN p_sort_by='line_id'         AND v_dir='desc' THEN base.line_id         END DESC NULLS LAST,
    CASE WHEN p_sort_by='referrer_name'   AND v_dir='asc'  THEN base.ref_name        END ASC  NULLS LAST,
    CASE WHEN p_sort_by='referrer_name'   AND v_dir='desc' THEN base.ref_name        END DESC NULLS LAST,
    CASE WHEN p_sort_by='wallet_count'    AND v_dir='asc'  THEN base.wlt_count       END ASC  NULLS LAST,
    CASE WHEN p_sort_by='wallet_count'    AND v_dir='desc' THEN base.wlt_count       END DESC NULLS LAST,
    CASE WHEN p_sort_by='created_at'      AND v_dir='asc'  THEN base.created_at      END ASC  NULLS LAST,
    CASE WHEN p_sort_by='created_at'      AND v_dir='desc' THEN base.created_at      END DESC NULLS LAST,
    CASE WHEN p_sort_by='is_active'       AND v_dir='asc'  THEN base.is_active::TEXT END ASC  NULLS LAST,
    CASE WHEN p_sort_by='is_active'       AND v_dir='desc' THEN base.is_active::TEXT END DESC NULLS LAST,
    base.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;
