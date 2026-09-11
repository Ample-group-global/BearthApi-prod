INSERT INTO permissions (id, key, label, module, description, sort_order) VALUES
  ('b3e1a6c2-1f0a-4b8a-9c2a-1a2b3c4d5e01', 'users.view',              'View Users',              'users', NULL, 100),
  ('b3e1a6c2-1f0a-4b8a-9c2a-1a2b3c4d5e02', 'users.create',            'Create Users',            'users', NULL, 101),
  ('b3e1a6c2-1f0a-4b8a-9c2a-1a2b3c4d5e03', 'users.edit',              'Edit Users',              'users', NULL, 102),
  ('b3e1a6c2-1f0a-4b8a-9c2a-1a2b3c4d5e04', 'users.delete',            'Deactivate Users',        'users', NULL, 103),
  ('b3e1a6c2-1f0a-4b8a-9c2a-1a2b3c4d5e05', 'users.revoke_permission', 'Manage Permission Overrides', 'users', NULL, 104),
  ('b3e1a6c2-1f0a-4b8a-9c2a-1a2b3c4d5e06', 'settings.view',           'View RBAC Settings',      'admin', NULL, 110),
  ('b3e1a6c2-1f0a-4b8a-9c2a-1a2b3c4d5e07', 'settings.edit',           'Edit RBAC Settings',      'admin', NULL, 111)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT '3d658c1b-2930-4873-a4d1-119d4970ea5c', id, TRUE FROM permissions
ON CONFLICT (role_id, permission_id) DO UPDATE SET is_granted = TRUE;

INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT 'ef13b0ba-480f-4b06-8cb0-8695140b4b63', id, TRUE FROM permissions
WHERE key IN ('users.view','users.create','users.edit','users.delete','users.revoke_permission','settings.view','settings.edit')
ON CONFLICT (role_id, permission_id) DO UPDATE SET is_granted = TRUE;

INSERT INTO role_permissions (role_id, permission_id, is_granted)
SELECT '03b48ae7-afbe-4bf6-88cf-26ffe61bf90d', id, TRUE FROM permissions
WHERE key IN ('users.view','users.create','users.edit','users.delete','users.revoke_permission','settings.view')
ON CONFLICT (role_id, permission_id) DO UPDATE SET is_granted = TRUE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
