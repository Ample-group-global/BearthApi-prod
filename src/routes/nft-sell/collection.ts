import { Router } from "express";
import pool from "../../pool";

const router = Router();

// GET /api/nft-sell/collection/tokens?owner=0x...&limit=200 — a wallet's owned
// NFTs. Public, no auth -- called directly by Bearth-FE's Memory Hall gallery
// (src/components/bearth/collection/MemoryHallGallery.tsx / src/lib/memory-hall.ts),
// which has no admin session. Pre-reveal, only ownership/wave facts are exposed;
// is_revealed/image_ipfs_hash naturally stay null/false until the separate
// reveal step runs (nft_records never gets artwork fields touched at mint time
// -- see nft_record_sync_mint, patch_v15).
router.get("/tokens", async (req, res, next) => {
  try {
    const owner = String(req.query.owner ?? "").toLowerCase();
    if (!owner) return res.status(400).json({ error: "owner query param required" });

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1), 500);

    const { rows } = await pool.query(
      `SELECT token_id, owner_address, on_chain_wave_num, rarity_tier,
              is_revealed, image_ipfs_hash, minted_at
         FROM nft_records
        WHERE owner_address = $1 AND token_id IS NOT NULL
        ORDER BY token_id ASC
        LIMIT $2`,
      [owner, limit],
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM nft_records WHERE owner_address = $1 AND token_id IS NOT NULL`,
      [owner],
    );

    res.json({
      total: Number(countRows[0]?.total ?? 0),
      tokens: rows.map((r) => ({
        token_id: Number(r.token_id),
        owner_address: r.owner_address,
        wave_number: r.on_chain_wave_num,
        // rarity_tier is a static property of the pre-generated art asset a
        // token got FCFS-linked to at mint (see nft_record_sync_mint) -- it
        // must stay hidden pre-reveal or it defeats the point of the blind
        // box (a high-rarity token would be identifiable by tokenId before
        // reveal). Masked here rather than relying on the frontend to hide it.
        rarity_tier: r.is_revealed ? r.rarity_tier : null,
        is_revealed: r.is_revealed,
        // Same masking as rarity_tier -- image_ipfs_hash is the real,
        // generation-time artwork hash for the row this token got linked to;
        // the frontend already gates rendering it behind is_revealed, but
        // that shouldn't be the only thing standing between a blind-box
        // token and its actual artwork.
        image_ipfs_hash: r.is_revealed ? r.image_ipfs_hash : null,
        minted_at: r.minted_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
