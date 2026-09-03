import { Router } from "express";
import { ethers } from "ethers";
import pool from "../../pool";
import {
  contractSetWaveSchedule,
  contractSetWavePrice,
  contractTreasuryClose,
  contractGetWaveInfo,
  contractGetWavePurchaseLimit,
  contractSetWavePurchaseLimit,
  contractSetAllowlistRoot,
  resyncFromBlock,
  getContractReadOnly,
} from "../../services/contract.service";
import { getProvider } from "../../utils/contract-factory";
import { executeWaveReveal, _syncRevealedMetadata } from "../../services/reveal.service";
import { buildMerkleTree } from "../../merkle";
import { requireAdmin } from "../../adminAuth";

const router = Router();

function withChainTimeout<T>(p: Promise<T>, ms = 8000): Promise<T | null> {
  return Promise.race([p, new Promise<null>(resolve => setTimeout(() => resolve(null), ms))]);
}

// nft_waves now holds one 7-wave set PER collection (mirrors nft_records'
// collection_id split) -- wave_number alone is no longer unique, so every
// DB-side wave lookup below needs collection_id too. On-chain contract calls
// are untouched: the deployed contract is a single fixed-9,999-supply
// instance with no per-collection addressing, so it only ever knows "wave
// number", regardless of which collection's DB row we're mirroring into.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function requireCollectionId(req: import("express").Request, res: import("express").Response): string | null {
  const v = (req.query.collection_id ?? req.body?.collectionId) as string | undefined;
  if (v && UUID_RE.test(v)) return v;
  res.status(400).json({ error: "collection_id is required" });
  return null;
}

// GET /api/nft-sell/waves list all 7 waves (on-chain enriched, DB fallback)
router.get("/", async (req, res, next) => {
  try {
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { rows } = await pool.query("SELECT nft_wave_get_all($1) AS waves", [collectionId]);
    const dbWaves: Record<string, unknown>[] = rows[0]?.waves ?? [];

    const chainResults = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6, 7].map(n => withChainTimeout(contractGetWaveInfo(n), 6000))
    );

    const waves = dbWaves.map((w: Record<string, unknown>) => {
      const idx = Number(w.waveNumber ?? w.waveNum) - 1;
      const r = chainResults[idx];
      const onChain = r?.status === "fulfilled" ? r.value : null;
      return {
        ...w,
        onChain: onChain ? {
          priceEth: Number(onChain.price) / 1e18,
          qty: Number(onChain.qty),
          soldCount: Number(onChain.soldCount),
          startTime: Number(onChain.startTime),
          endTime: Number(onChain.endTime),
          closed: onChain.closed,
          active: onChain.active,
          revealed: onChain.revealed,
        } : null,
      };
    });

    res.json({ waves });
  } catch (err) {
    next(err);
  }
});

