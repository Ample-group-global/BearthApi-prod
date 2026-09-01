import { Router } from "express";
import { signToken, verifyToken, AdminRole } from "../adminAuth";
import * as authService from "../services/auth.service";
import * as rbacService from "../services/rbac.service";
import { sendResetPasswordEmail } from "../services/email.service";

const router = Router();

router.post("/admin/login", async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) { res.status(400).json({ error: "Email and password are required" }); return; }
    const user = await authService.getUserByEmail(String(email));
    if (!user || !user.isActive || !user.passwordHash) {
      res.status(401).json({ error: "Invalid credentials" }); return;
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      res.status(423).json({
        error: `Account temporarily locked due to repeated failed logins. Try again after ${user.lockedUntil.toISOString()}.`,
      });
      return;
    }
    const valid = await authService.verifyPassword(String(password), user.passwordHash);
    if (!valid) {
      const { failedLoginCount, lockedUntil } = await authService.recordFailedLogin(user.id);
      if (lockedUntil) {
        res.status(423).json({
          error: `Account locked after ${failedLoginCount} failed attempts. Try again after ${lockedUntil.toISOString()}.`,
        });
        return;
      }
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const roleMap: Record<string, AdminRole> = {
      admin: "admin", technical_team: "tech", tech: "tech", operation: "ops", ops: "ops",
    };
    const adminRole = roleMap[user.roleCode];
    if (!adminRole) { res.status(403).json({ error: "Account does not have admin access" }); return; }
    await authService.updateLastLogin(user.id);
    const token = signToken(adminRole, user.id);
    res.json({ token, role: adminRole, userId: user.id, success: true });
  } catch (e) { next(e); }
});

router.post("/admin/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (!email) { res.status(400).json({ error: "Email is required" }); return; }
    const user = await authService.getUserByEmail(String(email));
    if (!user || !user.isActive) {
      res.json({ success: true }); return;
    }
    const token = await authService.createResetToken(user.id, user.email);
    const adminUrl = process.env.ADMIN_URL ?? "http://localhost:3000";
    const resetLink = `${adminUrl}/reset-password?token=${token}`;
    await sendResetPasswordEmail(user.email, resetLink, user.name, authService.RESET_EXPIRES_MINUTES);
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post("/admin/reset-password", async (req, res, next) => {
  try {
    const { token, password } = req.body ?? {};
    if (!token || !password) { res.status(400).json({ error: "Token and password are required" }); return; }
    if (String(password).length < 8) { res.status(400).json({ error: "Password must be at least 8 characters" }); return; }
    const result = await authService.consumeResetToken(String(token));
    if (!result) { res.status(400).json({ error: "Invalid, expired, or already-used reset link. Please request a new one." }); return; }
    const updated = await authService.updatePassword(result.email, String(password));
    if (!updated) { res.status(404).json({ error: "Account not found or inactive." }); return; }
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.get("/admin/me", async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "Unauthorized" }); return; }
    const result = verifyToken(auth.slice(7));
    if (!result) { res.status(401).json({ error: "Invalid or expired token" }); return; }
    const context = await rbacService.getUserContext(result.userId);
    if (!context) { res.status(401).json({ error: "User not found or inactive" }); return; }
    res.json({ authenticated: true, ...context });
  } catch (e) { next(e); }
});

export default router;
