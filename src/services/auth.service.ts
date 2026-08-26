import authPool from "../auth-pool";
import bcrypt from "bcryptjs";
import { createHash } from "crypto";
import { encodeHmacToken, decodeHmacToken } from "../utils/hmac-token";

const _rawResetSecret = process.env.RESET_SECRET ?? process.env.AUTH_SECRET;
if (!_rawResetSecret) {
  throw new Error(
    "RESET_SECRET (or AUTH_SECRET) environment variable is not set. Refusing to start: " +
    "signing password-reset tokens without a real secret is a security hole, not a fallback.",
  );
}
const RESET_SECRET: string = _rawResetSecret;
export const RESET_EXPIRES_MS = 60 * 60 * 1000;
export const RESET_EXPIRES_MINUTES = RESET_EXPIRES_MS / 60_000;
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roleCode: string;
  passwordHash: string;
  isActive: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
}
interface AuthUserRow {
  id: string;
  email: string;
  name: string;
  role_code: string;
  password_hash: string;
  is_active: boolean;
  failed_login_count: number;
  locked_until: string | null;
}

export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export async function getUserByEmail(email: string): Promise<AuthUser | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { rows } = await authPool.query("SELECT * FROM users_get_by_email($1)", [email]);
      const row = rows[0] as AuthUserRow | undefined;
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        roleCode: row.role_code,
        passwordHash: row.password_hash,
        isActive: row.is_active,
        failedLoginCount: row.failed_login_count,
        lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
      };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const retryable =
        e.message?.includes("timeout exceeded") ||
        e.message?.includes("Connection terminated") ||
        e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT";
      if (retryable && attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1000));
        continue;
      }
      throw err;
    }
  }
  return null;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function updateLastLogin(userId: string): Promise<void> {
  await authPool.query(
    "UPDATE users SET last_login_at = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = $1::uuid",
    [userId],
  );
}

// Increments the failed-attempt counter and locks the account once it
// reaches MAX_FAILED_LOGIN_ATTEMPTS. Returns the updated count so the
// caller can decide what to tell the user.
export async function recordFailedLogin(userId: string): Promise<{ failedLoginCount: number; lockedUntil: Date | null }> {
  const { rows } = await authPool.query(
    `UPDATE users SET
       failed_login_count = failed_login_count + 1,
       locked_until = CASE
         WHEN failed_login_count + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval
         ELSE locked_until
       END
     WHERE id = $1::uuid
     RETURNING failed_login_count, locked_until`,
    [userId, MAX_FAILED_LOGIN_ATTEMPTS, LOCKOUT_MINUTES],
  );
  const row = rows[0] as { failed_login_count: number; locked_until: string | null };
  return { failedLoginCount: row.failed_login_count, lockedUntil: row.locked_until ? new Date(row.locked_until) : null };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createResetToken(userId: string, email: string): Promise<string> {
  const expiry = Date.now() + RESET_EXPIRES_MS;
  const token = encodeHmacToken(`${email}:${expiry}`, RESET_SECRET);
  await authPool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1::uuid, $2, $3)`,
    [userId, hashToken(token), new Date(expiry)],
  );
  return token;
}

// Verifies the token's signature/expiry AND atomically marks it used —
// a token can only ever be consumed once. Returns null for an invalid,
// expired, already-used, or unknown token.
export async function consumeResetToken(token: string): Promise<{ userId: string; email: string } | null> {
  const payload = decodeHmacToken(token, RESET_SECRET);
  if (!payload) return null;
  const [, expiryStr] = payload.split(":");
  if (!expiryStr || Date.now() > Number(expiryStr)) return null;

  const { rows } = await authPool.query(
    `UPDATE password_reset_tokens SET used_at = NOW()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING user_id`,
    [hashToken(token)],
  );
  const row = rows[0] as { user_id: string } | undefined;
  if (!row) return null;

  const { rows: userRows } = await authPool.query(
    "SELECT email FROM users WHERE id = $1::uuid AND is_active = true",
    [row.user_id],
  );
  const userRow = userRows[0] as { email: string } | undefined;
  if (!userRow) return null;
  return { userId: row.user_id, email: userRow.email };
}

export async function updatePassword(email: string, newPassword: string): Promise<boolean> {
  const hash = await bcrypt.hash(newPassword, 12);
  const { rowCount } = await authPool.query(
    "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2 AND is_active = true",
    [hash, email],
  );
  return (rowCount ?? 0) > 0;
}
