-- Marks which single collection Bearth-FE (the customer-facing mint site)
-- represents. Previously this had no DB-side source of truth at all --
-- Bearth-FE just read a static build-time env var, which caused a real
-- production outage when a collection was redeployed and the env var
-- wasn't updated. The partial unique index enforces "at most one" so
-- toggling one collection on always requires explicitly turning others off.

ALTER TABLE nft_collections
  ADD COLUMN IF NOT EXISTS is_public_site BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_nft_collections_one_public_site
  ON nft_collections ((is_public_site))
  WHERE is_public_site = TRUE;

CREATE OR REPLACE FUNCTION public.nft_collections_set_public_site(p_id uuid)
 RETURNS TABLE(id uuid, name character varying, contract_address text, is_public_site boolean)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_collections c WHERE c.id = p_id) THEN
    RAISE EXCEPTION 'Collection not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE nft_collections SET is_public_site = FALSE WHERE nft_collections.is_public_site = TRUE AND nft_collections.id != p_id;
  UPDATE nft_collections SET is_public_site = TRUE WHERE nft_collections.id = p_id;
  RETURN QUERY SELECT c.id, c.name, c.contract_address, c.is_public_site FROM nft_collections c WHERE c.id = p_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.nft_collections_clear_public_site(p_id uuid)
 RETURNS TABLE(id uuid, name character varying, contract_address text, is_public_site boolean)
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE nft_collections SET is_public_site = FALSE WHERE nft_collections.id = p_id;
  RETURN QUERY SELECT c.id, c.name, c.contract_address, c.is_public_site FROM nft_collections c WHERE c.id = p_id;
END;
$function$;

-- Seed: Bearth-FE's current env var already points at Test1 -- mark it as
-- the public collection now so behavior is identical before/after this
-- migration (no silent switch of which contract customers see).
UPDATE nft_collections SET is_public_site = TRUE WHERE id = '5cf741b7-c3ac-4c69-9d1e-348fc0fbe09c';
