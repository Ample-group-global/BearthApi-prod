import { Router } from "express";
import { requirePermission } from "../../adminAuth";
import * as rbacService from "../../services/rbac.service";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "settings.view");
    const roles = await rbacService.listRoles();
    res.json({ roles });
  } catch (e) { next(e); }
});

router.get("/:id/permissions", async (req, res, next) => {
  try {
    requirePermission(req, "settings.view");
    const permissions = await rbacService.getRolePermissions(req.params.id);
    res.json({ permissions });
  } catch (e) { next(e); }
});

router.put("/:id/permissions", async (req, res, next) => {
  try {
    requirePermission(req, "settings.edit");
    const { permissionId, isGranted } = req.body ?? {};
    if (!permissionId || typeof isGranted !== "boolean") {
      res.status(422).json({ error: "permissionId and isGranted (boolean) are required" }); return;
    }
    await rbacService.setRolePermission(req.params.id, permissionId, isGranted);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get("/:id/menus", async (req, res, next) => {
  try {
    requirePermission(req, "settings.view");
    const menus = await rbacService.getRoleMenus(req.params.id);
    res.json({ menus });
  } catch (e) { next(e); }
});

router.put("/:id/menus", async (req, res, next) => {
  try {
    requirePermission(req, "settings.edit");
    const { menuIds } = req.body ?? {};
    if (!Array.isArray(menuIds)) {
      res.status(422).json({ error: "menuIds must be an array of UUIDs" }); return;
    }
    await rbacService.setRoleMenus(req.params.id, menuIds as string[]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
