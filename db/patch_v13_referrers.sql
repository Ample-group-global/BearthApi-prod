-- Referrer picker for the Customers form -- confirmed with the user this is
-- a broad concept, not a separate "referrer accounts" list: a customer can
-- refer another customer, an AMG team member (admin/operation/technical_team/
-- sales_team) can refer anyone, or a dedicated external referrer
-- (ext_referrer role) can refer anyone. referrers_list() already reflects
-- exactly this eligibility set -- ported unchanged from legacy. referrers_
-- create() covers onboarding a brand-new external referral partner who has
-- no other account yet (gets an EX### code under the ext_referrer role).

CREATE SEQUENCE IF NOT EXISTS seq_user_ex START 1;

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
         OR u.email        ILIKE '%' || p_search || '%')
  ORDER BY r.code, u.user_code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.referrers_create(p_first_name character varying, p_last_name character varying DEFAULT NULL::character varying, p_phone character varying DEFAULT NULL::character varying, p_email character varying DEFAULT NULL::character varying)
 RETURNS TABLE(id uuid, referrer_code character varying, first_name character varying, last_name character varying, name text, phone character varying, email character varying)
 LANGUAGE plpgsql
AS $function$
DECLARE v_role_id UUID; v_ref_id UUID; v_code VARCHAR(10);
BEGIN
  IF p_first_name IS NULL OR TRIM(p_first_name) = '' THEN
    RAISE EXCEPTION 'First name is required' USING ERRCODE = 'P0001';
  END IF;
  SELECT roles.id INTO v_role_id FROM roles WHERE roles.code = 'ext_referrer';
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Ext-Referrer role not configured' USING ERRCODE = 'P0002';
  END IF;
  v_code := 'EX' || LPAD(nextval('seq_user_ex')::TEXT, 3, '0');
  INSERT INTO users (user_code, first_name, last_name, phone, email, role_id)
  VALUES (
    v_code,
    TRIM(p_first_name),
    COALESCE(TRIM(p_last_name), ''),
    NULLIF(TRIM(p_phone), ''),
    NULLIF(LOWER(TRIM(p_email)), ''),
    v_role_id
  )
  RETURNING users.id INTO v_ref_id;
  RETURN QUERY
  SELECT u.id, u.user_code AS referrer_code,
         u.first_name, u.last_name,
         TRIM(u.first_name || ' ' || u.last_name) AS name,
         u.phone, u.email
  FROM users u WHERE u.id = v_ref_id;
END;
$function$;
