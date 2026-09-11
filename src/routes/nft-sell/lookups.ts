import { Router } from "express";
import pool from "../../pool";
import { requirePermission } from "../../adminAuth";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const { rows } = await pool.query<{ category: string; code: string; label: string; symbol: string | null; tag: string | null }>(
      `SELECT category, code, label, symbol, tag FROM lookup_values
       WHERE category IN ('nft_sale_mode', 'nft_payment_currency') AND is_active = true
       ORDER BY category, sort_order`,
    );
    const saleModes = rows
      .filter(r => r.category === "nft_sale_mode")
      .map(r => ({ code: r.code, label: r.label, category: r.tag ?? "other" }));
    const currencies = rows
      .filter(r => r.category === "nft_payment_currency")
      .map(r => ({ code: r.code, label: r.label, symbol: r.symbol ?? r.code }));
    res.json({ saleModes, currencies });
  } catch (e) { next(e); }
});

router.get("/wave-sale-methods", async (req, res, next) => {
  try {
    requirePermission(req, "nft_waves.view");
    const { rows } = await pool.query<{ code: string; label: string }>(
      `SELECT code, label FROM lookup_values
       WHERE category = 'nft_wave_sale_method' AND is_active = true
       ORDER BY sort_order`,
    );
    res.json({ saleMethods: rows });
  } catch (e) { next(e); }
});

export default router;
