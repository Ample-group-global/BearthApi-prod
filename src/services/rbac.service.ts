import pool from "../pool";
import authPool from "../auth-pool";

export interface UserContext {
  userId: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
  menus: Array<{ label: string; href: string; icon?: string | null; module?: string | null; moduleLabel?: string | null; sortOrder: number }>;
}

export async function getUserContext(userId: string): Promise<UserContext | null> {
  // Get user + role
  const { rows: userRows } = await authPool.query(
    `SELECT u.id, r.code AS role_code, r.name AS role_name
     FROM users u LEFT JOIN roles r ON u.role_id = r.id
     WHERE u.id = $1::uuid AND u.is_active = TRUE`,
    [userId]
  );
  if (!userRows[0]) return null;
  const user = userRows[0] as { id: string; role_code: string; role_name: string };

  // Get permissions: role perms + overrides
  const { rows: permRows } = await authPool.query(
    `SELECT DISTINCT p.key
     FROM permissions p
     WHERE (
       EXISTS (
         SELECT 1 FROM role_permissions rp
         WHERE rp.permission_id = p.id AND rp.role_id = (SELECT role_id FROM users WHERE id = $1::uuid) AND rp.is_granted = TRUE
       )
       OR EXISTS (
         SELECT 1 FROM user_permission_overrides upo
         WHERE upo.permission_id = p.id AND upo.user_id = $1::uuid AND upo.is_granted = TRUE
       )
     )
     AND NOT EXISTS (
       SELECT 1 FROM user_permission_overrides upo
       WHERE upo.permission_id = p.id AND upo.user_id = $1::uuid AND upo.is_granted = FALSE
     )`,
    [userId]
  );
  const permissions = permRows.map((r: { key: string }) => r.key);

  // Get menus for this role
  const { rows: menuRows } = await authPool.query(
    `SELECT m.label, m.href, m.icon, m.module, m.module_label, rm.sort_order
     FROM menus m
     JOIN role_menus rm ON rm.menu_id = m.id
     JOIN roles r ON rm.role_id = r.id
     WHERE r.id = (SELECT role_id FROM users WHERE id = $1::uuid)
       AND m.is_active = TRUE
     ORDER BY rm.sort_order ASC`,
    [userId]
  );
  const menus = menuRows.map((r: { label: string; href: string; icon: string | null; module: string | null; module_label: string | null; sort_order: number }) => ({
    label: r.label, href: r.href, icon: r.icon, module: r.module, moduleLabel: r.module_label, sortOrder: r.sort_order,
  }));

  return { userId: user.id, roleCode: user.role_code, roleName: user.role_name, permissions, menus };
}

export async function listRoles() {
  const { rows } = await pool.query("SELECT id, code, name, home_url, is_active FROM roles WHERE code != 'customer' ORDER BY name");
  return rows;
}

export async function listPermissions() {
  const { rows } = await pool.query("SELECT id, key, label, module, sort_order FROM permissions ORDER BY sort_order, module, key");
  return rows;
}

export async function getRolePermissions(roleId: string) {
  const { rows } = await pool.query(
    `SELECT p.id, p.key, p.label, p.module, p.sort_order, rp.is_granted
     FROM permissions p
     LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = $1::uuid
     ORDER BY p.sort_order, p.module, p.key`,
    [roleId]
  );
  return rows;
}

export async function setRolePermission(roleId: string, permissionId: string, isGranted: boolean) {
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id, is_granted)
     VALUES ($1::uuid, $2::uuid, $3)
     ON CONFLICT (role_id, permission_id) DO UPDATE SET is_granted = $3`,
    [roleId, permissionId, isGranted]
  );
}

export async function listMenus() {
  const { rows } = await pool.query("SELECT id, label, href, icon, module, module_label, sort_order, is_active FROM menus ORDER BY sort_order");
  return rows;
}

export async function toggleMenuActive(menuId: string, isActive: boolean) {
  const { rowCount } = await pool.query(
    "UPDATE menus SET is_active = $1 WHERE id = $2::uuid",
    [isActive, menuId]
  );
  if (!rowCount) throw Object.assign(new Error("Menu not found"), { status: 404 });
}

export async function getRoleMenus(roleId: string) {
  const { rows } = await pool.query(
    `SELECT m.id, m.label, m.href, m.icon, m.module, m.module_label, m.is_active, rm.sort_order
     FROM menus m
     LEFT JOIN role_menus rm ON rm.menu_id = m.id AND rm.role_id = $1::uuid
     ORDER BY COALESCE(rm.sort_order, m.sort_order)`,
    [roleId]
  );
  return rows;
}

export async function setRoleMenus(roleId: string, menuIds: string[]) {
  await pool.query("DELETE FROM role_menus WHERE role_id = $1::uuid", [roleId]);
  for (let i = 0; i < menuIds.length; i++) {
    await pool.query(
      "INSERT INTO role_menus (role_id, menu_id, sort_order) VALUES ($1::uuid, $2::uuid, $3)",
      [roleId, menuIds[i], i]
    );
  }
}
