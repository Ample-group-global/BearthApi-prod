-- ============================================================
-- BearthDev-V1 — Complete schema + seed
-- Scope: Login / Forgot Password / NFT Studio / RBAC only
-- 14 tables, all indexes, all nft_gen_* functions, seed data
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
  id          UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code        VARCHAR(50)  NOT NULL UNIQUE,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN      DEFAULT TRUE,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  home_url    TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_code     VARCHAR(10)  UNIQUE,
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(150) UNIQUE,
  phone         VARCHAR(30)  UNIQUE,
  line_id       VARCHAR(100),
  notes         TEXT,
  referrer_id   UUID         REFERENCES users(id),
  role_id       UUID         REFERENCES roles(id),
  password_hash TEXT,
  is_active     BOOLEAN      DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  created_by    UUID         REFERENCES users(id),
  updated_by    UUID         REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS permissions (
  id          UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key         VARCHAR(100) NOT NULL UNIQUE,
  label       VARCHAR(200) NOT NULL,
  module      VARCHAR(50)  NOT NULL,
  description TEXT,
  sort_order  INTEGER      DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menus (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  label        TEXT        NOT NULL,
  href         TEXT        NOT NULL,
  icon         TEXT,
  module       VARCHAR(50),
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  module_label TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id            UUID    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  role_id       UUID    NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID    NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  is_granted    BOOLEAN DEFAULT TRUE,
  UNIQUE (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS role_menus (
  role_id    UUID    NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  menu_id    UUID    NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role_id, menu_id)
);

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id            UUID    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id UUID    NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  is_granted    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, permission_id)
);

CREATE TABLE IF NOT EXISTS nft_collections (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  symbol          VARCHAR(20),
  network         VARCHAR(10)  NOT NULL DEFAULT 'ethereum',
  royalty_bps     INTEGER      NOT NULL DEFAULT 0,
  creator_wallet  TEXT,
  format_width    INTEGER      NOT NULL DEFAULT 512,
  format_height   INTEGER      NOT NULL DEFAULT 512,
  smoothing       BOOLEAN      NOT NULL DEFAULT FALSE,
  bg_generate     BOOLEAN      NOT NULL DEFAULT FALSE,
  bg_static_color VARCHAR(7),
  shuffle_output  BOOLEAN      NOT NULL DEFAULT TRUE,
  dna_tolerance   INTEGER      NOT NULL DEFAULT 10000,
  base_uri        TEXT,
  status          VARCHAR(20)  NOT NULL DEFAULT 'draft',
  created_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  supply          INTEGER      NOT NULL DEFAULT 100,
  name_format     TEXT         NOT NULL DEFAULT '#{{id}}',
  format_type     TEXT         NOT NULL DEFAULT 'png',
  conflict_rules  JSONB        NOT NULL DEFAULT '[]',
  CONSTRAINT nft_collections_status_check     CHECK (status IN ('draft','ready','generating','complete','failed')),
  CONSTRAINT nft_collections_network_check    CHECK (network IN ('ethereum','solana','base','polygon','cardano','xrp')),
  CONSTRAINT nft_collections_royalty_bps_check CHECK (royalty_bps >= 0 AND royalty_bps <= 10000)
);

CREATE TABLE IF NOT EXISTS nft_layers (
  id               UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  collection_id    UUID         NOT NULL REFERENCES nft_collections(id) ON DELETE CASCADE,
  name             VARCHAR(100) NOT NULL,
  display_name     VARCHAR(100),
  bypass_dna       BOOLEAN      NOT NULL DEFAULT FALSE,
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  layer_rarity_pct INTEGER      NOT NULL DEFAULT 100,
  is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_nft_layers_collection_name UNIQUE (collection_id, name)
);

CREATE TABLE IF NOT EXISTS nft_traits (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  layer_id         UUID        NOT NULL REFERENCES nft_layers(id) ON DELETE CASCADE,
  name             VARCHAR(100) NOT NULL,
  file_path        TEXT,
  storage_provider VARCHAR(20) NOT NULL DEFAULT 'filebase',
  rarity_weight    INTEGER     NOT NULL DEFAULT 100,
  rarity_tier      VARCHAR(20) NOT NULL DEFAULT 'common',
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_nft_traits_layer_filepath UNIQUE (layer_id, file_path)
);

