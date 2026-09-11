import { Router } from "express";
import pool from "../../pool";
import { requirePermission } from "../../adminAuth";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "customers.view");

    const [nftStats, waveStats, customers, team] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE minted_at IS NULL)                    AS premint_count,
          COUNT(*) FILTER (WHERE minted_at IS NOT NULL AND NOT is_burned) AS minted_count,
          COALESCE(SUM(w.treasury_minted_count), 0)                    AS treasury_count
        FROM nft_records r
        LEFT JOIN nft_waves w ON w.collection_id = r.collection_id
      `),
      pool.query(`
        SELECT v.wave_number, v.wave_name, v.status, v.is_revealed, v.sold_count, v.quantity,
               c.name AS collection_name
        FROM v_wave_schedule_status v
        JOIN nft_collections c ON c.id = v.collection_id
        ORDER BY c.created_at DESC, v.wave_number
      `),
      pool.query(`
        SELECT u.user_code, u.first_name, u.last_name, ref.first_name AS referrer_first_name,
               ref.last_name AS referrer_last_name,
               COALESCE(array_agg(cw.address) FILTER (WHERE cw.address IS NOT NULL), '{}') AS wallets
        FROM users u
        JOIN roles r ON r.id = u.role_id AND r.code = 'customer'
        LEFT JOIN users ref ON ref.id = u.referrer_id
        LEFT JOIN customer_wallets cw ON cw.user_id = u.id
        GROUP BY u.id, ref.id
        ORDER BY u.created_at DESC
        LIMIT 200
      `),
      pool.query(`
        SELECT u.first_name, u.last_name, u.email, r.name AS role_name, u.is_active
        FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.code IN ('admin', 'operation', 'technical_team')
        ORDER BY r.code, u.first_name
      `),
    ]);

    res.json({
      nftStats: {
        premint:  Number(nftStats.rows[0]?.premint_count ?? 0),
        minted:   Number(nftStats.rows[0]?.minted_count ?? 0),
        treasury: Number(nftStats.rows[0]?.treasury_count ?? 0),
      },
      waves: waveStats.rows.map(w => ({
        collectionName: w.collection_name,
        waveNumber: w.wave_number,
        waveName: w.wave_name,
        status: w.status,
        isRevealed: w.is_revealed,
        soldCount: w.sold_count,
        quantity: w.quantity,
      })),
      customers: customers.rows.map(c => ({
        userCode: c.user_code,
        name: `${c.first_name} ${c.last_name}`.trim(),
        referrerName: c.referrer_first_name ? `${c.referrer_first_name} ${c.referrer_last_name}`.trim() : null,
        wallets: c.wallets,
      })),
      team: team.rows.map(t => ({
        name: `${t.first_name} ${t.last_name}`.trim(),
        email: t.email,
        role: t.role_name,
        isActive: t.is_active,
      })),
    });
  } catch (e) { next(e); }
});

export default router;
