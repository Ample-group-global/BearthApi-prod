import pool from "../pool";
import { toCamel } from "../utils/camel";
import bcrypt from "bcryptjs";

export async function listUsers(params: { search?: string | null; limit?: number; offset?: number }) {
  const { search = null, limit = 100, offset = 0 } = params;
  const { rows } = await pool.query("SELECT * FROM users_list($1, $2, $3)", [search, limit, offset]);
  return { users: toCamel(rows), total: Number(rows[0]?.total_count ?? 0), limit, offset };
}

export async function getUser(id: string) {
  const { rows } = await pool.query("SELECT users_get($1::uuid) AS data", [id]);
  return rows[0]?.data ?? null;
}

export async function createUser(params: {
  email: string; firstName?: string; lastName?: string; phone?: string; roleId?: string; password?: string;
}) {
  const { email, firstName, lastName, phone, roleId, password } = params;
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  const { rows } = await pool.query("SELECT * FROM users_create($1, $2, $3, $4, $5, $6)", [email, firstName ?? null, lastName ?? null, phone ?? null, roleId ?? null, passwordHash]);
  return rows[0] ?? null;
}

export async function updateUser(id: string, params: {
  email?: string; firstName?: string; lastName?: string;
  phone?: string; roleId?: string; isActive?: boolean;
}) {
  const { email, firstName, lastName, phone, roleId, isActive } = params;
  const { rows } = await pool.query("SELECT * FROM users_update($1, $2, $3, $4, $5, $6, $7)", [id, email ?? null, firstName ?? null, lastName ?? null, phone ?? null, roleId ?? null, isActive ?? null]);
  return rows[0] ?? null;
}

export async function setPermissionOverride(userId: string, permissionId: string, isGranted: boolean, reason?: string) {
  const { rows } = await pool.query("SELECT * FROM users_set_permission_override($1::uuid, $2, $3, $4)", [userId, permissionId, isGranted, reason ?? null]);
  return rows[0] ?? null;
}

export async function getPermissionOverrides(userId: string) {
  const { rows } = await pool.query(
    `SELECT p.id, p.key, p.label, p.module,
            upo.id AS override_id, upo.is_granted, upo.reason, upo.actioned_at
     FROM permissions p
     LEFT JOIN user_permission_overrides upo
       ON upo.permission_id = p.id AND upo.user_id = $1::uuid
     ORDER BY p.module, p.key`,
    [userId]
  );
  return toCamel(rows);
}

export async function removePermissionOverride(userId: string, permissionId: string) {
  await pool.query("DELETE FROM user_permission_overrides WHERE user_id = $1::uuid AND permission_id = $2::uuid", [userId, permissionId]);
}

export async function deactivateUser(id: string) {
  const { rows } = await pool.query("SELECT * FROM users_deactivate($1::uuid)", [id]);
  return rows[0] ?? null;
}
