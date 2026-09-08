import { Router } from "express";
import pool from "../../pool";

const router = Router();

const FILEBASE_GATEWAY = "https://amgbearth.myfilebase.com/ipfs";

function toGatewayUrl(uri: string | null | undefined): string | null {
  if (!uri) return null;
  return uri.startsWith("ipfs://") ? `${FILEBASE_GATEWAY}/${uri.slice(7)}` : uri;
}

interface BlindBoxAssets {
  imageUrl: string | null;
  videoUrl: string | null;
}

// blind_box_uri points to a shared metadata JSON (same for every unrevealed
// token in a wave -- verified: {"image": "ipfs://...", "animation_url":
// "ipfs://...video/mp4..."}), not an image/video directly. Resolved once per
// distinct URI and reused across every row that shares it, rather than
// fetching it again per token.
async function resolveBlindBoxAssets(
  blindBoxUri: string,
): Promise<BlindBoxAssets> {
  try {
    const res = await fetch(toGatewayUrl(blindBoxUri)!);
    if (!res.ok) return { imageUrl: null, videoUrl: null };
    const meta = (await res.json()) as { image?: string; animation_url?: string };
    return {
      imageUrl: toGatewayUrl(meta.image),
      videoUrl: toGatewayUrl(meta.animation_url),
    };
  } catch {
    return { imageUrl: null, videoUrl: null };
  }
}

// GET /api/nft-sell/collection/tokens?owner=0x...&limit=200 — a wallet's owned
// NFTs. Public, no auth -- called directly by Bearth-FE's Memory Hall gallery
// (src/components/bearth/collection/MemoryHallGallery.tsx / src/lib/memory-hall.ts),
// which has no admin session. Pre-reveal, the real artwork/rarity stay hidden
// (is_revealed/image_ipfs_hash naturally stay null/false until the separate
// reveal step runs -- see nft_record_sync_mint, patch_v15) but token_id and
// the shared blind-box placeholder image/video are always shown -- neither
// leaks anything about a specific token's eventual rarity (token_id is public
// on-chain regardless of what this API returns; the blind-box asset is
// identical across every sealed token in a wave).
router.get("/tokens", async (req, res, next) => {
  try {
    const owner = String(req.query.owner ?? "").toLowerCase();
    if (!owner) return res.status(400).json({ error: "owner query param required" });

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1), 500);

    const { rows } = await pool.query(
      `SELECT token_id, owner_address, on_chain_wave_num, rarity_tier,
              is_revealed, image_ipfs_hash, blind_box_uri, minted_at
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

    const distinctBlindBoxUris = [
      ...new Set(
        rows
          .filter((r) => !r.is_revealed && r.blind_box_uri)
          .map((r) => r.blind_box_uri as string),
      ),
    ];
    const blindBoxAssets = new Map<string, BlindBoxAssets>(
      await Promise.all(
        distinctBlindBoxUris.map(
          async (uri) => [uri, await resolveBlindBoxAssets(uri)] as const,
        ),
      ),
    );

    res.json({
      total: Number(countRows[0]?.total ?? 0),
      tokens: rows.map((r) => {
        const blindBox = !r.is_revealed && r.blind_box_uri
          ? blindBoxAssets.get(r.blind_box_uri as string)
          : undefined;
        return {
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
          blind_box_image_url: blindBox?.imageUrl ?? null,
          blind_box_video_url: blindBox?.videoUrl ?? null,
          minted_at: r.minted_at,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
