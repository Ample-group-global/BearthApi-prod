import { Router } from "express";
import { requirePermission } from "../../adminAuth";
import * as usersService from "../../services/users.service";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "users.view");
    const result = await usersService.listUsers({
      search: (req.query.search as string) ?? null,
      limit:  Number(req.query.limit  ?? 100),
      offset: Number(req.query.offset ?? 0),
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "users.view");
    const data = await usersService.getUser(req.params.id);
    if (!data) { res.status(404).json({ error: "User not found" }); return; }
    res.json(data);
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    requirePermission(req, "users.create");
    const { email, firstName, lastName, phone, roleId, password } = req.body ?? {};
    if (!password || String(password).length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" }); return;
    }
    const user = await usersService.createUser({ email, firstName, lastName, phone, roleId, password });
    res.status(201).json({ user });
  } catch (e) { next(e); }
});

router.put("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "users.edit");
    const { email, firstName, lastName, phone, roleId, isActive } = req.body ?? {};
    const user = await usersService.updateUser(req.params.id, {
      email, firstName, lastName, phone, roleId, isActive,
    });
    res.json({ user });
  } catch (e) { next(e); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "users.delete");
    const result = await usersService.deactivateUser(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/:id/permissions", async (req, res, next) => {
  try {
    requirePermission(req, "users.view");
    const permissions = await usersService.getPermissionOverrides(req.params.id);
    res.json({ permissions });
  } catch (e) { next(e); }
});

router.post("/:id/permissions", async (req, res, next) => {
  try {
    requirePermission(req, "users.revoke_permission");
    const { permissionId, isGranted, reason } = req.body ?? {};
    const override = await usersService.setPermissionOverride(req.params.id, permissionId, isGranted, reason);
    res.json({ override });
  } catch (e) { next(e); }
});

router.delete("/:id/permissions/:permissionId", async (req, res, next) => {
  try {
    requirePermission(req, "users.revoke_permission");
    await usersService.removePermissionOverride(req.params.id, req.params.permissionId);
    res.json({ success: true });
  } catch (e) { next(e); }
});

export default router;
