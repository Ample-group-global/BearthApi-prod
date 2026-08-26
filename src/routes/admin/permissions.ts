import { Router } from "express";
import { requirePermission } from "../../adminAuth";
import * as rbacService from "../../services/rbac.service";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "settings.view");
    const permissions = await rbacService.listPermissions();
    res.json({ permissions });
  } catch (e) { next(e); }
});

export default router;
