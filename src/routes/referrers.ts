import { Router } from "express";
import { requirePermission } from "../adminAuth";
import * as referrersService from "../services/referrers.service";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "customers.view");
    const referrers = await referrersService.listReferrers((req.query.search as string) ?? null);
    res.json({ referrers });
  } catch (e) { next(e); }
});

router.get("/:id/referred", async (req, res, next) => {
  try {
    requirePermission(req, "customers.view");
    const referred = await referrersService.listReferredBy(req.params.id);
    res.json({ referred });
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    requirePermission(req, "customers.create");
    const { firstName, lastName, phone, email } = req.body ?? {};
    const referrer = await referrersService.createReferrer({ firstName, lastName, phone, email });
    res.status(201).json({ referrer });
  } catch (e) { next(e); }
});

export default router;
