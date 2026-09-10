import { Router } from "express";
import pool from "../../pool";
import { ethers } from "ethers";
import { requirePermission } from "../../adminAuth";
import { contractSetRoyalty, contractSetTransferValidator } from "../../services/contract.service";

const router = Router();

// GET /api/nft-sell/royalty — current ERC2981 royalty config (DB mirror,
// kept in sync by contract.service.ts's RoyaltyUpdated event handler).
router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const { rows } = await pool.query("SELECT * FROM nft_royalty_config_get()");
    res.json({ royalty: rows[0] ?? null });
  } catch (err) { next(err); }
});

// PUT /api/nft-sell/royalty — set royalty receiver + fee on-chain (ERC2981).
// DB row is updated by the RoyaltyUpdated event sync after the tx confirms,
// not written directly here, to keep the chain the single source of truth.
router.put("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { receiverAddress, feeBps } = req.body as { receiverAddress?: string; feeBps?: number };
    if (!receiverAddress || !ethers.isAddress(receiverAddress)) return res.status(422).json({ error: "Valid receiverAddress required" });
    if (feeBps === undefined || feeBps < 0 || feeBps > 1000) return res.status(422).json({ error: "feeBps must be 0-1000" });
    const receipt = await contractSetRoyalty(receiverAddress, feeBps);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

// PUT /api/nft-sell/royalty/enforcement — DB-only reference flag, no chain call
router.put("/enforcement", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { enforced } = req.body as { enforced?: boolean };
    if (typeof enforced !== "boolean") return res.status(422).json({ error: "enforced (boolean) required" });
    const current = (await pool.query("SELECT * FROM nft_royalty_config_get()")).rows[0];
    await pool.query("SELECT nft_royalty_config_upsert($1,$2,$3,$4)", [
      current?.royalty_pct_bps ?? 0, current?.receiver_address ?? null, enforced, current?.last_tx_hash ?? null,
    ]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/nft-sell/royalty/transfer-validator — ERC721C on-chain enforcement
router.put("/transfer-validator", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { validatorAddress } = req.body as { validatorAddress?: string };
    if (!validatorAddress || !ethers.isAddress(validatorAddress)) return res.status(422).json({ error: "Valid validatorAddress required" });
    const receipt = await contractSetTransferValidator(validatorAddress);
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) { next(err); }
});

// GET/PUT /api/nft-sell/royalty/marketplaces — DB-only reference list
router.get("/marketplaces", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const { rows } = await pool.query("SELECT * FROM royalty_marketplaces ORDER BY created_at");
    res.json({ marketplaces: rows });
  } catch (err) { next(err); }
});

router.put("/marketplaces", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const { address, name, allowed } = req.body as { address?: string; name?: string; allowed?: boolean };
    if (!address || !ethers.isAddress(address)) return res.status(422).json({ error: "Valid address required" });
    await pool.query(
      `INSERT INTO royalty_marketplaces (address, name, enabled, synced_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (address) DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled, synced_at = NOW()`,
      [address.toLowerCase(), name ?? null, allowed ?? true]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
