-- Two related gaps closed together:
-- 1. Connecting a wallet on Bearth-FE never actually added it to
--    nft_collection_whitelist (the per-collection merkle-tree table real
--    minting checks) -- only a generic, unrelated customer_wallets.is_whitelisted
--    flag. Already flagged in code as unfinished ("Once Bearth-FE is taught
--    which collection it represents, pass collectionId here too").
-- 2. Two different wallets connecting anonymously (no email) had no way to
--    be recognized as the same real customer. Privy's own user.id is a
--    persistent identity that can span multiple linked wallets -- storing it
--    lets a second wallet linked to the same Privy session reuse the same
--    users row instead of becoming a brand-new "Customer" placeholder.

ALTER TABLE users ADD COLUMN IF NOT EXISTS privy_user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_privy_user_id ON users(privy_user_id) WHERE privy_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.customer_wallet_auto_register(
  p_address text,
  p_source character varying DEFAULT 'wallet_connect'::character varying,
  p_privy_user_id text DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_lower   TEXT        := lower(p_address);
  v_user_id UUID;
  v_role_id UUID;
  v_code    VARCHAR(10);
BEGIN
  -- Same Privy identity already known -- reuse that customer regardless of
  -- which wallet this is, so multiple wallets under one Privy session
  -- correctly resolve to the same real customer.
  IF p_privy_user_id IS NOT NULL THEN
    SELECT u.id INTO v_user_id FROM users u WHERE u.privy_user_id = p_privy_user_id LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    SELECT cw.user_id INTO v_user_id
    FROM customer_wallets cw
    WHERE lower(cw.address) = v_lower AND cw.user_id IS NOT NULL
    LIMIT 1;
  END IF;

  IF v_user_id IS NOT NULL THEN
    IF p_privy_user_id IS NOT NULL THEN
      UPDATE users SET privy_user_id = p_privy_user_id WHERE id = v_user_id AND privy_user_id IS NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM customer_wallets cw WHERE lower(cw.address) = v_lower) THEN
      INSERT INTO customer_wallets (address, user_id, is_whitelisted, source)
      VALUES (v_lower, v_user_id, TRUE, p_source);
    ELSE
      UPDATE customer_wallets SET user_id = v_user_id, is_whitelisted = TRUE WHERE lower(address) = v_lower;
    END IF;
    RETURN v_user_id;
  END IF;

  SELECT r.id INTO v_role_id FROM roles r WHERE r.code = 'customer';
  v_code := 'CU' || LPAD(nextval('seq_user_cu')::TEXT, 3, '0');
  INSERT INTO users (user_code, first_name, last_name, role_id, privy_user_id)
  VALUES (v_code, 'Customer', '', v_role_id, p_privy_user_id)
  RETURNING id INTO v_user_id;

  IF NOT EXISTS (SELECT 1 FROM customer_wallets cw WHERE lower(cw.address) = v_lower) THEN
    INSERT INTO customer_wallets (address, user_id, is_whitelisted, source)
    VALUES (v_lower, v_user_id, TRUE, p_source);
  ELSE
    UPDATE customer_wallets
    SET user_id = v_user_id, is_whitelisted = TRUE, source = p_source
    WHERE lower(address) = v_lower;
  END IF;

  RETURN v_user_id;
END;
$function$;
