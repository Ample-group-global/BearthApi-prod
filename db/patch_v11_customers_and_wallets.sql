-- Ports the legacy "Customers" admin feature (from the pre-V1 BearthDev/
-- BearthAdmin/BearthApi, which had a broader Sales/Products/OpenSea admin
-- panel) forward into V1 -- scoped down to Customers + Wallets ONLY, per
-- explicit instruction. The `orders`/`reconciliation_entries` joins present
-- in the legacy customers_list()/customers_get() are intentionally dropped;
-- those are Sales-module tables outside V1's NFT-focused scope.
--
-- Customers are not a standalone table -- they are `users` rows with
-- role_id pointing at the 'customer' role, same design as legacy. V1's
-- `users` and `customer_wallets` tables already carry every column these
-- functions touch (confirmed directly against the schema before writing
-- this), so no ALTER TABLE is needed here, only the missing sequence + the
-- functions themselves.
--
-- Going forward, real customers are expected to originate from Bearth-FE's
-- wallet-connect/mint flow (auto-registering a customer_wallets row), not
-- from admin-created rows via customers_create() -- that function is kept
-- for admin flexibility (matches the legacy page), not as the primary path.

CREATE SEQUENCE IF NOT EXISTS seq_user_cu START 1;

CREATE OR REPLACE FUNCTION public.customers_list(
  p_search text DEFAULT NULL::text,
  p_active_only boolean DEFAULT true,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_sort_by text DEFAULT 'created_at'::text,
  p_sort_dir text DEFAULT 'desc'::text
)
 RETURNS TABLE(id uuid, user_code character varying, first_name character varying, last_name character varying, name text, phone character varying, email character varying, line_id character varying, referrer_id uuid, referrer_name text, notes text, is_active boolean, created_at timestamp with time zone, updated_at timestamp with time zone, wallet_count bigint, total_count bigint)
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
           OR u.line_id         ILIKE '%' || p_search || '%')
  )
  SELECT base.id, base.user_code, base.first_name, base.last_name, base.full_name,
         base.phone, base.email, base.line_id, base.referrer_id, base.ref_name,
         base.notes, base.is_active, base.created_at, base.updated_at,
         base.wlt_count, base.tot_count
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