// GET /api/nft-sell/waves/schedule-status auto-trigger timeline for scheduler page
router.get("/schedule-status", async (req, res, next) => {
  try {
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { rows } = await pool.query(
      `SELECT v.*, w.wave_reveal_uri FROM v_wave_schedule_status v JOIN nft_waves w ON w.wave_number = v.wave_number AND w.collection_id = v.collection_id WHERE v.collection_id = $1::uuid ORDER BY v.wave_number`,
      [collectionId],
    );
    res.json({ waves: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/nft-sell/waves/treasury-nfts list all treasury-held tokens (unsold â†' owner wallet)
router.get("/treasury-nfts", async (req, res, next) => {
  try {
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { rows } = await pool.query("SELECT nft_treasury_nfts_list($1)", [collectionId]);
    const nfts = rows[0]?.nft_treasury_nfts_list ?? [];
    res.json({ nfts });
  } catch (err) {
    next(err);
  }
});

// POST /api/nft-sell/waves/resync replay all events from block history to rebuild DB.
router.post("/resync", requireAdmin, async (req, res, next) => {
  try {
    const fromBlock = parseInt(req.body.fromBlock ?? "0", 10);
    resyncFromBlock(fromBlock).catch(e => console.error("[resync] background error", e));
    res.json({ ok: true, started: true, message: "Resync started in background check server logs for progress" });
  } catch (err) {
    next(err);
  }
});

// GET /api/nft-sell/waves/:num single wave (DB + on-chain)
router.get("/:num", async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const { rows } = await pool.query("SELECT nft_wave_get($1, $2) AS wave", [num, collectionId]);
    const wave = rows[0]?.wave;
    let onChain = null;
    if (process.env.CONTRACT_ADDRESS && process.env.ETH_RPC_URL) {
      try {
        const [info, purchaseLimit] = await Promise.all([
          withChainTimeout(contractGetWaveInfo(num), 6000),
          withChainTimeout(contractGetWavePurchaseLimit(num), 6000),
        ]);
        if (info) {
          onChain = {
            price: ethers.formatEther(info.price),
            qty: Number(info.qty),
            soldCount: Number(info.soldCount),
            startTime: Number(info.startTime),
            endTime: Number(info.endTime),
            closed: info.closed,
            active: info.active,
            revealed: info.revealed,
            purchaseLimit: purchaseLimit ?? 0,
          };
        }
      } catch { onChain = null; }
    }
    res.json({ wave, onChain });
  } catch (err) {
    next(err);
  }
});

// PUT /api/nft-sell/waves/:num/schedule set wave start/end time on-chain
router.put("/:num/schedule", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    const startUnix = parseInt(req.body.startUnix, 10);
    const endUnix = parseInt(req.body.endUnix, 10);

    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    if (!startUnix || !endUnix || endUnix <= startUnix)
      return res.status(400).json({ error: "Valid startUnix and endUnix (end > start) required" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const now = Date.now();
    const { rows: curRows } = await pool.query(
      "SELECT scheduled_start, wave_start_triggered, wave_closed FROM nft_waves WHERE wave_number = $1 AND collection_id = $2",
      [num, collectionId],
    );
    const cur = curRows[0];
    if (cur?.wave_closed) {
      return res.status(409).json({
        error: `Wave ${num} is already closed schedule cannot be changed.`,
      });
    }
    if (cur?.wave_start_triggered) {
      return res.status(409).json({
        error: `Wave ${num} is already active schedule cannot be changed once the wave has started.`,
      });
    }
    const curStart = cur?.scheduled_start ? new Date(cur.scheduled_start).getTime() : null;
    if (curStart && now >= curStart) {
      return res.status(409).json({
        error: `Wave ${num} schedule is locked the start time has already arrived.`,
      });
    }
    if (num > 1) {
      const { rows: prevRows } = await pool.query(
        "SELECT scheduled_end FROM nft_waves WHERE wave_number = $1 AND collection_id = $2",
        [num - 1, collectionId],
      );
      const prevEndMs = prevRows[0]?.scheduled_end ? new Date(prevRows[0].scheduled_end).getTime() : null;
      if (!prevEndMs) {
        return res.status(409).json({
          error: `Wave ${num - 1} has no schedule yet set Wave ${num - 1} schedule first.`,
        });
      }
      if (startUnix * 1000 <= prevEndMs) {
        return res.status(409).json({
          error: `Wave ${num} start must be strictly after Wave ${num - 1} end (${new Date(prevEndMs).toISOString()}).`,
        });
      }
    }

    const receipt = await contractSetWaveSchedule(num, startUnix, endUnix);
    const startIso = new Date(startUnix * 1000).toISOString();
    const endIso = new Date(endUnix * 1000).toISOString();
    await pool.query(
      `UPDATE nft_waves
          SET scheduled_start        = $2,
              scheduled_end          = $3,
              wave_start_triggered   = FALSE,
              wave_end_triggered     = FALSE,
              last_tx_hash           = $4,
              updated_at             = NOW()
        WHERE wave_number = $1 AND collection_id = $5`,
      [num, startIso, endIso, receipt.hash, collectionId],
    );

    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    next(err);
  }
});

// PUT /api/nft-sell/waves/:num/price set wave price (only before first sale)
// Body: { priceEth: string }  e.g. "0.0303"
router.put("/:num/price", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    const priceStr = req.body.priceEth as string;

    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    if (!priceStr || isNaN(parseFloat(priceStr)))
      return res.status(400).json({ error: "priceEth (string) required, e.g. '0.0303'" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const priceWei = ethers.parseEther(priceStr);
    const receipt = await contractSetWavePrice(num, priceWei, collectionId);

    // Mirror confirmed price to DB so listings, cards, and exports show the correct value
    await pool.query(
      "UPDATE nft_waves SET default_price_eth = $2, last_tx_hash = $3, updated_at = NOW() WHERE wave_number = $1 AND collection_id = $4",
      [num, parseFloat(priceStr), receipt.hash, collectionId],
    );

    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    next(err);
  }
});

// PUT /api/nft-sell/waves/:num/purchase-limit  set per-wave mint cap (0 = use global limit)
// Body: { maxPerWallet: number }
router.put("/:num/purchase-limit", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    const maxPerWallet = parseInt(req.body.maxPerWallet, 10);

    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1-7" });
    if (isNaN(maxPerWallet) || maxPerWallet < 0)
      return res.status(400).json({ error: "maxPerWallet must be a non-negative integer (0 = use global limit)" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const { rows } = await pool.query(
      "SELECT wave_number, wave_closed, is_revealed FROM nft_waves WHERE wave_number = $1 AND collection_id = $2",
      [num, collectionId],
    );
    if (!rows[0]) return res.status(404).json({ error: `Wave ${num} not found` });
    if (rows[0].is_revealed)
      return res.status(409).json({ error: `Wave ${num} has already been revealed — purchase limit cannot be changed.` });

    const receipt = await contractSetWavePurchaseLimit(num, maxPerWallet);

    // Mirror to DB
    await pool.query(
      "UPDATE nft_waves SET max_per_wallet = $2, updated_at = NOW() WHERE wave_number = $1 AND collection_id = $3",
      [num, maxPerWallet, collectionId],
    );

    res.json({ ok: true, txHash: receipt.hash, waveNum: num, maxPerWallet });
  } catch (err) {
    next(err);
  }
});

// POST /api/nft-sell/waves/:num/reveal  admin manually reveals a specific wave
router.post("/:num/reveal", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    const { uri } = req.body as { uri: string };
    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    if (!uri?.startsWith("ipfs://"))
      return res.status(400).json({ error: "uri must start with ipfs://" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    // Pre-flight off-chain guard: wave must be closed; reveal date required only for auto strategy.
    // These checks prevent a wasted on-chain TX that would revert anyway.
    const { rows: waveCheck } = await pool.query(
      "SELECT wave_number, wave_closed, reveal_scheduled_at, is_revealed, reveal_strategy FROM nft_waves WHERE wave_number = $1 AND collection_id = $2",
      [num, collectionId],
    );
    const wv = waveCheck[0];
    if (!wv) return res.status(404).json({ error: `Wave ${num} not found` });
    if (wv.is_revealed)
      return res.status(409).json({ error: `Wave ${num} has already been revealed.` });
    if (!wv.wave_closed)
      return res.status(409).json({ error: `Wave ${num} must be closed before it can be revealed. Wait for the wave end time to pass.` });
    // reveal_scheduled_at is only mandatory for auto strategy; manual strategy admin triggers directly
    if (wv.reveal_strategy !== 'manual' && !wv.reveal_scheduled_at)
      return res.status(409).json({ error: `Wave ${num} has no reveal date set. Set a reveal date first via the Waves page.` });

    // Store URI in DB first so executeWaveReveal can pick it up
    await pool.query(
      "UPDATE nft_waves SET wave_reveal_uri = $1 WHERE wave_number = $2 AND collection_id = $3",
      [uri, num, collectionId],
    );

    // Execute reveal with Fisher-Yates random token assignment
    const txHash = await executeWaveReveal(num, collectionId);

    // Auto-treasury: if strategy='auto_treasury', mint all unsold tokens to treasury immediately after reveal
    const { rows: stratRows } = await pool.query(
      "SELECT unsold_strategy FROM nft_waves WHERE wave_number = $1 AND collection_id = $2",
      [num, collectionId],
    );
    let autoTreasuryTxHash: string | null = null;
    if (stratRows[0]?.unsold_strategy === 'auto_treasury') {
      try {
        const receipt = await contractTreasuryClose(num, null);
        autoTreasuryTxHash = receipt.hash;
        await pool.query(
          `UPDATE nft_records nr
              SET delivery_status_id = (SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code = 'treasury_wallet'),
                  delivered_at       = NOW(),
                  updated_at         = NOW()
            WHERE nr.wave_id = (SELECT id FROM nft_waves WHERE wave_number = $1 AND collection_id = $2)
              AND nr.collection_id = $2
              AND nr.token_id IS NULL
          AND nr.delivery_status_id IN (
            SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code IN ('pre_mint','reserved','treasury_pending','pool_assigned')
          )`,
          [num, collectionId],
        );
        await pool.query(
          `UPDATE nft_waves
              SET close_action          = 'treasury',
                  treasury_recipient    = NULL,
                  treasury_minted_count = (
                    SELECT COUNT(*) FROM nft_records nr2
                      JOIN lookup_values lv ON lv.id = nr2.delivery_status_id
                      WHERE nr2.wave_id = (SELECT id FROM nft_waves WHERE wave_number = $1 AND collection_id = $2)
                        AND nr2.collection_id = $2
                        AND lv.code IN ('treasury_wallet','transferred')
                  ),
                  updated_at = NOW()
            WHERE wave_number = $1 AND collection_id = $2`,
          [num, collectionId],
        );
        console.log(`[reveal] Wave ${num} auto-treasury-close done. txHash=${autoTreasuryTxHash}`);
      } catch (autoErr) {
        // Non-fatal: reveal already succeeded; admin can manually Move to Wallet as fallback
        console.error(`[reveal] Wave ${num} auto-treasury-close FAILED (reveal still OK):`, autoErr);
      }
    }

    res.json({ ok: true, txHash, waveNumber: num, autoTreasuryTxHash });
  } catch (err) {
    next(err);
  }
});

// POST /api/nft-sell/waves/:num/resync-reveal
// Fixes wave DB state after a reveal where startingIndex was null or wrong.
// Back-computes startingIndex from on-chain tokenURI, syncs schedule dates, re-runs metadata sync.
router.post("/:num/resync-reveal", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const RPC_URL = process.env.ETH_RPC_URL;
    const CONTRACT_ADDR = process.env.CONTRACT_ADDRESS;
    if (!RPC_URL || !CONTRACT_ADDR)
      return res.status(500).json({ error: "ETH_RPC_URL / CONTRACT_ADDRESS not set" });

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const abi = [
      "function waveStartTime(uint256) external view returns (uint256)",
      "function waveEndTime(uint256) external view returns (uint256)",
      "function waveQty(uint256) external view returns (uint256)",
      "function tokenURI(uint256) external view returns (string)",
      "function waveRevealed(uint256) external view returns (bool)",
    ];
    const nft = new ethers.Contract(CONTRACT_ADDR, abi, provider);

    // Read on-chain wave info
    const [startTime, endTime, waveQty, isRevealed] = await Promise.all([
      nft.waveStartTime(num) as Promise<bigint>,
      nft.waveEndTime(num) as Promise<bigint>,
      nft.waveQty(num) as Promise<bigint>,
      nft.waveRevealed(num) as Promise<boolean>,
    ]);

    const scheduledStart = startTime > 0n ? new Date(Number(startTime) * 1000).toISOString() : null;
    const scheduledEnd = endTime > 0n ? new Date(Number(endTime) * 1000).toISOString() : null;
    const qty = Number(waveQty);

    // Back-compute startingIndex from tokenURI of the first sold token (reliable, no eth_getLogs)
    let startingIndex: number | null = null;
    if (isRevealed && qty > 0) {
      const { rows: tokenRows } = await pool.query<{ token_id: number }>(
        `SELECT token_id FROM nft_records WHERE on_chain_wave_num=$1 AND collection_id=$2 AND token_id IS NOT NULL ORDER BY token_id ASC LIMIT 1`,
        [num, collectionId],
      );
      if (tokenRows.length) {
        const tokenId = tokenRows[0].token_id;
        try {
          const uri = await nft.tokenURI(tokenId) as string;
          // uri format: ipfs://CID/some/path/METADATA_ID
          const raw = uri.split("/").pop() ?? "";
          const metadataId = parseInt(raw, 10);
          if (!isNaN(metadataId)) {
            // metadataId = _waveFirstTokenId[wave] + (tokenId - firstTokenId + si) % qty
            // â†' si = (metadataId - tokenId + qty) % qty  (firstTokenId terms cancel)
            startingIndex = ((metadataId - tokenId) % qty + qty) % qty;
          }
        } catch { /* non-fatal */ }
      }
    }

    // Update wave DB record
    await pool.query(
      `UPDATE nft_waves SET
         scheduled_start  = COALESCE($2, scheduled_start),
         scheduled_end    = COALESCE($3, scheduled_end),
         quantity         = CASE WHEN $4 > 0 THEN $4 ELSE quantity END,
         starting_index   = COALESCE($5, starting_index),
         updated_at       = NOW()
       WHERE wave_number = $1 AND collection_id = $6`,
      [num, scheduledStart, scheduledEnd, qty, startingIndex, collectionId],
    );

    // Re-run metadata sync so artwork/rarity/traits copy correctly with new startingIndex
    if (isRevealed) {
      await _syncRevealedMetadata(num, collectionId);
    }

    res.json({ ok: true, waveNumber: num, scheduledStart, scheduledEnd, qty, startingIndex });
  } catch (err) {
    next(err);
  }
});

// GET /api/nft-sell/waves/:num/treasury-close-estimate
// Returns signer wallet balance + estimated gas cost for treasury-close so the UI can warn before submission.
router.get("/:num/treasury-close-estimate", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1-7" });

    const privateKey = process.env.CONTRACT_PRIVATE_KEY ?? process.env.FIXED_PRIVATE_KEY;
    if (!privateKey) return res.status(500).json({ error: "Signer key not configured" });

    const provider = getProvider();
    const signer = new ethers.Wallet(privateKey, provider);

    const [balanceWei, feeData, treasuryAddr] = await Promise.all([
      provider.getBalance(signer.address),
      provider.getFeeData(),
      getContractReadOnly().treasuryWallet() as Promise<string>,
    ]);

    const gasPrice = feeData.gasPrice ?? BigInt(2_000_000_000);

    let estimatedGasWei = BigInt(300_000) * gasPrice; // conservative fallback
    try {
      const gasUnits = await getContractReadOnly().treasuryClose.estimateGas(num, treasuryAddr, { from: signer.address });
      estimatedGasWei = gasUnits * gasPrice;
    } catch {
      // estimateGas can fail if wave guards are not met — use fallback
    }

    const balanceEth = parseFloat(ethers.formatEther(balanceWei));
    const estimatedEth = parseFloat(ethers.formatEther(estimatedGasWei));

    res.json({
      walletAddress: signer.address,
      balanceEth,
      estimatedGasEth: estimatedEth,
      sufficient: balanceWei >= estimatedGasWei,
    });
  } catch (err) {
    next(err);
  }
});
// POST /api/nft-sell/waves/:num/treasury-close
// Mints all unsold NFTs to the treasury wallet configured in the smart contract.
// For waves with customer sales: wave MUST be revealed first.
// For 0-minted waves: contract allows treasury-close without reveal (waveSoldCount == 0).
router.post("/:num/treasury-close", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1-7" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const { rows: waveRows } = await pool.query(
      "SELECT scheduled_end, wave_revealed FROM nft_waves WHERE wave_number = $1 AND collection_id = $2",
      [num, collectionId],
    );
    const waveRow = waveRows[0];

    // Guard 1: wave must be closed
    if (!waveRow?.scheduled_end || new Date() <= new Date(waveRow.scheduled_end)) {
      return res.status(409).json({
        error: `Wave ${num} has not closed yet. Treasury transfer is only allowed after the wave end date passes.`,
      });
    }

    // Check whether any customer actually minted in this wave
    const { rows: salesRows } = await pool.query(
      `SELECT COUNT(nr.id) AS cnt
         FROM nft_records nr
         JOIN nft_waves w ON w.id = nr.wave_id
        WHERE w.wave_number = $1 AND w.collection_id = $2 AND nr.token_id IS NOT NULL`,
      [num, collectionId],
    );
    const hasCustomerSales = parseInt(salesRows[0]?.cnt ?? "0") > 0;

    if (!waveRow.wave_revealed && hasCustomerSales) {
      // Guard 2: waves with customer sales must be revealed first
      return res.status(409).json({
        error: `Wave ${num} has not been revealed yet. Reveal the wave first before moving to treasury.`,
      });
    }

    // Check on-chain state first — auto-trigger may have closed the wave but DB sync was skipped
    let txHash: string | null = null;
    let alreadyClosedOnChain = false;
    try {
      const onChain = await contractGetWaveInfo(num);
      if (onChain?.closed) {
        alreadyClosedOnChain = true;
        console.log(`[treasury-close] Wave ${num} already closed on-chain — syncing DB only`);
      }
    } catch {
      // ignore — proceed to contract call if on-chain state is unreadable
    }

    if (!alreadyClosedOnChain) {
      const receipt = await contractTreasuryClose(num, null);
      txHash = receipt.hash;
    }

    await pool.query(
      `UPDATE nft_records nr
          SET delivery_status_id = (SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code = 'treasury_wallet'),
              delivered_at       = NOW(),
              updated_at         = NOW()
        WHERE nr.wave_id = (SELECT id FROM nft_waves WHERE wave_number = $1 AND collection_id = $2)
          AND nr.collection_id = $2
          AND nr.token_id IS NULL
          AND nr.delivery_status_id IN (
            SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code IN ('pre_mint','reserved','treasury_pending','pool_assigned')
          )`,
      [num, collectionId],
    );
    await pool.query(
      `UPDATE nft_waves
          SET close_action          = 'treasury',
              treasury_recipient    = NULL,
              treasury_minted_count = (
                SELECT COUNT(*) FROM nft_records nr2
                  JOIN lookup_values lv ON lv.id = nr2.delivery_status_id
                  WHERE nr2.wave_id = (SELECT id FROM nft_waves WHERE wave_number = $1 AND collection_id = $2)
                    AND nr2.collection_id = $2
                    AND lv.code IN ('treasury_wallet','transferred')
              ),
              updated_at = NOW()
        WHERE wave_number = $1 AND collection_id = $2`,
      [num, collectionId],
    );

    res.json({ ok: true, txHash: txHash ?? "already-closed" });
  } catch (err) {
    next(err);
  }
});


