import { Router } from "express";
import { requireAdmin, requireRole } from "../adminAuth";
import * as nftService from "../services/nft.service";
import pool from "../pool";
import { logNftActivity } from "../services/nft-log.service";

const router = Router();

// GET /api/nfts list with filters, pagination, sorting
router.get("/", async (req, res, next) => {
  try {
    const {
      search, owner_address, delivery_status, stage, revealed, minted,
      wave_id, wave_number, minted_from, minted_to, mint_type, rarity_tier,
      limit, offset, sort_by, sort_dir,
    } = req.query as Record<string, string>;

    const VALID_MINT_TYPES = new Set(["free", "paid", "admin", "treasury"]);
    const VALID_RARITY_TIERS = new Set(["legendary", "epic", "rare", "common"]);

    const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
    const result = await nftService.listNft({
      search: search || null,
      ownerAddress: (owner_address && ETH_ADDR_RE.test(owner_address)) ? owner_address : null,
      deliveryStatusCode: delivery_status || null,
      stageCode: stage || null,
      revealed: revealed === "true" ? true : revealed === "false" ? false : null,
      minted: minted === "true" ? true : minted === "false" ? false : null,
      waveId: wave_id || null,
      waveNumber: wave_number ? Number(wave_number) : null,
      mintedFrom: minted_from || null,
      mintedTo: minted_to || null,
      mintType: (mint_type && VALID_MINT_TYPES.has(mint_type)) ? mint_type : null,
      rarityTier: (rarity_tier && VALID_RARITY_TIERS.has(rarity_tier.toLowerCase())) ? rarity_tier.toLowerCase() : null,
      limit: limit ? Number(limit) : 20,
      offset: offset ? Number(offset) : 0,
      sortBy: sort_by || null,
      sortDir: (sort_dir === "asc" || sort_dir === "desc") ? sort_dir : null,
    });
    res.json(result);
  } catch (e) { next(e); }
});

// POST /api/nfts create single NFT record
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const { serialNumber, stageId, nftTypeId, deliveryStatusId, notes } = req.body ?? {};
    if (!serialNumber || !stageId) {
      res.status(400).json({ error: "serialNumber and stageId are required" }); return;
    }
    const record = await nftService.createNft({ serialNumber, stageId, nftTypeId, deliveryStatusId, notes });
    res.status(201).json(record);
  } catch (e) { next(e); }
});

// POST /api/nfts/bulk bulk create
router.post("/bulk", requireAdmin, async (req, res, next) => {
  try {
    const { records } = req.body ?? {};
    if (!Array.isArray(records) || records.length === 0) {
      res.status(400).json({ error: "records array is required" }); return;
    }
    const results = await nftService.bulkCreateNft(records);
    res.json({ results });
  } catch (e) { next(e); }
});

// GET /api/nfts/:id
router.get("/:id", async (req, res, next) => {
  try {
    const record = await nftService.getNft(req.params.id);
    if (!record) { res.status(404).json({ error: "NFT not found" }); return; }
    res.json(record);
  } catch (e) { next(e); }
});

// PUT /api/nfts/:id update
router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { stageId, nftTypeId, deliveryStatusId, notes, waveId, priceEth, clearPriceEth } = req.body ?? {};
    const record = await nftService.updateNft(req.params.id, {
      stageId, nftTypeId, deliveryStatusId, notes, waveId, priceEth, clearPriceEth,
    });
    if (!record) { res.status(404).json({ error: "NFT not found" }); return; }
    res.json(record);
  } catch (e) { next(e); }
});

