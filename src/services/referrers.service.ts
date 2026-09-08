import pool from "../pool";
import { toCamel } from "../utils/camel";

export async function listReferrers(search?: string | null) {
  const { rows } = await pool.query("SELECT * FROM referrers_list($1)", [search ?? null]);
  return toCamel(rows);
}

export async function listReferredBy(referrerId: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.user_code, u.first_name, u.last_name,
            TRIM(u.first_name || ' ' || u.last_name) AS name,
            u.phone, u.email, u.created_at,
            r.code AS role_code
     FROM users u
     JOIN roles r ON u.role_id = r.id
     WHERE u.referrer_id = $1::uuid AND u.is_active = TRUE
     ORDER BY u.created_at DESC`,
    [referrerId]
  );
  return toCamel(rows);
}

export async function createReferrer(params: {
  firstName: string; lastName?: string; phone?: string; email?: string;
}) {
  const { firstName, lastName, phone, email } = params;
  const { rows } = await pool.query("SELECT * FROM referrers_create($1, $2, $3, $4)", [firstName, lastName ?? null, phone ?? null, email ?? null]);
  return rows[0] ?? null;
}
