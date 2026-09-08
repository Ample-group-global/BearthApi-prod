import { Router } from "express";
import { requirePermission } from "../adminAuth";
import * as customersService from "../services/customers.service";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+\d\s\-().]{6,20}$/;

function validateCustomerBody(body: Record<string, unknown>, requireContact = false): string | null {
  const firstName = (body.firstName as string | undefined)?.trim() ?? "";
  if (!firstName) return "First name is required.";
  const lastName = (body.lastName as string | undefined)?.trim() ?? "";
  if (!lastName) return "Last name is required.";
  const phone  = (body.phone  as string | undefined)?.trim() ?? "";
  const email  = (body.email  as string | undefined)?.trim() ?? "";
  const lineId = (body.lineId as string | undefined)?.trim() ?? "";
  if (requireContact && !phone && !email && !lineId)
    return "At least one contact method is required: Phone, Email, or LINE ID.";
  if (phone && !PHONE_RE.test(phone)) return "Phone number is not valid.";
  if (email && !EMAIL_RE.test(email)) return "Email address is not valid.";
  return null;
}

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "customers.view");
    const result = await customersService.listCustomers({
      search:     (req.query.search   as string) ?? null,
      activeOnly: req.query.active !== "false",
      limit:      Number(req.query.limit  ?? 20),
      offset:     Number(req.query.offset ?? 0),
      sortBy:     (req.query.sort_by  as string) ?? "created_at",
      sortDir:    (req.query.sort_dir as string) ?? "desc",
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    requirePermission(req, "customers.create");
    const err = validateCustomerBody(req.body ?? {}, true);
    if (err) { res.status(422).json({ error: err }); return; }
    const { firstName, lastName, phone, email, lineId, referrerId, notes } = req.body ?? {};
    const customer = await customersService.createCustomer({
      firstName, lastName, phone, email, lineId, referrerId, notes,
    });
    res.status(201).json({ customer });
  } catch (e) { next(e); }
});

router.get("/wallet-status", async (req, res, next) => {
  try {
    requirePermission(req, "customers.view");
    const wallets = await customersService.listAllCustomerWallets();
    res.json({ wallets });
  } catch (e) { next(e); }
});

router.get("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "customers.view");
    const data = await customersService.getCustomer(req.params.id);
    if (!data) { res.status(404).json({ error: "Customer not found" }); return; }
    res.json(data);
  } catch (e) { next(e); }
});

router.put("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "customers.edit");
    const body = req.body ?? {};
    const err = validateCustomerBody(body, true);
    if (err) { res.status(422).json({ error: err }); return; }
    const { firstName, lastName, phone, email, lineId, referrerId, notes, isActive } = body;
    const customer = await customersService.updateCustomer(req.params.id, {
      firstName, lastName, phone, email, lineId, referrerId, notes, isActive,
    });
    res.json({ customer });
  } catch (e) { next(e); }
});

router.patch("/:id/status", async (req, res, next) => {
  try {
    requirePermission(req, "customers.edit");
    const { isActive } = req.body ?? {};
    if (typeof isActive !== "boolean") { res.status(422).json({ error: "isActive must be a boolean." }); return; }
    const result = await customersService.setCustomerStatus(req.params.id, isActive);
    if (!result) { res.status(404).json({ error: "Customer not found." }); return; }
    res.json(result);
  } catch (e) { next(e); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "customers.delete");
    const result = await customersService.deactivateCustomer(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/:id/wallets", async (req, res, next) => {
  try {
    requirePermission(req, "customers.view");
    const wallets = await customersService.listCustomerWallets(req.params.id);
    res.json({ wallets });
  } catch (e) { next(e); }
});

router.post("/:id/wallets", async (req, res, next) => {
  try {
    requirePermission(req, "customers.edit");
    const { address } = req.body ?? {};
    const wallet = await customersService.addCustomerWallet(req.params.id, address ?? null);
    res.status(201).json({ wallet });
  } catch (e) { next(e); }
});

router.delete("/:id/wallets/:walletId", async (req, res, next) => {
  try {
    requirePermission(req, "customers.edit");
    const result = await customersService.removeCustomerWallet(req.params.walletId);
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