CREATE OR REPLACE FUNCTION public.customers_get(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE v_result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_id AND role_id = (SELECT id FROM roles WHERE code = 'customer')) THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT json_build_object(
    'id',             u.id,
    'userCode',      u.user_code,
    'firstName',      u.first_name,
    'lastName',       u.last_name,
    'name',           u.first_name || ' ' || u.last_name,
    'phone',          u.phone,
    'email',          u.email,
    'lineId',         u.line_id,
    'referrerId',     u.referrer_id,
    'referrerName',  ref.first_name || ' ' || ref.last_name,
    'notes',         u.notes,
    'isActive',      u.is_active,
    'createdAt',     u.created_at,
    'updatedAt',     u.updated_at,
    'wallets', COALESCE(
      (SELECT json_agg(json_build_object(
        'id',           cw.id,
        'address',      cw.address,
        'isWhitelisted', cw.is_whitelisted,
        'addedAt', cw.added_at
      ) ORDER BY cw.added_at)
       FROM customer_wallets cw WHERE cw.user_id = u.id
      ), '[]'::json)
  ) INTO v_result
  FROM users u
  LEFT JOIN users ref ON u.referrer_id = ref.id
  WHERE u.id = p_id;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.customers_create(
  p_first_name character varying,
  p_last_name character varying,
  p_phone character varying DEFAULT NULL::character varying,
  p_email character varying DEFAULT NULL::character varying,
  p_line_id character varying DEFAULT NULL::character varying,
  p_referrer_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text
)
 RETURNS TABLE(id uuid, user_code character varying, first_name character varying, last_name character varying, name text, phone character varying, email character varying, line_id character varying, referrer_id uuid, notes text, is_active boolean, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_role_id   UUID;
  v_user_code VARCHAR(10);
BEGIN
  IF p_first_name IS NULL OR trim(p_first_name) = '' THEN
    RAISE EXCEPTION 'First name is required' USING ERRCODE = 'P0001';
  END IF;
  IF p_referrer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users ux
    JOIN roles rx ON ux.role_id = rx.id
    WHERE ux.id = p_referrer_id
      AND rx.code IN ('admin', 'operation', 'technical_team', 'sales_team', 'ext_referrer', 'customer')
      AND ux.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Referrer not found or not eligible' USING ERRCODE = 'P0002';
  END IF;
  SELECT roles.id INTO v_role_id FROM roles WHERE roles.code = 'customer';
  v_user_code := 'CU' || LPAD(nextval('seq_user_cu')::TEXT, 3, '0');
  RETURN QUERY
  INSERT INTO users (user_code, first_name, last_name, phone, email, line_id, referrer_id, notes, role_id)
  VALUES (
    v_user_code,
    trim(p_first_name), COALESCE(trim(p_last_name), ''),
    NULLIF(trim(p_phone),''), NULLIF(lower(trim(p_email)),''),
    NULLIF(trim(p_line_id),''),
    p_referrer_id, p_notes, v_role_id
  )
  RETURNING users.id, users.user_code, users.first_name, users.last_name,
            users.first_name || ' ' || users.last_name,
            users.phone, users.email, users.line_id, users.referrer_id, users.notes,
            users.is_active, users.created_at, users.updated_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.customers_update(
  p_id uuid,
  p_first_name character varying DEFAULT NULL::character varying,
  p_last_name character varying DEFAULT NULL::character varying,
  p_phone character varying DEFAULT NULL::character varying,
  p_email character varying DEFAULT NULL::character varying,
  p_line_id character varying DEFAULT NULL::character varying,
  p_referrer_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_is_active boolean DEFAULT NULL::boolean
)
 RETURNS TABLE(id uuid, user_code character varying, first_name character varying, last_name character varying, name text, phone character varying, email character varying, line_id character varying, referrer_id uuid, notes text, is_active boolean, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users ux WHERE ux.id = p_id
      AND ux.role_id = (SELECT roles.id FROM roles WHERE roles.code = 'customer')
  ) THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  UPDATE users SET
    first_name  = COALESCE(p_first_name,               users.first_name),
    last_name   = COALESCE(p_last_name,                users.last_name),
    phone       = COALESCE(p_phone,                    users.phone),
    email       = COALESCE(lower(trim(p_email)),       users.email),
    line_id     = COALESCE(p_line_id,                  users.line_id),
    referrer_id = COALESCE(p_referrer_id,              users.referrer_id),
    notes       = COALESCE(p_notes,                    users.notes),
    is_active   = COALESCE(p_is_active,                users.is_active),
    updated_at  = NOW()
  WHERE users.id = p_id
  RETURNING users.id, users.user_code, users.first_name, users.last_name,
            users.first_name || ' ' || users.last_name,
            users.phone, users.email, users.line_id, users.referrer_id, users.notes,
            users.is_active, users.created_at, users.updated_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.customers_deactivate(p_id uuid)
 RETURNS TABLE(ok boolean, message text)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_id AND role_id = (SELECT id FROM roles WHERE code = 'customer')) THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = p_id;
  RETURN QUERY SELECT TRUE, 'Customer deactivated'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.customer_wallets_list(p_user_id uuid)
 RETURNS TABLE(id uuid, user_id uuid, address text, is_whitelisted boolean, added_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = p_user_id
      AND u.role_id = (SELECT roles.id FROM roles WHERE roles.code = 'customer')
  ) THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  SELECT cw.id, cw.user_id, cw.address, cw.is_whitelisted, cw.added_at
  FROM customer_wallets cw
  WHERE cw.user_id = p_user_id
  ORDER BY cw.added_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.customer_wallets_add(p_user_id uuid, p_address text)
 RETURNS TABLE(id uuid, user_id uuid, address text, is_whitelisted boolean, added_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE v_wallet_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = p_user_id
      AND u.role_id = (SELECT roles.id FROM roles WHERE roles.code = 'customer')
  ) THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_address IS NULL OR trim(p_address) = '' THEN
    RAISE EXCEPTION 'Wallet address is required' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM customer_wallets cw WHERE LOWER(cw.address) = LOWER(trim(p_address))) THEN
    RAISE EXCEPTION 'Wallet address already registered' USING ERRCODE = '23505';
  END IF;
  INSERT INTO customer_wallets (user_id, address)
  VALUES (p_user_id, trim(p_address))
  RETURNING customer_wallets.id INTO v_wallet_id;
  RETURN QUERY
  SELECT cw.id, cw.user_id, cw.address, cw.is_whitelisted, cw.added_at
  FROM customer_wallets cw WHERE cw.id = v_wallet_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.customer_wallets_remove(p_wallet_id uuid)
 RETURNS TABLE(ok boolean, message text)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_wallets WHERE id = p_wallet_id) THEN
    RAISE EXCEPTION 'Wallet not found' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM customer_wallets WHERE id = p_wallet_id;
  RETURN QUERY SELECT TRUE, 'Wallet removed'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.customer_whitelist_upsert(
  p_address text,
  p_source character varying DEFAULT 'manual'::character varying,
  p_user_id uuid DEFAULT NULL::uuid
)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_lower TEXT    := lower(p_address);
  v_new   BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_wallets WHERE lower(address) = v_lower) THEN
    INSERT INTO customer_wallets(address, user_id, is_whitelisted, source)
    VALUES (v_lower, p_user_id, TRUE, p_source);
    v_new := TRUE;
  ELSE
    UPDATE customer_wallets
    SET is_whitelisted = TRUE,
        source         = COALESCE(p_source, source)
    WHERE lower(address) = v_lower;
  END IF;
  RETURN v_new;
