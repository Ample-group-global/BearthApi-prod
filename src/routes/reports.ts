import { Router } from "express";
import pool from "../pool";
import { requirePermission } from "../adminAuth";
import { getContractReadOnlyForCollection } from "../services/contract.service";

const router = Router();

// Quick wave/selling summary for one selected collection -- this is the one
// thing neither NFT Records nor the Waves management page show as a single
// glance: per-wave sold-count and revenue side by side. Waves page itself is
// for managing a wave (schedule/reveal/limits); this is read-only monitoring.
router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "customers.view");
    const collectionId = (req.query.collection_id as string) || null;

    const customersPromise = pool.query(
      `SELECT COUNT(DISTINCT cw.user_id)::int AS holders
         FROM customer_wallets cw
         JOIN nft_records nr ON LOWER(nr.owner_address) = LOWER(cw.address)
        WHERE ($1::uuid IS NULL OR nr.collection_id = $1)`,
      [collectionId],
    );

    const wavesPromise = collectionId
      ? pool.query(
          `SELECT wave_number, name, default_price_eth, quantity, sold_count, sale_method, status
             FROM nft_waves WHERE collection_id = $1 ORDER BY wave_number`,
          [collectionId],
        )
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> });

    // Per-wallet quick summary: which customer, is that wallet whitelisted
    // for this collection, and a per-wave breakdown of what it actually
    // minted here (quantity + price paid in each wave).
    const walletsPromise = collectionId
      ? pool.query(
          `SELECT
             TRIM(u.first_name || ' ' || u.last_name) AS customer_name,
             cw.address,
             EXISTS(
               SELECT 1 FROM nft_collection_whitelist wl
                WHERE wl.collection_id = $1 AND LOWER(wl.wallet_address) = LOWER(cw.address)
             ) AS whitelisted,
             nr.wave_num,
             w.name AS wave_name,
             w.default_price_eth,
             w.sale_method,
             COUNT(nr.id) FILTER (WHERE nr.id IS NOT NULL)::int AS qty
           FROM customer_wallets cw
           JOIN users u ON u.id = cw.user_id
           LEFT JOIN nft_records nr ON LOWER(nr.owner_address) = LOWER(cw.address) AND nr.collection_id = $1
           LEFT JOIN nft_waves w ON w.collection_id = $1 AND w.wave_number = nr.wave_num
           GROUP BY u.first_name, u.last_name, cw.address, nr.wave_num, w.name, w.default_price_eth, w.sale_method
           ORDER BY customer_name, nr.wave_num`,
          [collectionId],
        )
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> });

    const [customersRow, wavesRows, walletsRows] = await Promise.all([customersPromise, wavesPromise, walletsPromise]);

    interface WaveBreakdown { waveNumber: number; waveName: string; priceEth: number; qty: number; spentEth: number; }
    const walletMap = new Map<string, { customerName: string; address: string; whitelisted: boolean; perWave: WaveBreakdown[] }>();
    for (const row of walletsRows.rows) {
      const key = String(row.address).toLowerCase();
      if (!walletMap.has(key)) {
        walletMap.set(key, {
          customerName: (row.customer_name as string) || "(no name)",
          address: row.address as string,
          whitelisted: !!row.whitelisted,
          perWave: [],
        });
      }
      if (row.wave_num != null) {
        const price = Number(row.default_price_eth ?? 0);
        const qty = Number(row.qty ?? 0);
        walletMap.get(key)!.perWave.push({
          waveNumber: Number(row.wave_num),
          waveName: (row.wave_name as string) ?? `Wave ${row.wave_num}`,
          priceEth: price,
          qty,
          spentEth: row.sale_method === "free_mint" ? 0 : price * qty,
        });
      }
    }

    // On-chain <-> off-chain sync check. Reads the live contract directly --
    // if it disagrees with the DB, the DB is stale (event listener lag,
    // an RPC outage during the mint, or the API being down at the time),
    // never the other way around: the chain is always the source of truth.
    let syncCheck: {
      checked: boolean;
      inSync: boolean;
      totalOnChain: number | null;
      totalOffChain: number;
      waveDiscrepancies: Array<{ waveNumber: number; onChain: number; offChain: number; reason: string }>;
      error?: string;
    } = { checked: false, inSync: true, totalOnChain: null, totalOffChain: 0, waveDiscrepancies: [] };

    if (collectionId) {
      const totalOffChainRow = await pool.query(
        "SELECT COUNT(*)::int AS total FROM nft_records WHERE collection_id = $1 AND owner_address IS NOT NULL",
        [collectionId],
      );
      const totalOffChain = totalOffChainRow.rows[0]?.total ?? 0;
      try {
        const contract = await getContractReadOnlyForCollection(collectionId);
        const totalOnChainBn = await contract.totalSupply();
        const totalOnChain = Number(totalOnChainBn);

        const waveDiscrepancies: typeof syncCheck.waveDiscrepancies = [];
        for (const w of wavesRows.rows) {
          const onChainSoldBn = await contract.waveSoldCount(w.wave_number);
          const onChainSold = Number(onChainSoldBn);
          const offChainSold = Number(w.sold_count ?? 0);
          if (onChainSold !== offChainSold) {
            waveDiscrepancies.push({
              waveNumber: w.wave_number,
              onChain: onChainSold,
              offChain: offChainSold,
              reason: offChainSold < onChainSold
                ? "DB is behind the chain -- the live event listener may not have processed this block yet, or the API server was briefly down when the mint happened. Usually resolves itself within a minute; if it persists, trigger a manual re-sync."
                : "DB shows more sold than the chain does -- check for test/manual data written directly to nft_records without a matching on-chain transaction.",
            });
          }
        }

        syncCheck = {
          checked: true,
          inSync: totalOnChain === totalOffChain && waveDiscrepancies.length === 0,
          totalOnChain,
          totalOffChain,
          waveDiscrepancies,
        };
      } catch (err) {
        syncCheck = {
          checked: false, inSync: true, totalOnChain: null, totalOffChain, waveDiscrepancies: [],
          error: err instanceof Error ? err.message : "Could not read the live contract.",
        };
      }
    }

    const waves = wavesRows.rows.map((w) => {
      const price = Number(w.default_price_eth ?? 0);
      const sold  = Number(w.sold_count ?? 0);
      return {
        waveNumber: w.wave_number,
        name: w.name,
        status: w.status,
        priceEth: price,
        quantity: Number(w.quantity ?? 0),
        soldCount: sold,
        revenueEth: w.sale_method === "free_mint" ? 0 : price * sold,
      };
    });

    res.json({
      holders: customersRow.rows[0]?.holders ?? 0,
      totalRevenueEth: waves.reduce((s, w) => s + w.revenueEth, 0),
      totalSold: waves.reduce((s, w) => s + w.soldCount, 0),
      waves,
      syncCheck,
      wallets: [...walletMap.values()].map((w) => ({
        ...w,
        mintedCount: w.perWave.reduce((s, pw) => s + pw.qty, 0),
      })).sort((a, b) => b.mintedCount - a.mintedCount || a.customerName.localeCompare(b.customerName)),
    });
  } catch (err) { next(err); }
});

export default router;
