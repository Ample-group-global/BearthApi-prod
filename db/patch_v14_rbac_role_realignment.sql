-- patch_v14_rbac_role_realignment.sql
-- Realigns admin/operation/technical_team access to the locked design (2026-09-07):
--   admin           = view-only everywhere, zero actions, including over RBAC itself
--   operation       = Customers only, full action access, nothing else
--   technical_team  = full action access everywhere (NFT Studio/Lists/Waves, Customers,
--                      Team/Admin Users, Roles, Permissions, Menu Manager)
-- Also adds nft_waves.view / nft_waves.manage -- the first real permission keys for
-- wave/contract-sale operations, which previously had none (routes were gated only by
-- "is any admin-panel role logged in", not a specific permission).

-- === New permission keys for wave operations ===
INSERT INTO permissions (key, label, module, sort_order)
VALUES
  ('nft_waves.view',   'View NFT Waves & Contract Sale Data', 'nft_waves', 10),
  ('nft_waves.manage', 'Manage NFT Waves (schedule, price, reveal, treasury)', 'nft_waves', 20)
ON CONFLICT (key) DO NOTHING;

-- === Reset role_permissions for the 3 staff roles to a known-clean state ===
DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE code IN ('admin', 'operation', 'technical_team'));

-- admin: view-only, everywhere, including RBAC itself
INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT r.id, p.id, TRUE
FROM roles r, permissions p
WHERE r.code = 'admin'
  AND p.key IN (
    'dashboard.view', 'nft_gen.view', 'nft_waves.view',
    'customers.view', 'users.view', 'settings.view'
  );

-- operation: Customers only (their "minimum necessary operation")
INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT r.id, p.id, TRUE
FROM roles r, permissions p
WHERE r.code = 'operation'
  AND p.key IN ('dashboard.view', 'customers.view', 'customers.create', 'customers.edit', 'customers.delete');

-- technical_team: everything (de facto superuser of the admin panel)
INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT r.id, p.id, TRUE
FROM roles r, permissions p
WHERE r.code = 'technical_team'
  AND p.key IN (
    'dashboard.view',
    'nft_gen.view', 'nft_gen.manage_collections', 'nft_gen.manage_layers', 'nft_gen.generate', 'nft_gen.upload_ipfs',
    'nft_waves.view', 'nft_waves.manage',
    'customers.view', 'customers.create', 'customers.edit', 'customers.delete',
    'users.view', 'users.create', 'users.edit', 'users.delete', 'users.revoke_permission',
    'settings.view', 'settings.edit'
  );

-- === Reset role_menus for the 3 staff roles to match the locked matrix ===
DELETE FROM role_menus
WHERE role_id IN (SELECT id FROM roles WHERE code IN ('admin', 'operation', 'technical_team'));

-- admin: Dashboard only (extended with read-only stats sections -- no separate action pages)
INSERT INTO role_menus (role_id, menu_id, sort_order)
SELECT r.id, m.id, 1
FROM roles r, menus m
WHERE r.code = 'admin' AND m.href = '/dashboard';

-- operation: Dashboard + Customers
INSERT INTO role_menus (role_id, menu_id, sort_order)
SELECT r.id, m.id, ROW_NUMBER() OVER (ORDER BY m.sort_order)
FROM roles r, menus m
WHERE r.code = 'operation' AND m.href IN ('/dashboard', '/customers');

-- technical_team: everything
INSERT INTO role_menus (role_id, menu_id, sort_order)
SELECT r.id, m.id, ROW_NUMBER() OVER (ORDER BY m.sort_order)
FROM roles r, menus m
WHERE r.code = 'technical_team'
  AND m.href IN (
    '/dashboard', '/dashboard/generator', '/nft/nftlist', '/nft/waves',
    '/customers', '/admin/users', '/admin/roles', '/admin/permissions', '/admin/menus'
  );