END;
$function$;

-- Add the Customers menu entry, matching the legacy row's label/href/icon
-- but under a fresh id (V1's menus table already has its own ids -- reusing
-- the legacy uuid would be an arbitrary, meaningless coincidence, not a
-- meaningful link between the two separate databases). Grouped under
-- NFT Management (V1 has no separate Sales/Customer-Management module the
-- way the legacy DB did), slotted between NFT Lists (110) and NFT Waves (120).
INSERT INTO menus (label, href, icon, module, sort_order, is_active, module_label)
SELECT 'Customers', '/customers', 'users', 'nft_manage', 115, true, 'NFT Management'
WHERE NOT EXISTS (SELECT 1 FROM menus WHERE href = '/customers');

-- Permissions, matching the legacy route's requirePermission() calls exactly
-- (customers.view/create/edit/delete), granted to the same roles that
-- already manage NFT operations (nft_gen.* grantees).
INSERT INTO permissions (key, label, module, sort_order)
SELECT 'customers.view', 'View Customers', 'customers', 95
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'customers.view');
INSERT INTO permissions (key, label, module, sort_order)
SELECT 'customers.create', 'Create Customers', 'customers', 96
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'customers.create');
INSERT INTO permissions (key, label, module, sort_order)
SELECT 'customers.edit', 'Edit Customers', 'customers', 97
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'customers.edit');
INSERT INTO permissions (key, label, module, sort_order)
SELECT 'customers.delete', 'Deactivate Customers', 'customers', 98
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'customers.delete');

INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.code IN ('admin', 'operation', 'technical_team')
  AND p.key IN ('customers.view', 'customers.create', 'customers.edit', 'customers.delete')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- Sidebar visibility -- technical_team is the only role currently linked to
-- NFT Lists/Waves (sort_order 0 each); mirror that exactly for Customers.
INSERT INTO role_menus (role_id, menu_id, sort_order)
SELECT r.id, m.id, 0
FROM roles r
CROSS JOIN menus m
WHERE r.code = 'technical_team' AND m.href = '/customers'
  AND NOT EXISTS (
    SELECT 1 FROM role_menus rm WHERE rm.role_id = r.id AND rm.menu_id = m.id
  );
