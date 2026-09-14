-- GiftsTab.tsx (Admin) has been a UI-only stub -- no /api/nft-sell/gifts
-- route or backing table ever existed, so both "Gift" (paid) and "Airdrop"
-- (free) always failed. This adds the table backing both. Only the airdrop
-- path is wired to actually execute a transfer in this pass -- paid gifts
-- need real payment handling, out of scope here, and are recorded as
-- 'pending' without moving any NFT.

CREATE TABLE IF NOT EXISTS nft_gifts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     UUID NOT NULL REFERENCES nft_collections(id),
  sender_wallet     TEXT,
  recipient_wallet  TEXT NOT NULL,
  recipient_name    TEXT,
  recipient_email   TEXT,
  rarity_tier       TEXT,
  gift_message      TEXT,
  price_eth         TEXT,
  price_twd         TEXT,
  payment_method    TEXT,
  is_airdrop        BOOLEAN NOT NULL DEFAULT FALSE,
  status            TEXT NOT NULL DEFAULT 'pending',
  minted_token_id   INTEGER,
  transfer_tx_hash  TEXT,
  transferred_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nft_gifts_collection ON nft_gifts(collection_id);
