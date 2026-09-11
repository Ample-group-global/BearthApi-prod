DROP FUNCTION IF EXISTS public.users_get_by_email(text);

CREATE FUNCTION public.users_get_by_email(p_email text)
 RETURNS TABLE(
   id uuid, email character varying, name character varying,
   role_code character varying, password_hash text, is_active boolean,
   failed_login_count integer, locked_until timestamptz
 )
 LANGUAGE sql
AS $function$
  SELECT u.id, u.email,
         u.first_name || ' ' || u.last_name AS name,
         r.code AS role_code, u.password_hash, u.is_active,
         u.failed_login_count, u.locked_until
  FROM users u
  LEFT JOIN roles r ON u.role_id = r.id
  WHERE u.email = p_email;
$function$;
