import { Router, Request, Response } from "express";
import pool from "../../pool";
import { requirePermission } from "../../adminAuth";
import { airdropOneNftToWallet, fulfillPaidGift } from "../../services/gifts.service";

const router = Router();

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireCollectionId(req: Request, res: Response): string | null {
  const v = (req.query.collection_id ?? req.body?.collectionId) as string | undefined;
  if (v && UUID_RE.test(v)) return v;
  res.status(400).json({ error: "collection_id is required" });
  return null;
}

router.get("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.view");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { rows } = await pool.query(
      `SELECT id, sender_wallet, recipient_wallet, recipient_name, recipient_email, rarity_tier,
              gift_message, price_eth, price_twd, is_airdrop, status, minted_token_id,
              transfer_tx_hash, transferred_at, created_at
         FROM nft_gifts WHERE collection_id = $1 ORDER BY created_at DESC`,
      [collectionId],
    );
    res.json({ gifts: rows });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const body = req.body as {
      recipient_wallet?: string; sender_wallet?: string; recipient_name?: string; recipient_email?: string;
      rarity_tier?: string; gift_message?: string; price_eth?: string; price_twd?: string;
      payment_method?: string; is_airdrop?: boolean;
    };
    if (!body.recipient_wallet || !ETH_ADDRESS_RE.test(body.recipient_wallet)) {
      res.status(400).json({ error: "recipient_wallet must be a valid Ethereum address" }); return;
    }

    if (body.is_airdrop) {
      const result = await airdropOneNftToWallet(collectionId, body.recipient_wallet, body.rarity_tier);
      const { rows } = await pool.query(
        `INSERT INTO nft_gifts (collection_id, sender_wallet, recipient_wallet, recipient_name, recipient_email,
                                 rarity_tier, gift_message, is_airdrop, status, minted_token_id, transfer_tx_hash, transferred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9,$10, CASE WHEN $8 = 'transferred' THEN NOW() ELSE NULL END)
         RETURNING id`,
        [collectionId, body.sender_wallet ?? null, body.recipient_wallet, body.recipient_name ?? null,
         body.recipient_email ?? null, body.rarity_tier ?? null, body.gift_message ?? null,
         result.ok ? "transferred" : "failed", result.tokenId ?? null, result.txHash ?? null],
      );
      if (!result.ok) { res.status(409).json({ error: result.error, id: rows[0].id }); return; }
      res.json({ ok: true, id: rows[0].id, tokenId: result.tokenId, txHash: result.txHash });
      return;
    }

    // Paid gifts need real payment collection/verification, which is out of
    // scope here -- record the order as pending rather than pretending to
    // process a payment that never happened.
    const { rows } = await pool.query(
      `INSERT INTO nft_gifts (collection_id, sender_wallet, recipient_wallet, recipient_name, recipient_email,
                               rarity_tier, gift_message, price_eth, price_twd, payment_method, is_airdrop, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,'pending')
       RETURNING id`,
      [collectionId, body.sender_wallet ?? null, body.recipient_wallet, body.recipient_name ?? null,
       body.recipient_email ?? null, body.rarity_tier ?? null, body.gift_message ?? null,
       body.price_eth ?? null, body.price_twd ?? null, body.payment_method ?? null],
    );
    res.json({ ok: true, id: rows[0].id, note: "Recorded as pending -- payment collection/verification is not implemented yet." });
  } catch (err) { next(err); }
});

router.post("/airdrop", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const body = req.body as { recipient_wallets?: string[]; rarity_tier?: string; gift_message?: string };
    if (!Array.isArray(body.recipient_wallets) || body.recipient_wallets.length === 0) {
      res.status(400).json({ error: "recipient_wallets must be a non-empty array" }); return;
    }
    const invalid = body.recipient_wallets.find((w) => !ETH_ADDRESS_RE.test(w));
    if (invalid) { res.status(400).json({ error: `Invalid wallet address: ${invalid}` }); return; }

    const results = [];
    for (const wallet of body.recipient_wallets) {
      const result = await airdropOneNftToWallet(collectionId, wallet, body.rarity_tier);
      await pool.query(
        `INSERT INTO nft_gifts (collection_id, recipient_wallet, rarity_tier, gift_message, is_airdrop, status, minted_token_id, transfer_tx_hash, transferred_at)
         VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7, CASE WHEN $5 = 'transferred' THEN NOW() ELSE NULL END)`,
        [collectionId, wallet, body.rarity_tier ?? null, body.gift_message ?? null,
         result.ok ? "transferred" : "failed", result.tokenId ?? null, result.txHash ?? null],
      );
      results.push(result);
    }

    const failures = results.filter((r) => !r.ok);
    res.json({
      ok: failures.length === 0,
      succeeded: results.length - failures.length,
      failed: failures.length,
      results,
    });
  } catch (err) { next(err); }
});

router.post("/:id/transfer", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { rows } = await pool.query(
      "SELECT recipient_wallet, is_airdrop, status FROM nft_gifts WHERE id = $1 AND collection_id = $2",
      [req.params.id, collectionId],
    );
    const gift = rows[0];
    if (!gift) { res.status(404).json({ error: "Gift not found" }); return; }
    if (gift.is_airdrop) { res.status(400).json({ error: "Airdrops transfer immediately on creation, not via this endpoint" }); return; }
    if (gift.status !== "pending") { res.status(409).json({ error: `Gift status is '${gift.status}', not 'pending'` }); return; }

    const result = await fulfillPaidGift(collectionId, gift.recipient_wallet);
    await pool.query(
      `UPDATE nft_gifts SET status = 'transferred', minted_token_id = $2, transfer_tx_hash = $3, transferred_at = NOW() WHERE id = $1`,
      [req.params.id, result.tokenId, result.txHash],
    );
    res.json({ ok: true, tokenId: result.tokenId, txHash: result.txHash });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "contract_ops.manage");
    const collectionId = requireCollectionId(req, res);
    if (!collectionId) return;
    const { rows } = await pool.query(
      "SELECT status FROM nft_gifts WHERE id = $1 AND collection_id = $2",
      [req.params.id, collectionId],
    );
    if (!rows[0]) { res.status(404).json({ error: "Gift not found" }); return; }
    if (rows[0].status === "transferred") { res.status(409).json({ error: "Cannot cancel a gift that has already been transferred" }); return; }
    await pool.query("UPDATE nft_gifts SET status = 'cancelled' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
