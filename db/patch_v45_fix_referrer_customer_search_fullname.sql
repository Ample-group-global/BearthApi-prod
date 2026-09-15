-- Fixes referrers_list() and customers_list() so a search term matching
-- the FULL name (e.g. "Test Referrer0915") returns results -- previously
-- only first_name/last_name were matched as separate fields, so any
-- multi-word name search silently returned zero rows even though the
-- customer/referrer genuinely existed.

CREATE OR REPLACE FUNCTION public.referrers_list(p_search text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, referrer_code character varying, first_name character varying, last_name character varying, name text, phone character varying, email character varying, role_code character varying, referred_count integer, referrer_name text)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT u.id, u.user_code AS referrer_code,
         u.first_name, u.last_name,
         TRIM(u.first_name || ' ' || u.last_name) AS name,
         u.phone, u.email,
         r.code AS role_code,
         (SELECT COUNT(*) FROM users u2 WHERE u2.referrer_id = u.id AND u2.is_active = TRUE)::int AS referred_count,
         (SELECT TRIM(u3.first_name || ' ' || u3.last_name) FROM users u3 WHERE u3.id = u.referrer_id) AS referrer_name
  FROM users u
  JOIN roles r ON u.role_id = r.id
  WHERE r.code IN ('admin', 'operation', 'technical_team', 'sales_team', 'ext_referrer', 'customer')
    AND u.is_active = TRUE
    AND (p_search IS NULL
         OR u.user_code    ILIKE '%' || p_search || '%'
         OR u.first_name   ILIKE '%' || p_search || '%'
         OR u.last_name    ILIKE '%' || p_search || '%'
         OR u.email        ILIKE '%' || p_search || '%'
         OR TRIM(u.first_name || ' ' || u.last_name) ILIKE '%' || p_search || '%')
  ORDER BY r.code, u.user_code;
END;
$function$;

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
           OR TRIM(u.first_name || ' ' || u.last_name) ILIKE '%' || p_search || '%'
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