// POST /api/nfts/trait-stats batch rarity % for a set of traits
router.post("/trait-stats", async (req, res, next) => {
  try {
    const { traits } = req.body ?? {};
    if (!traits || typeof traits !== "object" || Array.isArray(traits)) {
      res.status(400).json({ error: "traits object required" }); return;
    }
    const entries = Object.entries(traits as Record<string, string>);
    if (!entries.length) { res.json({ total: 0, stats: {} }); return; }

    const { rows: [{ total }] } = await pool.query<{ total: string }>(
      "SELECT COUNT(*) AS total FROM nft_records",
    );
    const stats: Record<string, Record<string, number>> = {};
    await Promise.all(entries.map(async ([layer, value]) => {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM nft_records WHERE traits @> $1::jsonb`,
        [JSON.stringify({ [layer]: value })],
      );
      if (!stats[layer]) stats[layer] = {};
      stats[layer][value] = Number(rows[0].count);
    }));
    res.json({ total: Number(total), stats });
  } catch (e) { next(e); }
});

// POST /api/nfts/:id/confirm-delivery
router.post("/:id/confirm-delivery", requireAdmin, async (req, res, next) => {
  try {
    const { deliveryStatusId } = req.body ?? {};
    if (!deliveryStatusId) { res.status(400).json({ error: "deliveryStatusId is required" }); return; }
    const record = await nftService.confirmNftDelivery(req.params.id, deliveryStatusId);
    if (!record) { res.status(404).json({ error: "NFT not found" }); return; }
    res.json(record);
  } catch (e) { next(e); }
});


// PUT /api/nfts/:id/sbt — toggle per-token SBT (soulbound) status on-chain
// Body: { enabled: boolean }  — token_id is resolved from the DB record UUID
router.put("/:id/sbt", requireAdmin, async (req, res, next) => {
  try {
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== "boolean")
      return res.status(400).json({ error: "enabled (boolean) required" });
    const { rows } = await pool.query<{ token_id: number | null }>(
      "SELECT token_id FROM nft_records WHERE id = $1::uuid",
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "NFT not found" });
    if (!rows[0].token_id) return res.status(400).json({ error: "Token not yet minted on-chain" });
    const { contractSetTokenSBT } = await import("../services/contract.service");
    const { userId: sbtActorId } = requireRole(req);
    const receipt = await contractSetTokenSBT(rows[0].token_id, enabled);
    logNftActivity({
      tokenId: rows[0].token_id,
      action: enabled ? "soulbound_set" : "soulbound_remove",
      source: "on_chain",
      platform: "bearth_admin",
      actorUserId: sbtActorId,
      txHash: receipt.hash,
      details: { enabled },
    });
    // DB update is handled automatically via TokenSBTChanged event listener
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

// POST /api/nfts/bulk-transfer — transfer treasury-held tokens to a recipient wallet
// Body: { tokenIds: number[], recipient: string }
// Max 50 tokens per call; treasury wallet (FIXED_PRIVATE_KEY) must own all tokens
router.post("/bulk-transfer", requireAdmin, async (req, res, next) => {
  try {
    const { tokenIds, recipient } = req.body as { tokenIds: number[]; recipient: string };

    if (!Array.isArray(tokenIds) || tokenIds.length === 0)
      return res.status(400).json({ error: "tokenIds array is required" });
    if (tokenIds.length > 50)
      return res.status(400).json({ error: "Maximum 50 tokens per batch" });
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient))
      return res.status(400).json({ error: "recipient must be a valid Ethereum address" });

    // Verify all tokens are treasury-held (delivery_status = 'treasury_wallet')
    const { rows: statusRows } = await pool.query<{ token_id: number; code: string }>(
      `SELECT nr.token_id, lv.code
         FROM nft_records nr
         JOIN lookup_values lv ON lv.id = nr.delivery_status_id
        WHERE nr.token_id = ANY($1::int[])`,
      [tokenIds],
    );

    const statusMap = new Map(statusRows.map((r: { token_id: number; code: string }) => [r.token_id, r.code]));
    const nonTreasury = tokenIds.filter(id => statusMap.get(id) !== "treasury_wallet");
    if (nonTreasury.length > 0)
      return res.status(400).json({
        error: `Tokens not in treasury_wallet status: ${nonTreasury.join(", ")}. Only treasury-held NFTs can be transferred via this endpoint.`,
      });

    const { contractTransferFromBatch } = await import("../services/contract.service");
    const results = await contractTransferFromBatch(tokenIds, recipient);

    const transferredIds = results.map((r: { tokenId: number; txHash: string }) => r.tokenId);
    if (transferredIds.length > 0) {
      await pool.query(
        `UPDATE nft_records
            SET delivery_status_id = (SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code = 'transferred'),
                delivered_at       = NOW(),
                owner_address      = $2,
                updated_at         = NOW()
          WHERE token_id = ANY($1::int[])`,
        [transferredIds, recipient.toLowerCase()],
      );
    }

    res.json({ ok: true, transferred: transferredIds, txHashes: results.map((r: { tokenId: number; txHash: string }) => r.txHash) });
  } catch (err) {
    next(err);
  }
});

// POST /api/nfts/testnet-reset — full DB reset for testnet wave testing only.
// Blocked on mainnet. Resets nft_records, nft_waves, nft_wave_pool, customer_wallets,
// nft_activity_log, and nft_collection_config counters to pre-mint state.
router.post("/testnet-reset", requireAdmin, async (req, res, next) => {
  try {
    const network = process.env.NEXT_PUBLIC_CONTRACT_NET ?? process.env.CONTRACT_NET ?? "";
    if (network === "mainnet") {
      res.status(403).json({ error: "testnet-reset is blocked on mainnet" }); return;
    }

    // Clear all mint/transfer/reveal state from NFT records (rows are permanent — never deleted)
    await pool.query(`
      UPDATE nft_records SET
        wave_id              = NULL,
        wave_num             = NULL,
        token_id             = NULL,
        mint_type            = NULL,
        is_revealed          = FALSE,
        revealed_at          = NULL,
        delivered_at         = NULL,
        minted_at            = NULL,
        mint_tx_hash         = NULL,
        owner_address        = NULL,
        synced_at            = NULL,
        sold_at              = NULL,
        on_chain_wave_num    = NULL,
        token_wave           = NULL,
        last_sale_price_eth  = NULL,
        last_tx_hash         = NULL,
        price_eth            = NULL,
        is_burned            = FALSE,
        burned_at            = NULL,
        burn_tx_hash         = NULL,
        token_sbt            = FALSE,
        delivery_status_id   = (SELECT id FROM lookup_values WHERE category = 'delivery_status' AND code = 'pending'),
        updated_at           = NOW()
    `);

    // Reset all 7 waves to pre-scheduling state
    await pool.query(`
      UPDATE nft_waves SET
        status                = 'upcoming',
        scheduled_start       = NULL,
        scheduled_end         = NULL,
        wave_start_triggered  = FALSE,
        wave_end_triggered    = FALSE,
        wave_reveal_triggered = FALSE,
        wave_closed           = FALSE,
        is_revealed           = FALSE,
        wave_revealed         = FALSE,
        wave_revealed_at      = NULL,
        wave_reveal_uri       = NULL,
        starting_index        = NULL,
        wave_starting_index   = NULL,
        reveal_scheduled_at   = NULL,
        vrf_request_id        = NULL,
        vrf_requested_at      = NULL,
        vrf_fulfilled_at      = NULL,
        close_action          = NULL,
        treasury_recipient    = NULL,
        treasury_minted_count = 0,
        price_locked          = FALSE,
        sold_count            = 0,
        last_tx_hash          = NULL,
        synced_at             = NULL,
        updated_at            = NOW()
    `);

    await pool.query("TRUNCATE nft_wave_pool");
    await pool.query("TRUNCATE nft_activity_log");

    // Reset collection config counters to match fresh contract state
    // Treasury wallet synced from env so DB stays consistent with deployment
    const treasuryWallet = process.env.TREASURY_WALLET ?? null;
    await pool.query(`
      UPDATE nft_collection_config SET
        current_phase   = 'Whitelist',
        reveal_count    = 0,
        total_counter   = 0,
        reveal_uri      = NULL,
        treasury_wallet = COALESCE($1, treasury_wallet),
        synced_at       = NULL,
        updated_at      = NOW()
      WHERE id = 1
    `, [treasuryWallet]);

    await pool.query(`
      UPDATE customer_wallets SET
        wallet_total_minted = 0,
        wl_claimed          = FALSE,
        last_tx_hash        = NULL,
        synced_at           = NULL
    `);

    res.json({ ok: true, message: "Testnet DB reset complete." });
  } catch (err) { next(err); }
});
export default router;
