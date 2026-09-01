import { Request, Response, NextFunction } from "express";
import { HttpError } from "./errors";
import { encodeHmacToken, decodeHmacToken } from "./utils/hmac-token";
import * as rbacService from "./services/rbac.service";

const _rawSecret = process.env.AUTH_SECRET;
if (!_rawSecret) {
  throw new Error(
    "AUTH_SECRET environment variable is not set. Refusing to start: " +
    "signing admin tokens without a real secret is a security hole, not a fallback.",
  );
}
const SECRET: string = _rawSecret;

export type AdminRole = "admin" | "ops" | "tech";

declare global {
  namespace Express {
    interface Request {
      userCtx?: {
        userId: string;
        roleCode: string;
        permissions: string[];
      };
    }
  }
}
export async function loadUserContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearer(req);
    if (!token) { next(); return; }
    const decoded = verifyToken(token);
    if (!decoded) { next(); return; }
    const context = await rbacService.getUserContext(decoded.userId);
    if (context) {
      req.userCtx = { userId: context.userId, roleCode: context.roleCode, permissions: context.permissions };
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function signToken(role: AdminRole, userId: string): string {
  return encodeHmacToken(`${userId}:${role}:${Date.now()}`, SECRET);
}

export function verifyToken(token: string): { role: AdminRole; userId: string } | null {
  const payload = decodeHmacToken(token, SECRET);
  if (!payload) return null;
  const parts = payload.split(":");
  if (parts.length < 3) return null;
  const [userId, role] = parts;
  if (role !== "admin" && role !== "tech" && role !== "ops") return null;
  return { role: role as AdminRole, userId };
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export function requireRole(req: Request): { role: AdminRole; userId: string } {
  const token = extractBearer(req);
  if (!token) throw new HttpError(401, "Unauthorized");
  const result = verifyToken(token);
  if (!result) throw new HttpError(401, "Invalid or expired token");
  // loadUserContext runs ahead of every route (see index.ts) and only
  // attaches userCtx when the user still exists and is active in the DB —
  // a missing userCtx here means the account was deactivated/deleted
  // since the token was issued.
  if (!req.userCtx || req.userCtx.userId !== result.userId) {
    throw new HttpError(401, "Account not found or inactive");
  }
  return result;
}

export function requirePermission(req: Request, permission: string): { role: AdminRole; userId: string } {
  const result = requireRole(req);
  if (!req.userCtx!.permissions.includes(permission)) {
    throw new HttpError(403, "Forbidden — insufficient permissions");
  }
  return result;
}
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  try {
    requireRole(req);
    next();
  } catch (err) {
    next(err);
  }
}