// GET /api/nft-sell/waves/:num/holder-snapshot list current holders for a wave
router.get("/:num/holder-snapshot", async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const { rows } = await pool.query("SELECT nft_holder_snapshot($1,$2)", [num, collectionId]);
    const addresses: string[] = rows[0]?.nft_holder_snapshot ?? [];
    res.json({ wave_number: num, holders: addresses, count: addresses.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/nft-sell/waves/:num/holder-merkle generate Merkle from holders + set allowlist root on-chain
router.post("/:num/holder-merkle", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const { rows } = await pool.query("SELECT nft_holder_snapshot($1,$2)", [num, collectionId]);
    const addresses: string[] = rows[0]?.nft_holder_snapshot ?? [];

    if (!addresses.length)
      return res.status(400).json({ error: "No holders found for snapshot" });

    const tree = buildMerkleTree(addresses);
    const root = tree.root;

    await pool.query("UPDATE nft_waves SET wave_merkle_root=$1 WHERE wave_number=$2 AND collection_id=$3", [root, num, collectionId]);

    let txHash: string | undefined;
    if (process.env.CONTRACT_ADDRESS && process.env.ETH_RPC_URL) {
      const receipt = await contractSetAllowlistRoot(root);
      txHash = receipt.hash;
    }

    res.json({ ok: true, wave_number: num, merkle_root: root, holder_count: addresses.length, txHash: txHash ?? null });
  } catch (err) {
    next(err);
  }
});

// PUT /api/nft-sell/waves/:num/holder-priority set holder priority window in DB
// Body: { start: string (ISO), end: string (ISO) }
router.put("/:num/holder-priority", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    const { start, end } = req.body as { start: string; end: string };

    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    if (!start || !end)
      return res.status(400).json({ error: "start and end (ISO datetime) required" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const { rows } = await pool.query("SELECT nft_wave_update_holder_priority($1,$2,$3,$4)", [num, start, end, collectionId]);
    res.json({ ok: true, wave: rows[0]?.nft_wave_update_holder_priority });
  } catch (err) {
    next(err);
  }
});

// PUT /api/nft-sell/waves/:num/flash-sale toggle flash sale + set discount
// Body: { is_flash_sale: boolean, flash_discount_pct?: number }
router.put("/:num/flash-sale", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    const { is_flash_sale, flash_discount_pct } = req.body as {
      is_flash_sale: boolean; flash_discount_pct?: number;
    };

    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    if (is_flash_sale === undefined)
      return res.status(400).json({ error: "is_flash_sale boolean required" });
    if (is_flash_sale && (!flash_discount_pct || flash_discount_pct <= 0))
      return res.status(400).json({ error: "flash_discount_pct > 0 required when enabling flash sale" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const { rows } = await pool.query("SELECT nft_wave_update_flash_sale($1,$2,$3,$4)", [num, is_flash_sale, flash_discount_pct ?? 0, collectionId]);
    res.json({ ok: true, wave: rows[0]?.nft_wave_update_flash_sale });
  } catch (err) {
    next(err);
  }
});

// PUT /api/nft-sell/waves/:num/tier-prices set per-rarity tier prices
// Body: { tier_prices: { legendary?: number, epic?: number, rare?: number, common?: number } }
router.put("/:num/tier-prices", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    const { tier_prices } = req.body as {
      tier_prices: { legendary?: number; epic?: number; rare?: number; common?: number };
    };

    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    if (!tier_prices || typeof tier_prices !== "object")
      return res.status(400).json({ error: "tier_prices object required" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const { rows } = await pool.query("SELECT nft_wave_update_tier_prices($1,$2,$3)", [num, JSON.stringify(tier_prices), collectionId]);
    res.json({ ok: true, wave: rows[0]?.nft_wave_update_tier_prices });
  } catch (err) {
    next(err);
  }
});

// PUT /api/nft-sell/waves/:num/artist-config set artist edition config
router.put("/:num/artist-config", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    const { artist_name, artist_wallet, artist_royalty_bps, is_artist_edition } = req.body as {
      artist_name: string; artist_wallet: string;
      artist_royalty_bps: number; is_artist_edition?: boolean;
    };

    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1–7" });
    if (!artist_name || !artist_wallet)
      return res.status(400).json({ error: "artist_name and artist_wallet required" });
    if (artist_royalty_bps === undefined || artist_royalty_bps < 0 || artist_royalty_bps > 1000)
      return res.status(400).json({ error: "artist_royalty_bps must be 0–1000" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const { rows } = await pool.query("SELECT nft_wave_update_artist_config($1,$2,$3,$4,$5,$6)", [num, artist_name, artist_wallet.toLowerCase(), artist_royalty_bps, is_artist_edition ?? true, collectionId]);
    res.json({ ok: true, wave: rows[0]?.nft_wave_update_artist_config });
  } catch (err) {
    next(err);
  }
});

// POST /api/nft-sell/waves/:num/whitelist-required
// Toggle per-wave whitelist restriction on-chain + sync to DB.
router.post("/:num/whitelist-required", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1-7" });
    const { required } = req.body as { required?: boolean };
    if (typeof required !== "boolean")
      return res.status(400).json({ error: "required must be a boolean" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { contractSetWaveWhitelistRequired } = await import("../../services/contract.service");
    const receipt = await contractSetWaveWhitelistRequired(num, required);
    await pool.query(
      "UPDATE nft_waves SET whitelist_required = $2, updated_at = NOW() WHERE wave_number = $1 AND collection_id = $3",
      [num, required, collectionId],
    );
    res.json({ ok: true, txHash: receipt.hash, waveNumber: num, whitelistRequired: required });
  } catch (err) { next(err); }
});

// POST /api/nft-sell/waves/whitelist-approved
// Batch approve/revoke wallets for restricted waves on-chain.
router.post("/whitelist-approved", requireAdmin, async (req, res, next) => {
  try {
    const { wallets, approved } = req.body as { wallets?: string[]; approved?: boolean };
    if (!Array.isArray(wallets) || !wallets.length)
      return res.status(400).json({ error: "wallets must be a non-empty array" });
    if (typeof approved !== "boolean")
      return res.status(400).json({ error: "approved must be a boolean" });
    const { contractSetWaveWhitelistApprovedBatch } = await import("../../services/contract.service");
    const receipt = await contractSetWaveWhitelistApprovedBatch(wallets, approved);
    res.json({ ok: true, txHash: receipt.hash, walletCount: wallets.length, approved });
  } catch (err) { next(err); }
});

// POST /api/nft-sell/waves/:num/repair-treasury-mints
router.post("/:num/repair-treasury-mints", requireAdmin, async (req, res, next) => {
  try {
    const num = parseInt(req.params.num, 10);
    if (isNaN(num) || num < 1 || num > 7)
      return res.status(400).json({ error: "Wave number must be 1-7" });
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;

    const RPC_URL = process.env.ETH_RPC_URL!;
    const CONTRACT_ADDR = process.env.CONTRACT_ADDRESS!;
    if (!RPC_URL || !CONTRACT_ADDR)
      return res.status(500).json({ error: "ETH_RPC_URL / CONTRACT_ADDRESS not set" });

    // 1. Load wave DB row
    const { rows: waveRows } = await pool.query(
      `SELECT id, quantity, starting_index FROM nft_waves WHERE wave_number = $1 AND collection_id = $2`,
      [num, collectionId],
    );
    if (!waveRows.length) return res.status(404).json({ error: `Wave ${num} not found` });
    const { id: waveId, quantity: waveQty, starting_index: startingIndex } = waveRows[0];

    // 2. Get unassigned treasury records for this wave (numeric FIFO order)
    const { rows: unassigned } = await pool.query<{ id: string; serial_number: string }>(
      `SELECT nr.id, nr.serial_number
         FROM nft_records nr
         JOIN lookup_values lv ON lv.id = nr.delivery_status_id
        WHERE nr.wave_id = $1::uuid
          AND nr.token_id IS NULL
          AND lv.code NOT IN ('revealed', 'sold', 'delivered')
        ORDER BY REGEXP_REPLACE(nr.serial_number, '[^0-9]', '', 'g')::INTEGER ASC`,
      [waveId],
    );
    if (!unassigned.length)
      return res.json({ ok: true, message: "No unassigned treasury records — already repaired", assigned: 0, revealed: 0 });

    // 3. Scan Transfer mint events (from=0x0 → treasury recipient) via event logs.
    //    ERC721A does NOT implement tokenOfOwnerByIndex — Transfer logs are the correct approach.
    const { getProvider } = await import("../../utils/contract-factory");
    const provider = getProvider();
    const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
    const ZERO_PADDED = ethers.zeroPadValue(ethers.ZeroAddress, 32);

    const { rows: recipientRows } = await pool.query<{ addr: string }>(
      `SELECT DISTINCT treasury_recipient AS addr
           FROM nft_waves
          WHERE wave_number = $1 AND collection_id = $2 AND treasury_recipient IS NOT NULL`,
      [num, collectionId],
    );

    const chainTokenIdSet = new Set<number>();
    const latestBlock = await provider.getBlockNumber();
    // Look back 150k blocks (~25 days on Sepolia @ 15 s/block) to cover any recent testnet deploy
    const fromBlock = Math.max(0, latestBlock - 150_000);
    const CHUNK = 2_000;

    for (const { addr } of recipientRows) {
      const paddedTo = ethers.zeroPadValue(addr.toLowerCase(), 32);
      let cursor = fromBlock;
      while (cursor <= latestBlock) {
        const end = Math.min(cursor + CHUNK - 1, latestBlock);
        try {
          const logs = await provider.getLogs({
            address: CONTRACT_ADDR,
            topics: [TRANSFER_TOPIC, ZERO_PADDED, paddedTo],
            fromBlock: cursor,
            toBlock: end,
          });
          for (const log of logs) chainTokenIdSet.add(Number(BigInt(log.topics[3])));
        } catch { /* skip failed chunk */ }
        cursor = end + 1;
      }
    }

    // Sort ascending — matches ERC721A sequential mint order for FIFO assignment
    const chainTokenIds = [...chainTokenIdSet].sort((a, b) => a - b);

    // 4. Assign token_ids to unassigned records (FIFO)
    let assigned = 0;
    const toReveal: string[] = [];
    for (let i = 0; i < Math.min(chainTokenIds.length, unassigned.length); i++) {
      const tokenId = chainTokenIds[i];
      const record = unassigned[i];
      await pool.query(
        `UPDATE nft_records
            SET token_id          = $2,
                on_chain_wave_num = $3,
                mint_type         = 'treasury',
                synced_at         = NOW(),
                updated_at        = NOW()
          WHERE id = $1::uuid AND token_id IS NULL`,
        [record.id, tokenId, num],
      );
      toReveal.push(record.id);
      assigned++;
    }

    // 5. Set delivery_status=treasury_wallet + mark assigned records revealed
    let revealed = 0;
    if (toReveal.length) {
      const { rowCount } = await pool.query(
        `UPDATE nft_records
            SET is_revealed        = TRUE,
                revealed_at        = COALESCE(revealed_at, NOW()),
                mint_type          = 'treasury',
                delivery_status_id = (SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code = 'treasury_wallet'),
                updated_at         = NOW()
          WHERE id = ANY($1::uuid[])`,
        [toReveal],
      );
      revealed = rowCount ?? 0;
    }

    // 6. Re-run metadata sync (copies correct artwork to each token using VRF formula)
    if (assigned > 0 && startingIndex != null) {
      await _syncRevealedMetadata(num, collectionId);
    }

    res.json({ ok: true, waveNumber: num, assigned, revealed, startingIndex });
  } catch (err) { next(err); }
});
export default router;
