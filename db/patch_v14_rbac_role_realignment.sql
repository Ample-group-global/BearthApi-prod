INSERT INTO permissions (key, label, module, sort_order)
VALUES
  ('nft_waves.view',   'View NFT Waves & Contract Sale Data', 'nft_waves', 10),
  ('nft_waves.manage', 'Manage NFT Waves (schedule, price, reveal, treasury)', 'nft_waves', 20)
ON CONFLICT (key) DO NOTHING;

DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE code IN ('admin', 'operation', 'technical_team'));

INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT r.id, p.id, TRUE
FROM roles r, permissions p
WHERE r.code = 'admin'
  AND p.key IN (
    'dashboard.view', 'nft_gen.view', 'nft_waves.view',
    'customers.view', 'users.view', 'settings.view'
  );

INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT r.id, p.id, TRUE
FROM roles r, permissions p
WHERE r.code = 'operation'
  AND p.key IN ('dashboard.view', 'customers.view', 'customers.create', 'customers.edit', 'customers.delete');

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

DELETE FROM role_menus
WHERE role_id IN (SELECT id FROM roles WHERE code IN ('admin', 'operation', 'technical_team'));

INSERT INTO role_menus (role_id, menu_id, sort_order)
SELECT r.id, m.id, 1
FROM roles r, menus m
WHERE r.code = 'admin' AND m.href = '/dashboard';

INSERT INTO role_menus (role_id, menu_id, sort_order)
SELECT r.id, m.id, ROW_NUMBER() OVER (ORDER BY m.sort_order)
FROM roles r, menus m
WHERE r.code = 'operation' AND m.href IN ('/dashboard', '/customers');

INSERT INTO role_menus (role_id, menu_id, sort_order)
SELECT r.id, m.id, ROW_NUMBER() OVER (ORDER BY m.sort_order)
FROM roles r, menus m
WHERE r.code = 'technical_team'
  AND m.href IN (
    '/dashboard', '/dashboard/generator', '/nft/nftlist', '/nft/waves',
    '/customers', '/admin/users', '/admin/roles', '/admin/permissions', '/admin/menus'
  );
