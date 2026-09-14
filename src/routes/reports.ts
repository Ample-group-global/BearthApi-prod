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

    // Holders must exclude the collection's own Treasury contract -- it
    // legitimately owns every treasury-swept unsold token, but it is not a
    // customer.
    const customersPromise = pool.query(
      `SELECT COUNT(DISTINCT LOWER(nr.owner_address))::int AS holders
         FROM nft_records nr
         JOIN nft_collections nc ON nc.id = nr.collection_id
        WHERE ($1::uuid IS NULL OR nr.collection_id = $1)
          AND nr.owner_address IS NOT NULL
          AND ($1::uuid IS NULL OR LOWER(nr.owner_address) <> LOWER(nc.contract_treasury_address))`,
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
    //
    // customer_wallets is a GLOBAL registry across every collection this
    // ecosystem has ever touched (including years-old manual/test rows) --
    // starting the query from it and INNER JOINing to users meant this list
    // silently mixed in wallets that have nothing to do with the selected
    // collection, while dropping real minters here whose user_id happened
    // to be orphaned. The correct starting set is "wallets relevant to THIS
    // collection": whitelisted here, or actually holding a token here (minus
    // the Treasury contract, which is not a customer) -- name/whitelist
    // lookups are then best-effort LEFT JOINs, never a reason to drop a row.
    const walletsPromise = collectionId
      ? pool.query(
          `WITH relevant_wallets AS (
             SELECT DISTINCT LOWER(wallet_address) AS address
               FROM nft_collection_whitelist WHERE collection_id = $1
             UNION
             SELECT DISTINCT LOWER(nr.owner_address)
               FROM nft_records nr
               JOIN nft_collections nc ON nc.id = nr.collection_id
              WHERE nr.collection_id = $1
                AND nr.owner_address IS NOT NULL
                AND LOWER(nr.owner_address) <> LOWER(nc.contract_treasury_address)
           )
           SELECT
             COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), rw.address) AS customer_name,
             rw.address,
             u.user_code,
             NULLIF(TRIM(COALESCE(ref.first_name, '') || ' ' || COALESCE(ref.last_name, '')), '') AS referrer_name,
             EXISTS(
               SELECT 1 FROM nft_collection_whitelist wl
                WHERE wl.collection_id = $1 AND LOWER(wl.wallet_address) = rw.address
             ) AS whitelisted,
             nr.wave_num,
             w.name AS wave_name,
             w.default_price_eth,
             w.sale_method,
             COUNT(nr.id) FILTER (WHERE nr.id IS NOT NULL)::int AS qty
           FROM relevant_wallets rw
           LEFT JOIN customer_wallets cw ON LOWER(cw.address) = rw.address
           LEFT JOIN users u ON u.id = cw.user_id
           LEFT JOIN users ref ON ref.id = u.referrer_id
           LEFT JOIN nft_records nr ON LOWER(nr.owner_address) = rw.address AND nr.collection_id = $1
           LEFT JOIN nft_waves w ON w.collection_id = $1 AND w.wave_number = nr.wave_num
           GROUP BY rw.address, u.first_name, u.last_name, u.user_code, ref.first_name, ref.last_name, nr.wave_num, w.name, w.default_price_eth, w.sale_method
           ORDER BY customer_name, nr.wave_num`,
          [collectionId],
        )
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> });

    const [customersRow, wavesRows, walletsRows] = await Promise.all([customersPromise, wavesPromise, walletsPromise]);

    interface WaveBreakdown { waveNumber: number; waveName: string; priceEth: number; qty: number; spentEth: number; }
    const walletMap = new Map<string, { customerName: string; address: string; userCode: string | null; referrerName: string | null; whitelisted: boolean; perWave: WaveBreakdown[] }>();
    for (const row of walletsRows.rows) {
      const key = String(row.address).toLowerCase();
      if (!walletMap.has(key)) {
        walletMap.set(key, {
          customerName: (row.customer_name as string) || "(no name)",
          address: row.address as string,
          userCode: (row.user_code as string) ?? null,
          referrerName: (row.referrer_name as string) ?? null,
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
    const treasuryCountByWave = new Map<number, number>();
    const statusByWave = new Map<number, string>();

    if (collectionId) {
      const totalOffChainRow = await pool.query(
        "SELECT COUNT(*)::int AS total FROM nft_records WHERE collection_id = $1 AND owner_address IS NOT NULL",
        [collectionId],
      );
      const totalOffChain = totalOffChainRow.rows[0]?.total ?? 0;

      // Per-wave record counts (real sales + any treasury-swept remainder) --
      // this, not nft_waves.sold_count, is what should be compared against
      // the chain's waveSoldCount. sold_count is a business metric (how many
      // a customer actually bought) that treasuryClose() deliberately never
      // touches; waveSoldCount on-chain is the raw capacity counter that
      // treasuryClose() DOES increment when it sweeps unsold inventory to
      // treasury. Comparing sold_count to waveSoldCount would permanently
      // "detect" a discrepancy on every wave the moment it's treasury-closed,
      // even though nothing is actually out of sync.
      // owner_address IS NOT NULL excludes autoprovisioned placeholder rows
      // for waves that haven't minted yet (pre-created so wave scheduling
      // has somewhere to point token_ids at) -- those aren't on-chain yet
      // by design, so counting them here would falsely flag every
      // not-started wave as "DB ahead of chain."
      const perWaveRecordCountRows = await pool.query(
        "SELECT wave_num, COUNT(*)::int AS cnt FROM nft_records WHERE collection_id = $1 AND wave_num IS NOT NULL AND owner_address IS NOT NULL GROUP BY wave_num",
        [collectionId],
      );
      const recordCountByWave = new Map<number, number>(
        perWaveRecordCountRows.rows.map(r => [Number(r.wave_num), Number(r.cnt)]),
      );

      // How many of each wave's tokens currently sit in the collection's own
      // Treasury contract (the unsold remainder treasuryClose() swept there).
      const perWaveTreasuryRows = await pool.query(
        `SELECT nr.wave_num, COUNT(*)::int AS cnt
           FROM nft_records nr
           JOIN nft_collections nc ON nc.id = nr.collection_id
          WHERE nr.collection_id = $1 AND nr.wave_num IS NOT NULL
            AND LOWER(nr.owner_address) = LOWER(nc.contract_treasury_address)
          GROUP BY nr.wave_num`,
        [collectionId],
      );
      for (const r of perWaveTreasuryRows.rows) treasuryCountByWave.set(Number(r.wave_num), Number(r.cnt));

      // nft_waves.status is set once at creation and never updated again
      // (every wave in this database is still literally "pending" or
      // "upcoming", even ones long closed and revealed) -- the Waves
      // management page already knows this and derives real status
      // client-side from on-chain waveClosed/waveRevealed instead of
      // trusting that column. Do the same here so the Dashboard doesn't
      // show a stale "pending" badge on a wave that's fully done.

      try {
        const contract = await getContractReadOnlyForCollection(collectionId);
        const totalOnChainBn = await contract.totalSupply();
        const totalOnChain = Number(totalOnChainBn);

        const waveDiscrepancies: typeof syncCheck.waveDiscrepancies = [];
        for (const w of wavesRows.rows) {
          const waveNum = Number(w.wave_number);
          const [onChainSoldBn, waveClosed, waveRevealed, startTimeBn, endTimeBn] = await Promise.all([
            contract.waveSoldCount(waveNum),
            contract.waveClosed(waveNum),
            contract.waveRevealed(waveNum),
            contract.waveStartTime(waveNum),
            contract.waveEndTime(waveNum),
          ]);
          const onChainSold = Number(onChainSoldBn);
          const offChainRecordCount = recordCountByWave.get(waveNum) ?? 0;
          if (onChainSold !== offChainRecordCount) {
            waveDiscrepancies.push({
              waveNumber: waveNum,
              onChain: onChainSold,
              offChain: offChainRecordCount,
              reason: offChainRecordCount < onChainSold
                ? "DB is behind the chain -- the live event listener may not have processed this block yet, or the API server was briefly down when the mint/treasury-close happened. Usually resolves itself within a minute; if it persists, trigger a manual re-sync."
                : "DB shows more records than the chain does -- check for test/manual data written directly to nft_records without a matching on-chain transaction.",
            });
          }

          const nowMs = Date.now();
          const startMs = Number(startTimeBn) * 1000;
          const endMs = Number(endTimeBn) * 1000;
          let derived: string;
          if (waveRevealed) derived = "revealed";
          else if (waveClosed) derived = "closed";
          else if (startTimeBn === 0n) derived = w.status;
          else if (nowMs < startMs) derived = "upcoming";
          else if (endTimeBn === 0n || nowMs < endMs) derived = "active";
          else derived = "ended";
          statusByWave.set(waveNum, derived);
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
        treasuryQty: treasuryCountByWave.get(Number(w.wave_number)) ?? 0,
        name: w.name,
        status: statusByWave.get(Number(w.wave_number)) ?? w.status,
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