CREATE TABLE IF NOT EXISTS nft_generation_jobs (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  collection_id UUID        NOT NULL REFERENCES nft_collections(id) ON DELETE CASCADE,
  edition_size  INTEGER     NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  progress      INTEGER     NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nft_generated_items (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id            UUID        NOT NULL REFERENCES nft_generation_jobs(id) ON DELETE CASCADE,
  edition_number    INTEGER     NOT NULL,
  dna_hash          TEXT        NOT NULL,
  image_path        TEXT,
  metadata_json     JSONB,
  ipfs_image_cid    TEXT,
  ipfs_metadata_cid TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nft_generated_items_job_id_edition_number_key UNIQUE (job_id, edition_number),
  CONSTRAINT nft_generated_items_job_id_dna_hash_key       UNIQUE (job_id, dna_hash)
);

CREATE TABLE IF NOT EXISTS nft_item_traits (
  id          UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id     UUID         NOT NULL REFERENCES nft_generated_items(id) ON DELETE CASCADE,
  trait_id    UUID         REFERENCES nft_traits(id) ON DELETE SET NULL,
  trait_type  VARCHAR(100) NOT NULL,
  trait_value VARCHAR(100) NOT NULL,
  rarity_tier VARCHAR(20),
  CONSTRAINT uq_nft_item_traits_item_trait UNIQUE (item_id, trait_type)
);

CREATE TABLE IF NOT EXISTS nft_upload_batches (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id         UUID        NOT NULL REFERENCES nft_generation_jobs(id) ON DELETE CASCADE,
  provider       VARCHAR(20) NOT NULL DEFAULT 'filebase',
  batch_type     VARCHAR(20) NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_items    INTEGER     NOT NULL DEFAULT 0,
  uploaded_items INTEGER     NOT NULL DEFAULT 0,
  error_message  TEXT,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_nft_gen_items_job_id       ON nft_generated_items  (job_id);
CREATE INDEX IF NOT EXISTS idx_nft_gen_jobs_collection_id  ON nft_generation_jobs  (collection_id);
CREATE INDEX IF NOT EXISTS idx_nft_gen_jobs_status         ON nft_generation_jobs  (status);
CREATE INDEX IF NOT EXISTS idx_nft_item_traits_item_id     ON nft_item_traits       (item_id);
CREATE INDEX IF NOT EXISTS idx_nft_item_traits_trait_id    ON nft_item_traits       (trait_id);
CREATE INDEX IF NOT EXISTS idx_nft_layers_collection_id    ON nft_layers            (collection_id);
CREATE INDEX IF NOT EXISTS idx_nft_layers_sort_order       ON nft_layers            (collection_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_nft_traits_active           ON nft_traits            (layer_id, is_active);
CREATE INDEX IF NOT EXISTS idx_nft_traits_layer_id         ON nft_traits            (layer_id);
CREATE INDEX IF NOT EXISTS idx_nft_upload_batches_job_id   ON nft_upload_batches    (job_id);

-- ============================================================
-- FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION public.nft_gen_collection_create(p_name character varying, p_description text DEFAULT NULL::text, p_symbol character varying DEFAULT NULL::character varying, p_network character varying DEFAULT 'eth'::character varying, p_royalty_bps integer DEFAULT 0, p_creator_wallet text DEFAULT NULL::text, p_format_width integer DEFAULT 512, p_format_height integer DEFAULT 512, p_smoothing boolean DEFAULT false, p_bg_generate boolean DEFAULT false, p_bg_static_color character varying DEFAULT NULL::character varying, p_shuffle_output boolean DEFAULT true, p_dna_tolerance integer DEFAULT 10000, p_created_by uuid DEFAULT NULL::uuid, p_supply integer DEFAULT 100, p_name_format text DEFAULT '#{{id}}'::text, p_format_type text DEFAULT 'png'::text, p_conflict_rules jsonb DEFAULT '[]'::jsonb)
 RETURNS TABLE(id uuid, name character varying, status character varying, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$

BEGIN

  IF p_name IS NULL OR trim(p_name) = '' THEN

    RAISE EXCEPTION 'Collection name is required' USING ERRCODE = 'P0001';

  END IF;

  RETURN QUERY

  INSERT INTO nft_collections (

    name, description, symbol, network, royalty_bps, creator_wallet,

    format_width, format_height, smoothing, bg_generate, bg_static_color,

    shuffle_output, dna_tolerance, created_by,

    supply, name_format, format_type, conflict_rules

  ) VALUES (

    trim(p_name), p_description, p_symbol, COALESCE(p_network, 'eth'),

    COALESCE(p_royalty_bps, 0), p_creator_wallet,

    COALESCE(p_format_width, 512), COALESCE(p_format_height, 512),

    COALESCE(p_smoothing, FALSE), COALESCE(p_bg_generate, FALSE), p_bg_static_color,

    COALESCE(p_shuffle_output, TRUE), COALESCE(p_dna_tolerance, 10000), p_created_by,

    COALESCE(p_supply, 100), COALESCE(p_name_format, '#{{id}}'), COALESCE(p_format_type, 'png'),

    COALESCE(p_conflict_rules, '[]'::jsonb)

  )

  RETURNING nft_collections.id, nft_collections.name, nft_collections.status, nft_collections.created_at;

END;

$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_collection_delete(p_id uuid)
 RETURNS TABLE(ok boolean, message text)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_collections WHERE id = p_id) THEN
    RAISE EXCEPTION 'Collection not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM nft_generation_jobs WHERE collection_id = p_id AND status = 'processing') THEN
    RAISE EXCEPTION 'Cannot delete collection with an active generation job' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM nft_collections WHERE id = p_id;
  RETURN QUERY SELECT TRUE, 'Collection deleted'::TEXT;
END;
$function$
;

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

$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_collection_update(p_id uuid, p_name character varying DEFAULT NULL::character varying, p_description text DEFAULT NULL::text, p_symbol character varying DEFAULT NULL::character varying, p_network character varying DEFAULT NULL::character varying, p_royalty_bps integer DEFAULT NULL::integer, p_creator_wallet text DEFAULT NULL::text, p_format_width integer DEFAULT NULL::integer, p_format_height integer DEFAULT NULL::integer, p_smoothing boolean DEFAULT NULL::boolean, p_bg_generate boolean DEFAULT NULL::boolean, p_bg_static_color character varying DEFAULT NULL::character varying, p_shuffle_output boolean DEFAULT NULL::boolean, p_dna_tolerance integer DEFAULT NULL::integer, p_base_uri text DEFAULT NULL::text, p_status character varying DEFAULT NULL::character varying, p_supply integer DEFAULT NULL::integer, p_name_format text DEFAULT NULL::text, p_format_type text DEFAULT NULL::text, p_conflict_rules jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(id uuid, name character varying, status character varying, updated_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$

BEGIN

  IF NOT EXISTS (SELECT 1 FROM nft_collections WHERE nft_collections.id = p_id) THEN

    RAISE EXCEPTION 'Collection not found' USING ERRCODE = 'P0002';

  END IF;

  RETURN QUERY

  UPDATE nft_collections SET

    name            = COALESCE(NULLIF(trim(p_name), ''), nft_collections.name),

    description     = COALESCE(p_description,    nft_collections.description),

    symbol          = COALESCE(p_symbol,          nft_collections.symbol),

    network         = COALESCE(p_network,         nft_collections.network),

    royalty_bps     = COALESCE(p_royalty_bps,     nft_collections.royalty_bps),

    creator_wallet  = COALESCE(p_creator_wallet,  nft_collections.creator_wallet),

    format_width    = COALESCE(p_format_width,    nft_collections.format_width),

    format_height   = COALESCE(p_format_height,   nft_collections.format_height),

    smoothing       = COALESCE(p_smoothing,       nft_collections.smoothing),

    bg_generate     = COALESCE(p_bg_generate,     nft_collections.bg_generate),

    bg_static_color = COALESCE(p_bg_static_color, nft_collections.bg_static_color),

    shuffle_output  = COALESCE(p_shuffle_output,  nft_collections.shuffle_output),

    dna_tolerance   = COALESCE(p_dna_tolerance,   nft_collections.dna_tolerance),

    base_uri        = COALESCE(p_base_uri,        nft_collections.base_uri),

    status          = COALESCE(p_status,          nft_collections.status),

    supply          = COALESCE(p_supply,          nft_collections.supply),

    name_format     = COALESCE(p_name_format,     nft_collections.name_format),

    format_type     = COALESCE(p_format_type,     nft_collections.format_type),

    conflict_rules  = COALESCE(p_conflict_rules,  nft_collections.conflict_rules),

    updated_at      = NOW()

  WHERE nft_collections.id = p_id

  RETURNING nft_collections.id, nft_collections.name, nft_collections.status, nft_collections.updated_at;

END;

$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_collections_list(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, name character varying, description text, symbol character varying, network character varying, royalty_bps integer, format_width integer, format_height integer, shuffle_output boolean, status character varying, layer_count bigint, created_at timestamp with time zone, updated_at timestamp with time zone, total_count bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    nc.id, nc.name, nc.description, nc.symbol, nc.network,
    nc.royalty_bps, nc.format_width, nc.format_height,
    nc.shuffle_output, nc.status,
    COUNT(DISTINCT nl.id) AS layer_count,
    nc.created_at, nc.updated_at,
    COUNT(*) OVER() AS total_count
  FROM nft_collections nc
  LEFT JOIN nft_layers nl ON nl.collection_id = nc.id
  GROUP BY nc.id
  ORDER BY nc.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_item_update_ipfs(p_id uuid, p_ipfs_image_cid text, p_ipfs_metadata_cid text)
 RETURNS TABLE(ok boolean)
 LANGUAGE sql
AS $function$
  UPDATE nft_generated_items
  SET ipfs_image_cid = p_ipfs_image_cid, ipfs_metadata_cid = p_ipfs_metadata_cid
  WHERE id = p_id;
  SELECT TRUE;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_items_batch_update_ipfs(p_job_id uuid, p_edition_numbers integer[], p_image_cids text[], p_metadata_cids text[], p_image_paths text[] DEFAULT NULL::text[])
 RETURNS integer
 LANGUAGE sql
AS $function$
  WITH updated AS (
    UPDATE nft_generated_items gi
    SET ipfs_image_cid    = t.image_cid,
        ipfs_metadata_cid = t.metadata_cid,
        image_path        = COALESCE(t.image_path, gi.image_path)
    FROM UNNEST(p_edition_numbers, p_image_cids, p_metadata_cids,
                COALESCE(p_image_paths, ARRAY[]::TEXT[]))
         AS t(edition_number, image_cid, metadata_cid, image_path)
    WHERE gi.job_id         = p_job_id
      AND gi.edition_number = t.edition_number
    RETURNING 1
  )
  SELECT COUNT(*)::INT FROM updated;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_job_complete(p_id uuid)
 RETURNS TABLE(ok boolean)
 LANGUAGE plpgsql
AS $function$
DECLARE v_collection_id UUID;
BEGIN
  SELECT collection_id INTO v_collection_id FROM nft_generation_jobs WHERE id = p_id;
  UPDATE nft_generation_jobs
  SET status = 'complete', progress = 100, completed_at = NOW(), updated_at = NOW()
  WHERE id = p_id;
  UPDATE nft_collections SET status = 'complete', updated_at = NOW() WHERE id = v_collection_id;
  RETURN QUERY SELECT TRUE;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_job_create(p_collection_id uuid, p_edition_size integer, p_created_by uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, collection_id uuid, edition_size integer, status character varying, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_collections WHERE nft_collections.id = p_collection_id) THEN
    RAISE EXCEPTION 'Collection not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_edition_size IS NULL OR p_edition_size <= 0 THEN
    RAISE EXCEPTION 'Edition size must be greater than 0' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM nft_generation_jobs
    WHERE nft_generation_jobs.collection_id = p_collection_id AND nft_generation_jobs.status IN ('pending', 'processing')
  ) THEN
    RAISE EXCEPTION 'A generation job is already running for this collection' USING ERRCODE = 'P0001';
  END IF;
  UPDATE nft_collections SET status = 'generating', updated_at = NOW() WHERE nft_collections.id = p_collection_id;
  RETURN QUERY
  INSERT INTO nft_generation_jobs (collection_id, edition_size, created_by)
  VALUES (p_collection_id, p_edition_size, p_created_by)
  RETURNING nft_generation_jobs.id, nft_generation_jobs.collection_id, nft_generation_jobs.edition_size, nft_generation_jobs.status, nft_generation_jobs.created_at;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_job_fail(p_id uuid, p_error_message text)
 RETURNS TABLE(ok boolean)
 LANGUAGE plpgsql
AS $function$
DECLARE v_collection_id UUID;
BEGIN
  SELECT collection_id INTO v_collection_id FROM nft_generation_jobs WHERE id = p_id;
  UPDATE nft_generation_jobs
  SET status = 'failed', error_message = p_error_message, completed_at = NOW(), updated_at = NOW()
  WHERE id = p_id;
  UPDATE nft_collections SET status = 'failed', updated_at = NOW() WHERE id = v_collection_id;
  RETURN QUERY SELECT TRUE;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_job_get(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE v_result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_generation_jobs WHERE id = p_id) THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT json_build_object(
    'id',             j.id,
    'collectionId',   j.collection_id,
    'collectionName', nc.name,
    'editionSize',    j.edition_size,
    'status',         j.status,
    'progress',       j.progress,
    'errorMessage',   j.error_message,
    'startedAt',      j.started_at,
    'completedAt',    j.completed_at,
    'createdAt',      j.created_at,
    'generatedCount', (SELECT COUNT(*) FROM nft_generated_items gi WHERE gi.job_id = j.id)
  ) INTO v_result
  FROM nft_generation_jobs j
  LEFT JOIN nft_collections nc ON nc.id = j.collection_id
  WHERE j.id = p_id;
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_job_start(p_id uuid)
 RETURNS TABLE(ok boolean)
 LANGUAGE sql
AS $function$
  UPDATE nft_generation_jobs
  SET status = 'processing', started_at = NOW(), updated_at = NOW()
  WHERE id = p_id AND status = 'pending';
  SELECT TRUE;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_job_update_progress(p_id uuid, p_progress integer)
 RETURNS TABLE(ok boolean)
 LANGUAGE sql
AS $function$
  UPDATE nft_generation_jobs SET progress = p_progress, updated_at = NOW() WHERE id = p_id;
  SELECT TRUE;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_layer_create(p_collection_id uuid, p_name character varying, p_display_name character varying DEFAULT NULL::character varying, p_bypass_dna boolean DEFAULT false, p_sort_order integer DEFAULT NULL::integer, p_layer_rarity_pct integer DEFAULT 100)
 RETURNS TABLE(id uuid, name character varying, sort_order integer, layer_rarity_pct integer, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE v_sort INT;
BEGIN
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Layer name is required' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM nft_collections WHERE nft_collections.id = p_collection_id) THEN
    RAISE EXCEPTION 'Collection not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(MAX(nl.sort_order) + 10, 10) INTO v_sort
  FROM nft_layers nl WHERE nl.collection_id = p_collection_id;
  RETURN QUERY
  INSERT INTO nft_layers (collection_id, name, display_name, bypass_dna, sort_order, layer_rarity_pct)
  VALUES (
    p_collection_id, trim(p_name), p_display_name,
    COALESCE(p_bypass_dna, FALSE),
    COALESCE(p_sort_order, v_sort),
    COALESCE(p_layer_rarity_pct, 100)
  )
  ON CONFLICT ON CONSTRAINT uq_nft_layers_collection_name DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, nft_layers.display_name),
    is_active    = TRUE,
    updated_at   = NOW()
  RETURNING nft_layers.id, nft_layers.name, nft_layers.sort_order, nft_layers.layer_rarity_pct, nft_layers.created_at;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_layer_delete(p_id uuid)
 RETURNS TABLE(ok boolean, message text)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_layers WHERE id = p_id) THEN
    RAISE EXCEPTION 'Layer not found' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM nft_layers WHERE id = p_id;
  RETURN QUERY SELECT TRUE, 'Layer deleted'::TEXT;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_layer_get(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE v_result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_layers WHERE id = p_id) THEN
    RAISE EXCEPTION 'Layer not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT json_build_object(
    'id',             nl.id,
    'collectionId',   nl.collection_id,
    'name',           nl.name,
    'displayName',    nl.display_name,
    'bypassDna',      nl.bypass_dna,
    'sortOrder',      nl.sort_order,
    'layerRarityPct', nl.layer_rarity_pct,
    'isActive',       nl.is_active,
    'createdAt',      nl.created_at,
    'updatedAt',      nl.updated_at,
    'traits', COALESCE(
      (SELECT json_agg(
        json_build_object(
          'id',              nt.id,
          'name',            nt.name,
          'filePath',        nt.file_path,
          'storageProvider', nt.storage_provider,
          'rarityWeight',    nt.rarity_weight,
          'rarityTier',      nt.rarity_tier,
          'isActive',        nt.is_active,
          'rarityPct', ROUND(
            nt.rarity_weight::NUMERIC /
            NULLIF((SELECT SUM(t2.rarity_weight) FROM nft_traits t2
                    WHERE t2.layer_id = nl.id AND t2.is_active = TRUE), 0)
            * 100, 2
          )
        ) ORDER BY nt.rarity_weight DESC
       )
       FROM nft_traits nt WHERE nt.layer_id = nl.id
      ), '[]'::json)
  ) INTO v_result
  FROM nft_layers nl
  WHERE nl.id = p_id;
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_layer_update(p_id uuid, p_name character varying DEFAULT NULL::character varying, p_display_name character varying DEFAULT NULL::character varying, p_bypass_dna boolean DEFAULT NULL::boolean, p_sort_order integer DEFAULT NULL::integer, p_layer_rarity_pct integer DEFAULT NULL::integer, p_is_active boolean DEFAULT NULL::boolean)
 RETURNS TABLE(id uuid, name character varying, sort_order integer, layer_rarity_pct integer, is_active boolean, updated_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_layers WHERE nft_layers.id = p_id) THEN
    RAISE EXCEPTION 'Layer not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  UPDATE nft_layers SET
    name             = COALESCE(NULLIF(trim(p_name), ''), nft_layers.name),
    display_name     = COALESCE(p_display_name,           nft_layers.display_name),
    bypass_dna       = COALESCE(p_bypass_dna,             nft_layers.bypass_dna),
    sort_order       = COALESCE(p_sort_order,             nft_layers.sort_order),
    layer_rarity_pct = COALESCE(p_layer_rarity_pct,       nft_layers.layer_rarity_pct),
    is_active        = COALESCE(p_is_active,              nft_layers.is_active),
    updated_at       = NOW()
  WHERE nft_layers.id = p_id
  RETURNING nft_layers.id, nft_layers.name, nft_layers.sort_order, nft_layers.layer_rarity_pct, nft_layers.is_active, nft_layers.updated_at;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_layers_list(p_collection_id uuid)
 RETURNS TABLE(id uuid, collection_id uuid, name character varying, display_name character varying, bypass_dna boolean, sort_order integer, layer_rarity_pct integer, is_active boolean, trait_count bigint, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_collections WHERE nft_collections.id = p_collection_id) THEN
    RAISE EXCEPTION 'Collection not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  SELECT
    nl.id, nl.collection_id, nl.name, nl.display_name,
    nl.bypass_dna, nl.sort_order, nl.layer_rarity_pct, nl.is_active,
    COUNT(nt.id) AS trait_count,
    nl.created_at
  FROM nft_layers nl
  LEFT JOIN nft_traits nt ON nt.layer_id = nl.id
  WHERE nl.collection_id = p_collection_id
  GROUP BY nl.id
  ORDER BY nl.sort_order ASC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_layers_reconcile(p_collection_id uuid, p_active_names text[])
 RETURNS integer
 LANGUAGE plpgsql
AS $function$

DECLARE v_count INT;

BEGIN

  DELETE FROM nft_layers

  WHERE collection_id = p_collection_id

    AND name <> ALL(p_active_names);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;

END;

$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_layers_reorder(p_collection_id uuid, p_ids uuid[], p_sort_orders integer[])
 RETURNS TABLE(ok boolean)
 LANGUAGE plpgsql
AS $function$
DECLARE i INT;
BEGIN
  IF array_length(p_ids, 1) != array_length(p_sort_orders, 1) THEN
    RAISE EXCEPTION 'ids and sort_orders arrays must be the same length' USING ERRCODE = 'P0001';
  END IF;
  FOR i IN 1 .. array_length(p_ids, 1) LOOP
    UPDATE nft_layers SET sort_order = p_sort_orders[i], updated_at = NOW()
    WHERE id = p_ids[i] AND collection_id = p_collection_id;
  END LOOP;
  RETURN QUERY SELECT TRUE;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_rarity_report(p_job_id uuid)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE v_total INT; v_result JSON;
BEGIN
  SELECT COUNT(*) INTO v_total FROM nft_generated_items WHERE job_id = p_job_id;
  SELECT json_agg(t ORDER BY t.trait_type, t.count DESC) INTO v_result
  FROM (
    SELECT it.trait_type, it.trait_value, it.rarity_tier,
           COUNT(*) AS count,
           ROUND(COUNT(*)::NUMERIC / NULLIF(v_total, 0) * 100, 2) AS pct
    FROM nft_item_traits it
    JOIN nft_generated_items gi ON it.item_id = gi.id
    WHERE gi.job_id = p_job_id
    GROUP BY it.trait_type, it.trait_value, it.rarity_tier
  ) t;
  RETURN json_build_object('totalEditions', v_total, 'traits', COALESCE(v_result, '[]'::json));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_trait_create(p_layer_id uuid, p_name character varying, p_file_path text, p_rarity_tier character varying DEFAULT 'common'::character varying, p_storage_provider character varying DEFAULT 'filebase'::character varying, p_rarity_weight integer DEFAULT NULL::integer)
 RETURNS TABLE(id uuid, name character varying, rarity_weight integer, rarity_tier character varying, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$

DECLARE v_weight INT;

BEGIN

  IF p_name IS NULL OR trim(p_name) = '' THEN

    RAISE EXCEPTION 'Trait name is required' USING ERRCODE = 'P0001';

  END IF;

  IF NOT EXISTS (SELECT 1 FROM nft_layers WHERE nft_layers.id = p_layer_id) THEN

    RAISE EXCEPTION 'Layer not found' USING ERRCODE = 'P0002';

  END IF;

  IF p_rarity_weight IS NOT NULL AND p_rarity_weight <= 0 THEN

    RAISE EXCEPTION 'rarity_weight must be > 0 — use is_active=false to disable a trait' USING ERRCODE = 'P0001';

  END IF;



  v_weight := COALESCE(p_rarity_weight, CASE COALESCE(lower(p_rarity_tier), 'common')

    WHEN 'legendary' THEN 3

    WHEN 'epic'      THEN 10

    WHEN 'rare'      THEN 30

    WHEN 'common'    THEN 100

    ELSE 100

  END);



  RETURN QUERY

  INSERT INTO nft_traits (layer_id, name, file_path, storage_provider, rarity_weight, rarity_tier)

  VALUES (

    p_layer_id, trim(p_name), NULLIF(trim(COALESCE(p_file_path, '')), ''),

    COALESCE(p_storage_provider, 'filebase'),

    v_weight,

    COALESCE(lower(p_rarity_tier), 'common')

  )

  ON CONFLICT ON CONSTRAINT uq_nft_traits_layer_filepath DO UPDATE SET

    name             = EXCLUDED.name,

    storage_provider = EXCLUDED.storage_provider,

    is_active        = TRUE,

    updated_at       = NOW()

  RETURNING nft_traits.id, nft_traits.name, nft_traits.rarity_weight, nft_traits.rarity_tier, nft_traits.created_at;

END;

$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_trait_delete(p_id uuid)
 RETURNS TABLE(ok boolean, message text)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_traits WHERE id = p_id) THEN
    RAISE EXCEPTION 'Trait not found' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM nft_traits WHERE id = p_id;
  RETURN QUERY SELECT TRUE, 'Trait deleted'::TEXT;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_trait_update(p_id uuid, p_name character varying DEFAULT NULL::character varying, p_file_path text DEFAULT NULL::text, p_storage_provider character varying DEFAULT NULL::character varying, p_rarity_tier character varying DEFAULT NULL::character varying, p_is_active boolean DEFAULT NULL::boolean, p_rarity_weight integer DEFAULT NULL::integer)
 RETURNS TABLE(id uuid, name character varying, rarity_weight integer, rarity_tier character varying, is_active boolean, updated_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$

DECLARE v_tier_weight INT;

BEGIN

  IF NOT EXISTS (SELECT 1 FROM nft_traits WHERE nft_traits.id = p_id) THEN

    RAISE EXCEPTION 'Trait not found' USING ERRCODE = 'P0002';

  END IF;

  IF p_rarity_weight IS NOT NULL AND p_rarity_weight <= 0 THEN

    RAISE EXCEPTION 'rarity_weight must be > 0 — use is_active=false to disable a trait' USING ERRCODE = 'P0001';

  END IF;



  IF p_rarity_tier IS NOT NULL THEN

    v_tier_weight := CASE lower(p_rarity_tier)

      WHEN 'legendary' THEN 3

      WHEN 'epic'      THEN 10

      WHEN 'rare'      THEN 30

      WHEN 'common'    THEN 100

      ELSE 100

    END;

  END IF;



  RETURN QUERY

  UPDATE nft_traits SET

    name             = COALESCE(NULLIF(trim(p_name), ''),      nft_traits.name),

    file_path        = COALESCE(NULLIF(trim(p_file_path), ''), nft_traits.file_path),

    storage_provider = COALESCE(p_storage_provider,            nft_traits.storage_provider),

    rarity_tier      = COALESCE(lower(p_rarity_tier),          nft_traits.rarity_tier),

    rarity_weight     = COALESCE(p_rarity_weight, v_tier_weight, nft_traits.rarity_weight),

    is_active        = COALESCE(p_is_active,                   nft_traits.is_active),

    updated_at       = NOW()

  WHERE nft_traits.id = p_id

  RETURNING nft_traits.id, nft_traits.name, nft_traits.rarity_weight, nft_traits.rarity_tier, nft_traits.is_active, nft_traits.updated_at;

END;

$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_traits_create_bulk(p_layer_id uuid, p_traits jsonb)
 RETURNS TABLE(id uuid, name character varying, rarity_weight integer, rarity_tier character varying, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM nft_layers WHERE nft_layers.id = p_layer_id) THEN
        RAISE EXCEPTION 'Layer not found' USING ERRCODE = 'P0002';
      END IF;

      RETURN QUERY
      INSERT INTO nft_traits (layer_id, name, file_path, storage_provider, rarity_weight, rarity_tier)
      SELECT
        p_layer_id,
        trim(t.name),
        trim(t.file_path),
        COALESCE(t.storage_provider, 'filebase'),
        COALESCE(t.rarity_weight, CASE COALESCE(lower(t.rarity_tier), 'common')
          WHEN 'legendary' THEN 3
          WHEN 'epic'      THEN 10
          WHEN 'rare'      THEN 30
          WHEN 'common'    THEN 100
          ELSE 100
        END),
        COALESCE(lower(t.rarity_tier), 'common')
      FROM jsonb_to_recordset(p_traits) AS t(name text, file_path text, rarity_tier text, storage_provider text, rarity_weight int)
      ON CONFLICT ON CONSTRAINT uq_nft_traits_layer_filepath DO UPDATE SET
        storage_provider = EXCLUDED.storage_provider,
        is_active        = TRUE,
        updated_at       = NOW()
      RETURNING nft_traits.id, nft_traits.name, nft_traits.rarity_weight, nft_traits.rarity_tier, nft_traits.created_at;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_traits_list(p_layer_id uuid)
 RETURNS TABLE(id uuid, layer_id uuid, name character varying, file_path text, storage_provider character varying, rarity_weight integer, rarity_tier character varying, is_active boolean, rarity_pct numeric, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE v_total_weight BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_layers WHERE nft_layers.id = p_layer_id) THEN
    RAISE EXCEPTION 'Layer not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(SUM(t.rarity_weight), 0) INTO v_total_weight
  FROM nft_traits t WHERE t.layer_id = p_layer_id AND t.is_active = TRUE;
  RETURN QUERY
  SELECT
    nt.id, nt.layer_id, nt.name, nt.file_path, nt.storage_provider,
    nt.rarity_weight, nt.rarity_tier, nt.is_active,
    CASE WHEN v_total_weight > 0
      THEN ROUND(nt.rarity_weight::NUMERIC / v_total_weight * 100, 2)
      ELSE 0::NUMERIC
    END AS rarity_pct,
    nt.created_at
  FROM nft_traits nt
  WHERE nt.layer_id = p_layer_id
  ORDER BY nt.rarity_weight DESC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_traits_reconcile(p_layer_id uuid, p_active_paths text[])
 RETURNS integer
 LANGUAGE plpgsql
AS $function$

DECLARE v_count INT;

BEGIN

  DELETE FROM nft_traits

  WHERE layer_id = p_layer_id

    AND file_path <> ALL(p_active_paths);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;

END;

$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_upload_batch_complete(p_id uuid)
 RETURNS TABLE(ok boolean)
 LANGUAGE sql
AS $function$
  UPDATE nft_upload_batches
  SET status = 'complete',
      uploaded_items = total_items,
      completed_at   = NOW(),
      updated_at     = NOW()
  WHERE id = p_id;
  SELECT TRUE;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_upload_batch_create(p_job_id uuid, p_provider character varying, p_batch_type character varying, p_total_items integer)
 RETURNS TABLE(id uuid, status character varying, total_items integer, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_generation_jobs WHERE nft_generation_jobs.id = p_job_id AND nft_generation_jobs.status = 'complete') THEN
    RAISE EXCEPTION 'Can only upload after generation is complete' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  INSERT INTO nft_upload_batches (job_id, provider, batch_type, total_items)
  VALUES (p_job_id, p_provider, p_batch_type, p_total_items)
  RETURNING nft_upload_batches.id, nft_upload_batches.status, nft_upload_batches.total_items, nft_upload_batches.created_at;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_upload_batch_fail(p_id uuid, p_error_message text)
 RETURNS TABLE(ok boolean)
 LANGUAGE sql
AS $function$
  UPDATE nft_upload_batches
  SET status = 'failed', error_message = p_error_message, completed_at = NOW(), updated_at = NOW()
  WHERE id = p_id;
  SELECT TRUE;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_upload_batch_get(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE v_result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nft_upload_batches WHERE id = p_id) THEN
    RAISE EXCEPTION 'Upload batch not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT json_build_object(
    'id',            ub.id,
    'jobId',         ub.job_id,
    'provider',      ub.provider,
    'batchType',     ub.batch_type,
    'status',        ub.status,
    'totalItems',    ub.total_items,
    'uploadedItems', ub.uploaded_items,
    'errorMessage',  ub.error_message,
    'startedAt',     ub.started_at,
    'completedAt',   ub.completed_at,
    'createdAt',     ub.created_at
  ) INTO v_result FROM nft_upload_batches ub WHERE ub.id = p_id;
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_upload_batch_progress(p_id uuid, p_uploaded_items integer)
 RETURNS TABLE(ok boolean)
 LANGUAGE sql
AS $function$
  UPDATE nft_upload_batches SET uploaded_items = p_uploaded_items, updated_at = NOW() WHERE id = p_id;
  SELECT TRUE;
$function$
;

CREATE OR REPLACE FUNCTION public.nft_gen_upload_batch_start(p_id uuid)
 RETURNS TABLE(ok boolean)
 LANGUAGE sql
AS $function$
  UPDATE nft_upload_batches SET status = 'processing', started_at = NOW(), updated_at = NOW() WHERE id = p_id;
  SELECT TRUE;
$function$
;

CREATE OR REPLACE FUNCTION public.users_get_by_email(p_email text)
 RETURNS TABLE(id uuid, email character varying, name character varying, role_code character varying, password_hash text, is_active boolean)
 LANGUAGE sql
AS $function$
  SELECT u.id, u.email,
         u.first_name || ' ' || u.last_name AS name,
         r.code AS role_code, u.password_hash, u.is_active
  FROM users u
  LEFT JOIN roles r ON u.role_id = r.id
  WHERE u.email = p_email;
$function$
;

-- ============================================================
-- SEED DATA
-- ============================================================

-- Roles (same UUIDs as live BearthDev — admin home_url changed to /dashboard for V1)
INSERT INTO roles (id, code, name, description, is_active, home_url) VALUES
  ('3d658c1b-2930-4873-a4d1-119d4970ea5c', 'admin',          'Bearth Admin',          'Full access — manage all data, users, and permissions',                                     TRUE, '/dashboard'),
  ('a5d221d3-622d-45a2-98f2-3b9aa7f4f32f', 'customer',       'Bearth Customer',       'Read-only access to own orders and NFTs',                                                   TRUE, NULL),
  ('65262ab0-8da1-42b7-b525-de38c54268d9', 'ext_referrer',   'Bearth Ext-Referrer',   NULL,                                                                                        TRUE, '/dashboard'),
  ('03b48ae7-afbe-4bf6-88cf-26ffe61bf90d', 'operation',      'Bearth Operation',      'Manage orders, NFTs, customers, and reconciliation',                                        TRUE, '/dashboard'),
  ('8c9100a2-f042-499f-b595-448e30a01b86', 'sales_team',     'Bearth Sales Team',     NULL,                                                                                        TRUE, '/dashboard'),
  ('ef13b0ba-480f-4b06-8cb0-8695140b4b63', 'technical_team', 'Bearth Technical Team', 'Manage NFT records, products, and reports — no access to orders, customers, or financials', TRUE, '/dashboard')
ON CONFLICT (id) DO NOTHING;

-- Permissions (V1 scope: dashboard.view + all nft_gen.*)
INSERT INTO permissions (id, key, label, module, description, sort_order) VALUES
  ('fa7d9fb7-d1bb-42f7-9a7d-07e3c2eade70', 'dashboard.view',             'View Dashboard',         'dashboard', NULL, 1),
  ('0d5602aa-4e29-4347-a65e-aae94c36cca3', 'nft_gen.view',               'View NFT Generator',     'nft_gen',   NULL, 90),
  ('c4a8dfa6-299c-4b52-87cb-3843187c4f71', 'nft_gen.manage_collections', 'Manage Collections',     'nft_gen',   NULL, 91),
  ('45baea17-4476-442c-beb7-d648a7448e58', 'nft_gen.manage_layers',      'Manage Layers & Traits', 'nft_gen',   NULL, 92),
  ('77dedb96-97d4-4e9b-b915-bb5d337e560e', 'nft_gen.generate',           'Trigger Generation Job', 'nft_gen',   NULL, 93),
  ('fd223ff9-f045-4b12-94fa-162e7d748906', 'nft_gen.upload_ipfs',        'Upload to IPFS',         'nft_gen',   NULL, 94)
ON CONFLICT (id) DO NOTHING;

-- Menus (V1: all 4 RBAC menus set is_active=TRUE; Dashboard + NFT Studio already TRUE)
INSERT INTO menus (id, label, href, icon, module, sort_order, is_active, module_label) VALUES
  ('6ee66bdf-b3a7-47c8-b1e8-04040ddc5c3f', 'Dashboard',    '/dashboard',           'grid',       'dashboard',  10, TRUE,  'Overview'),
  ('5090e253-97f2-4004-ab93-9495aad748d0', 'NFT Studio',   '/dashboard/generator', 'cpu',        'nft_manage', 50, TRUE,  'NFT Management'),
  ('5e25a286-923e-41c1-b000-c1be82e7c835', 'Roles',        '/admin/roles',         'shield',     'admin',      10, TRUE,  'System'),
  ('f3b0681c-c0eb-49c5-b5f4-c3c9ab3916c8', 'Permissions',  '/admin/permissions',   'key',        'admin',      20, TRUE,  'System'),
  ('ff6a32b9-ce4a-40f8-8aec-26785042bef4', 'Menu Manager', '/admin/menus',         'menu',       'admin',      30, TRUE,  'System'),
  ('c795cbe7-b64c-449d-b894-021a3dadca00', 'Admin Users',  '/admin/users',         'user-check', 'admin',      40, TRUE,  'System')
ON CONFLICT (id) DO NOTHING;

-- role_permissions (exact from live DB, scoped to V1 permissions only)
INSERT INTO role_permissions (id, role_id, permission_id, is_granted) VALUES
  -- operation: dashboard.view
  ('25feec08-7026-43eb-b9ac-d6ac789a7681', '03b48ae7-afbe-4bf6-88cf-26ffe61bf90d', 'fa7d9fb7-d1bb-42f7-9a7d-07e3c2eade70', TRUE),
  -- admin: nft_gen.view + dashboard.view
  ('7e0ed013-1885-43db-9bb2-df6ab5983765', '3d658c1b-2930-4873-a4d1-119d4970ea5c', '0d5602aa-4e29-4347-a65e-aae94c36cca3', TRUE),
  ('96212ff9-71ee-4e7a-9e1c-42232b425d78', '3d658c1b-2930-4873-a4d1-119d4970ea5c', 'fa7d9fb7-d1bb-42f7-9a7d-07e3c2eade70', TRUE),
  -- ext_referrer: dashboard.view
  ('7b3d9e03-42c2-4e9a-8ff7-29faa02c0e7f', '65262ab0-8da1-42b7-b525-de38c54268d9', 'fa7d9fb7-d1bb-42f7-9a7d-07e3c2eade70', TRUE),
  -- sales_team: dashboard.view
  ('e6273053-d2f0-4bdc-a9e6-765eaa2dbd42', '8c9100a2-f042-499f-b595-448e30a01b86', 'fa7d9fb7-d1bb-42f7-9a7d-07e3c2eade70', TRUE),
  -- customer: dashboard.view
  ('993d5854-7a84-4976-8d5e-92f85dfcc682', 'a5d221d3-622d-45a2-98f2-3b9aa7f4f32f', 'fa7d9fb7-d1bb-42f7-9a7d-07e3c2eade70', TRUE),
  -- technical_team: all nft_gen.* + dashboard.view
  ('5dbbd94e-7998-4ba2-88d7-4449fa59350c', 'ef13b0ba-480f-4b06-8cb0-8695140b4b63', '0d5602aa-4e29-4347-a65e-aae94c36cca3', TRUE),
  ('cc3ce984-4c15-4432-9b8f-cd5b216fc379', 'ef13b0ba-480f-4b06-8cb0-8695140b4b63', '45baea17-4476-442c-beb7-d648a7448e58', TRUE),
  ('4d7e2a9c-f253-4e27-9c97-2519334ae784', 'ef13b0ba-480f-4b06-8cb0-8695140b4b63', '77dedb96-97d4-4e9b-b915-bb5d337e560e', TRUE),
  ('a636aff1-3648-409b-8b82-34beec08e80c', 'ef13b0ba-480f-4b06-8cb0-8695140b4b63', 'c4a8dfa6-299c-4b52-87cb-3843187c4f71', TRUE),
  ('19a6a045-7675-4fef-a8b4-beff089592ea', 'ef13b0ba-480f-4b06-8cb0-8695140b4b63', 'fa7d9fb7-d1bb-42f7-9a7d-07e3c2eade70', TRUE),
  ('3cc0b59d-0c28-464f-a9e1-aa96ebed1052', 'ef13b0ba-480f-4b06-8cb0-8695140b4b63', 'fd223ff9-f045-4b12-94fa-162e7d748906', TRUE)
ON CONFLICT (id) DO NOTHING;

-- role_menus (exact from live DB)
-- admin: 4 RBAC menus
-- technical_team: Dashboard + NFT Studio + 4 RBAC menus
INSERT INTO role_menus (role_id, menu_id, sort_order) VALUES
  ('3d658c1b-2930-4873-a4d1-119d4970ea5c', '5e25a286-923e-41c1-b000-c1be82e7c835', 10),
  ('3d658c1b-2930-4873-a4d1-119d4970ea5c', 'f3b0681c-c0eb-49c5-b5f4-c3c9ab3916c8', 20),
  ('3d658c1b-2930-4873-a4d1-119d4970ea5c', 'ff6a32b9-ce4a-40f8-8aec-26785042bef4', 30),
  ('3d658c1b-2930-4873-a4d1-119d4970ea5c', 'c795cbe7-b64c-449d-b894-021a3dadca00', 40),
  ('ef13b0ba-480f-4b06-8cb0-8695140b4b63', '6ee66bdf-b3a7-47c8-b1e8-04040ddc5c3f', 0),
  ('ef13b0ba-480f-4b06-8cb0-8695140b4b63', '5090e253-97f2-4004-ab93-9495aad748d0', 4),
  ('ef13b0ba-480f-4b06-8cb0-8695140b4b63', '5e25a286-923e-41c1-b000-c1be82e7c835', 7),
  ('ef13b0ba-480f-4b06-8cb0-8695140b4b63', 'f3b0681c-c0eb-49c5-b5f4-c3c9ab3916c8', 8),
  ('ef13b0ba-480f-4b06-8cb0-8695140b4b63', 'ff6a32b9-ce4a-40f8-8aec-26785042bef4', 9),
  ('ef13b0ba-480f-4b06-8cb0-8695140b4b63', 'c795cbe7-b64c-449d-b894-021a3dadca00', 10)
ON CONFLICT DO NOTHING;
