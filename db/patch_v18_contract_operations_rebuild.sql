CREATE TABLE IF NOT EXISTS nft_royalty_config (
  id                integer PRIMARY KEY DEFAULT 1,
  royalty_pct_bps   integer NOT NULL DEFAULT 0,
  receiver_address  text,
  enforce_royalty   boolean NOT NULL DEFAULT true,
  last_tx_hash      text,
  synced_at         timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nft_royalty_config_single_row CHECK (id = 1)
);
INSERT INTO nft_royalty_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION nft_royalty_config_get()
RETURNS nft_royalty_config
LANGUAGE sql STABLE AS $$
  SELECT * FROM nft_royalty_config WHERE id = 1;
$$;

CREATE OR REPLACE FUNCTION nft_royalty_config_upsert(
  p_fee_bps   integer,
  p_receiver  text,
  p_enforce   boolean,
  p_tx_hash   text
) RETURNS nft_royalty_config
LANGUAGE sql AS $$
  UPDATE nft_royalty_config
  SET royalty_pct_bps  = p_fee_bps,
      receiver_address = p_receiver,
      enforce_royalty  = p_enforce,
      last_tx_hash      = COALESCE(p_tx_hash, last_tx_hash),
      synced_at         = now(),
      updated_at        = now()
  WHERE id = 1
  RETURNING *;
$$;

CREATE TABLE IF NOT EXISTS royalty_marketplaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address     text NOT NULL UNIQUE,
  name        text,
  enabled     boolean NOT NULL DEFAULT true,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO nft_collection_config (id, current_phase, max_supply, sbt_enabled, royalty_enforced, purchase_limit_enabled, normal_max_per_wallet, synced_at)
VALUES (1, 'Whitelist', 9999, false, true, true, 5, now())
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS membership_tiers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL,
  tier_level               integer NOT NULL,
  qualifying_wave_number   integer,
  qualifying_rarity_tier   text,
  min_tokens_held          integer NOT NULL DEFAULT 1,
  discount_pct             numeric(5,2) NOT NULL DEFAULT 0,
  benefits                 jsonb,
  priority_whitelist_slot  integer,
  is_active                boolean NOT NULL DEFAULT true,
  sort_order               integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS treasury_timelock_ops (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id      text NOT NULL UNIQUE,
  purpose           text NOT NULL,
  target            text NOT NULL,
  value_wei         text NOT NULL DEFAULT '0',
  call_data         text NOT NULL,
  predecessor       text NOT NULL DEFAULT '0x0000000000000000000000000000000000000000000000000000000000000000',
  salt              text NOT NULL,
  new_value         text,
  eta               timestamptz NOT NULL,
  scheduled_tx_hash text NOT NULL,
  executed_tx_hash  text,
  executed_at       timestamptz,
  cancelled_at      timestamptz,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_treasury_timelock_ops_purpose ON treasury_timelock_ops(purpose, executed_at, cancelled_at);
