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
    'filebaseBucket',           nc.filebase_bucket,
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
