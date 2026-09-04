-- Per-collection smart contract deployment. Each new collection can now get
-- its own BearthNFT proxy deployed (testnet or mainnet, admin-selectable),
-- instead of every collection sharing the single global CONTRACT_ADDRESS env
-- var. Existing collections (e.g. Bearth V1) are unaffected -- they keep
-- using the shared contract as-is; these columns simply stay NULL for them.
--
-- One deploy per collection: contract_address is left NULL until deployed,
-- then set once and never overwritten by the deploy route (redeploy is
-- refused at the application layer, not enforced here, since a genuine
-- re-deploy after a failed/aborted attempt is a legitimate admin action).

ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_address text;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_network text;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_validator_address text;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_deploy_tx_hash text;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_deployed_at timestamptz;
ALTER TABLE nft_collections ADD COLUMN IF NOT EXISTS contract_deployed_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE nft_collections DROP CONSTRAINT IF EXISTS nft_collections_contract_network_check;
ALTER TABLE nft_collections ADD CONSTRAINT nft_collections_contract_network_check
  CHECK (contract_network IS NULL OR contract_network IN ('sepolia', 'mainnet'));

-- Expose the new columns through the existing collection-detail RPC so
-- ExportPanel can show "already deployed" state without a second endpoint.
CREATE OR REPLACE FUNCTION public.nft_gen_collection_get(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE v_result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_collections WHERE id = p_id) THEN
    RAISE EXCEPTION 'Collection not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT json_build_object(
    'id',              nc.id,
    'name',            nc.name,
    'description',     nc.description,
    'symbol',          nc.symbol,
    'network',         nc.network,
    'royaltyBps',      nc.royalty_bps,
    'creatorWallet',   nc.creator_wallet,
    'formatWidth',     nc.format_width,
    'formatHeight',    nc.format_height,
    'smoothing',       nc.smoothing,
    'bgGenerate',      nc.bg_generate,
    'bgStaticColor',   nc.bg_static_color,
    'shuffleOutput',   nc.shuffle_output,
    'dnaTolerance',    nc.dna_tolerance,
    'baseUri',         nc.base_uri,
    'status',          nc.status,
    'supply',          nc.supply,
    'nameFormat',      nc.name_format,
    'formatType',      nc.format_type,
    'conflictRules',   nc.conflict_rules,
    'createdAt',       nc.created_at,
    'updatedAt',       nc.updated_at,
    'contractAddress',          nc.contract_address,
    'contractNetwork',          nc.contract_network,
    'contractValidatorAddress', nc.contract_validator_address,
    'contractDeployTxHash',     nc.contract_deploy_tx_hash,
    'contractDeployedAt',       nc.contract_deployed_at,
    'layers', COALESCE(
      (SELECT json_agg(
        json_build_object(
          'id',             nl.id,
          'name',           nl.name,
          'displayName',    nl.display_name,
          'sortOrder',      nl.sort_order,
          'layerRarityPct', nl.layer_rarity_pct,
          'isActive',       nl.is_active,
          'traitCount',     (SELECT COUNT(*) FROM nft_traits nt WHERE nt.layer_id = nl.id AND nt.is_active = TRUE)
        ) ORDER BY nl.sort_order
       )
       FROM nft_layers nl WHERE nl.collection_id = nc.id
      ), '[]'::json)
  ) INTO v_result
  FROM nft_collections nc
  WHERE nc.id = p_id;
  RETURN v_result;
END;
$function$;
