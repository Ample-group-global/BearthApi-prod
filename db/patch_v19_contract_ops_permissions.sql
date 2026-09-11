INSERT INTO permissions (key, label, module, sort_order)
VALUES
  ('contract_ops.view',   'View Contract Operations (mint ops, royalty, sales, membership)', 'contract_ops', 10),
  ('contract_ops.manage', 'Manage Contract Operations (mint, treasury, royalty, sales, membership)', 'contract_ops', 20)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT r.id, p.id, TRUE
FROM roles r, permissions p
WHERE r.code = 'technical_team'
  AND p.key IN ('contract_ops.view', 'contract_ops.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;
