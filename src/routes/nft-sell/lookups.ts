import { Router } from "express";
import pool from "../../pool";
import { requireAdmin } from "../../adminAuth";

const router = Router();

// GET /api/nft-sell/lookups/wave-sale-methods — labels for nft_waves.sale_method
// codes (free_mint, fixed_price, ...), backed by lookup_values so the Waves
// page can show "Free Mint" instead of the raw DB code. Was previously called
// by the frontend but never implemented here, so it silently 404'd and the
// table fell back to printing the raw snake_case code.
router.get("/wave-sale-methods", requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query<{ code: string; label: string }>(
      `SELECT code, label FROM lookup_values
       WHERE category = 'nft_wave_sale_method' AND is_active = true
       ORDER BY sort_order`,
    );
    res.json({ saleMethods: rows });
  } catch (e) { next(e); }
});

export default router;
