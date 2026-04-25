-- Aquifer base schema
-- Usage: replace ${schema} with actual schema name (e.g., 'aquifer')

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Chinese text search: prefer pg_jieba (dict.txt.big Traditional-aware, proper
-- word segmentation via jiebaqry search-engine mode that expands compounds into
-- multi-granularity tokens). Fall back to zhparser if jieba not installed; else
-- migration silently uses the simple tokenizer (trigram primary path unaffected).
-- Extension install errors (missing .so, non-superuser, OOM, etc.) are caught
-- per-extension so one failure doesn't prevent the other from being tried.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_jieba;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[aquifer] pg_jieba install skipped (%); trying zhparser', SQLERRM;
  END;
  BEGIN
    CREATE EXTENSION IF NOT EXISTS zhparser;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[aquifer] zhparser install skipped (%); Chinese FTS will use simple tokenizer', SQLERRM;
  END;
END$$;

-- Build/upgrade zhcfg in the public namespace (where Aquifer consumers resolve
-- `to_tsvector('zhcfg', ...)` from). State machine:
--   S1: jieba present, no zhcfg in public           -> CREATE zhcfg (COPY = jiebaqry)
--   S2: jieba absent, zhparser present, no zhcfg    -> CREATE zhcfg zhparser + simple mapping
--   S3: jieba present, zhcfg backed by zhparser     -> DROP + CREATE (COPY = jiebaqry)
--   S4: zhcfg already jieba-backed                  -> noop
--   S9: no backing extension but zhcfg still there  -> rebuild against best available, or drop
--
-- zhcfg is a database-wide object; acquire a transaction-scoped global advisory
-- lock so concurrent migrate() calls on different Aquifer schemas in the same
-- database don't race on the DROP/CREATE. The lock auto-releases at COMMIT.
-- Key: hash of 'aquifer:zhcfg' truncated to PG advisory-lock int4 range.
--
-- Queries restrict to the public namespace to avoid ambiguity if operators have
-- created same-named text search configs elsewhere.
DO $$
DECLARE
  have_jieba boolean := EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_jieba');
  have_zhparser boolean := EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'zhparser');
  public_oid oid := (SELECT oid FROM pg_namespace WHERE nspname = 'public');
  zhcfg_parser text := NULL;
BEGIN
  PERFORM pg_advisory_xact_lock(1434531247);  -- stable global key

  IF public_oid IS NOT NULL THEN
    SELECT p.prsname INTO zhcfg_parser
    FROM pg_ts_config c JOIN pg_ts_parser p ON c.cfgparser = p.oid
    WHERE c.cfgname = 'zhcfg' AND c.cfgnamespace = public_oid
    LIMIT 1;
  END IF;

  BEGIN
    IF have_jieba AND (zhcfg_parser IS NULL OR zhcfg_parser = 'zhparser') THEN
      -- S1 / S3: promote to jieba
      IF zhcfg_parser = 'zhparser' THEN
        EXECUTE 'DROP TEXT SEARCH CONFIGURATION public.zhcfg';
      END IF;
      EXECUTE 'CREATE TEXT SEARCH CONFIGURATION public.zhcfg ( COPY = public.jiebaqry )';

    ELSIF have_zhparser AND zhcfg_parser IS NULL THEN
      -- S2: zhparser-only new install.  `eng` covers English tokens that zhparser
      -- emits for Latin words in mixed-language text; without it they'd be dropped.
      EXECUTE 'CREATE TEXT SEARCH CONFIGURATION public.zhcfg (PARSER = zhparser)';
      EXECUTE 'ALTER TEXT SEARCH CONFIGURATION public.zhcfg
        ADD MAPPING FOR n,v,a,i,e,l,j,nr,ns,nt,nz,vd,vn,m,r,t,c,p,u,d,o,y,w,x,q,b,k,s,f,h,g,eng WITH simple';

    ELSIF NOT have_jieba AND NOT have_zhparser AND zhcfg_parser IS NOT NULL THEN
      -- S9: backing extension dropped but zhcfg stayed; any `to_tsvector('zhcfg',...)`
      -- would throw "parser does not exist" and break the FTS trigger.
      -- Safer to remove zhcfg and let consumers fall back to 'simple'.
      EXECUTE 'DROP TEXT SEARCH CONFIGURATION public.zhcfg';
      RAISE WARNING '[aquifer] zhcfg removed: neither pg_jieba nor zhparser is installed; Chinese FTS falls back to simple';

    ELSIF NOT have_jieba AND have_zhparser AND zhcfg_parser NOT IN ('zhparser') THEN
      -- S9 partial: jieba gone but zhparser available; rebuild on zhparser.
      EXECUTE 'DROP TEXT SEARCH CONFIGURATION public.zhcfg';
      EXECUTE 'CREATE TEXT SEARCH CONFIGURATION public.zhcfg (PARSER = zhparser)';
      EXECUTE 'ALTER TEXT SEARCH CONFIGURATION public.zhcfg
        ADD MAPPING FOR n,v,a,i,e,l,j,nr,ns,nt,nz,vd,vn,m,r,t,c,p,u,d,o,y,w,x,q,b,k,s,f,h,g,eng WITH simple';
      RAISE WARNING '[aquifer] zhcfg rebuilt on zhparser: pg_jieba no longer installed';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Ownership mismatch, concurrent-modify race, dependency blocking DROP, etc.
    -- Don't abort the entire migrate(); leave zhcfg as-is and warn.
    RAISE WARNING '[aquifer] zhcfg (re)build skipped (%); existing config left untouched', SQLERRM;
  END;
END$$;

CREATE SCHEMA IF NOT EXISTS ${schema};

-- =========================================================================
-- Sessions: raw conversation data
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.sessions (
  id                 BIGSERIAL    PRIMARY KEY,
  tenant_id          TEXT         NOT NULL DEFAULT 'default',
  session_id         TEXT         NOT NULL,
  session_key        TEXT,
  agent_id           TEXT         NOT NULL DEFAULT 'main',
  source             TEXT         NOT NULL DEFAULT 'api',
  messages           JSONB,
  msg_count          INT          NOT NULL DEFAULT 0,
  user_count         INT          NOT NULL DEFAULT 0,
  assistant_count    INT          NOT NULL DEFAULT 0,
  model              TEXT,
  tokens_in          INT          NOT NULL DEFAULT 0,
  tokens_out         INT          NOT NULL DEFAULT 0,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  last_message_at    TIMESTAMPTZ,
  processing_status    TEXT         NOT NULL DEFAULT 'pending',
  processing_started_at TIMESTAMPTZ,
  processed_at         TIMESTAMPTZ,
  processing_error     TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_tenant_agent
  ON ${schema}.sessions (tenant_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at
  ON ${schema}.sessions (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_processing_status
  ON ${schema}.sessions (processing_status)
  WHERE processing_status IN ('pending', 'processing');

-- =========================================================================
-- Session summaries: LLM-generated or extractive summaries
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.session_summaries (
  session_row_id           BIGINT       PRIMARY KEY REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
  tenant_id                TEXT         NOT NULL DEFAULT 'default',
  agent_id                 TEXT,
  session_id               TEXT,
  summary_version          INT          NOT NULL DEFAULT 1,
  model                    TEXT,
  source_hash              TEXT,
  message_count            INT          NOT NULL DEFAULT 0,
  user_message_count       INT          NOT NULL DEFAULT 0,
  assistant_message_count  INT          NOT NULL DEFAULT 0,
  started_at               TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  summary_text             TEXT,
  structured_summary       JSONB        NOT NULL DEFAULT '{}',
  -- Sized so HNSW can build at migrate time; 1024 matches ollama bge-m3 default.
  -- Coerce DO block below upgrades pre-1.5.2 unsized columns.
  embedding                vector(1024),
  search_tsv               TSVECTOR,
  search_text              TEXT,
  access_count             INT          NOT NULL DEFAULT 0,
  last_accessed_at         TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE ${schema}.session_summaries
  ALTER COLUMN model DROP NOT NULL;

-- Cleanup legacy segment-era schema artifacts so migrate() converges old installs.
-- Wrapped because the implicit sequence on session_segments can be referenced from
-- other schemas (e.g. bench/staging created via CREATE TABLE LIKE), which would
-- otherwise hard-fail the migration. Operators get a NOTICE and must decouple
-- dependents themselves before the table will actually drop.
DO $$
BEGIN
  BEGIN
    DROP TABLE IF EXISTS ${schema}.session_segments;
  EXCEPTION
    WHEN dependent_objects_still_exist THEN
      RAISE NOTICE '[aquifer] skipped session_segments drop: %; decouple cross-schema dependents and re-run migrate to complete cleanup', SQLERRM;
  END;
END$$;
ALTER TABLE ${schema}.session_summaries DROP COLUMN IF EXISTS boundary_count;
ALTER TABLE ${schema}.session_summaries DROP COLUMN IF EXISTS fresh_tail_count;

CREATE INDEX IF NOT EXISTS idx_summaries_tenant
  ON ${schema}.session_summaries (tenant_id);

CREATE INDEX IF NOT EXISTS idx_summaries_search_tsv
  ON ${schema}.session_summaries USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS idx_summaries_search_text_trgm
  ON ${schema}.session_summaries USING GIN (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_summaries_embedding
  ON ${schema}.session_summaries (session_row_id)
  WHERE embedding IS NOT NULL;

-- Coerce pre-1.5.2 unsized `vector` column to sized so HNSW can be built.
-- pgvector requires a dim on the COLUMN, not just the data. Dim priority:
-- existing row dim > `aquifer.embedding_dim` GUC > 1024 default.
DO $$
DECLARE
  is_unsized BOOLEAN;
  existing_dim INT;
  target_dim INT;
BEGIN
  SELECT format_type(atttypid, atttypmod) = 'vector'
    INTO is_unsized
    FROM pg_attribute
    WHERE attrelid = '${schema}.session_summaries'::regclass
      AND attname = 'embedding';

  IF is_unsized THEN
    EXECUTE 'SELECT vector_dims(embedding) FROM ${schema}.session_summaries WHERE embedding IS NOT NULL LIMIT 1'
      INTO existing_dim;
    target_dim := COALESCE(
      existing_dim,
      NULLIF(current_setting('aquifer.embedding_dim', true), '')::int,
      1024
    );
    EXECUTE 'ALTER TABLE ${schema}.session_summaries ALTER COLUMN embedding TYPE vector('
         || target_dim::text
         || ') USING embedding::vector('
         || target_dim::text
         || ')';
    RAISE NOTICE '[aquifer] session_summaries.embedding coerced from unsized vector to vector(%)', target_dim;
  END IF;
END$$;

-- HNSW approximate nearest-neighbor index for cosine-distance vector search.
-- Column is sized via CREATE TABLE or the coerce block above, so the index
-- builds on fresh installs too. Safety-net EXCEPTION handlers stay for the
-- genuine recoverable failures; invalid_parameter_value is intentionally
-- NOT caught — it used to mask the unsized-column schema bug.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_summaries_embedding_hnsw ON ${schema}.session_summaries USING hnsw (embedding vector_cosine_ops)';
  EXCEPTION
    WHEN feature_not_supported THEN
      RAISE NOTICE '[aquifer] HNSW not available on this pgvector; upgrade to >= 0.5.0 for index-accelerated vector search';
    WHEN out_of_memory THEN
      RAISE WARNING '[aquifer] HNSW build on session_summaries.embedding ran out of memory; raise maintenance_work_mem and re-run migrate()';
    WHEN program_limit_exceeded THEN
      RAISE WARNING '[aquifer] HNSW build on session_summaries.embedding exceeded an internal limit; inspect pgvector logs';
  END;
END$$;

-- FTS trigger: auto-update search_tsv on INSERT/UPDATE
CREATE OR REPLACE FUNCTION ${schema}.session_summaries_search_tsv_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ss jsonb;
  title_text text;
  overview_text text;
  topics_text text;
  decisions_text text;
  open_loops_text text;
  facts_text text;
BEGIN
  ss := COALESCE(NEW.structured_summary, '{}'::jsonb);

  title_text := COALESCE(ss->>'title', '');
  overview_text := COALESCE(ss->>'overview', '');

  SELECT COALESCE(string_agg(elem->>'name' || ' ' || COALESCE(elem->>'summary', ''), ' '), '')
  INTO topics_text
  FROM jsonb_array_elements(COALESCE(ss->'topics', '[]'::jsonb)) AS elem;

  SELECT COALESCE(string_agg(elem->>'decision' || ' ' || COALESCE(elem->>'reason', ''), ' '), '')
  INTO decisions_text
  FROM jsonb_array_elements(COALESCE(ss->'decisions', '[]'::jsonb)) AS elem;

  SELECT COALESCE(string_agg(elem->>'item', ' '), '')
  INTO open_loops_text
  FROM jsonb_array_elements(COALESCE(ss->'open_loops', '[]'::jsonb)) AS elem;

  SELECT COALESCE(string_agg(elem#>>'{}', ' '), '')
  INTO facts_text
  FROM jsonb_array_elements(COALESCE(ss->'important_facts', '[]'::jsonb)) AS elem;

  -- Use zhcfg if available (Chinese segmentation — pg_jieba jiebaqry on new
  -- installs, zhparser as legacy fallback; zhcfg name is a stable indirection
  -- managed by the DO block above). Else fall back to simple tokenizer.
  -- The per-row IF EXISTS lookup hits a tiny fully-cached system catalog
  -- (pg_ts_config, ~12 rows) — effectively free. Chose this over migrate-time
  -- codegen because installing pg_jieba POST-install immediately benefits new
  -- inserts without requiring a manual re-migrate.
  IF EXISTS (SELECT 1 FROM pg_ts_config
             WHERE cfgname = 'zhcfg'
               AND cfgnamespace = 'public'::regnamespace) THEN
    NEW.search_tsv :=
      setweight(to_tsvector('zhcfg', title_text), 'A') ||
      setweight(to_tsvector('zhcfg', overview_text || ' ' || topics_text || ' ' || decisions_text), 'B') ||
      setweight(to_tsvector('zhcfg', COALESCE(NEW.summary_text, '')), 'C') ||
      setweight(to_tsvector('zhcfg', open_loops_text || ' ' || facts_text), 'D');
  ELSE
    NEW.search_tsv :=
      setweight(to_tsvector('simple', title_text), 'A') ||
      setweight(to_tsvector('simple', overview_text || ' ' || topics_text || ' ' || decisions_text), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.summary_text, '')), 'C') ||
      setweight(to_tsvector('simple', open_loops_text || ' ' || facts_text), 'D');
  END IF;

  NEW.search_text :=
    title_text || ' ' || overview_text || ' ' || topics_text || ' ' ||
    decisions_text || ' ' || COALESCE(NEW.summary_text, '') || ' ' ||
    open_loops_text || ' ' || facts_text;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_session_summaries_search_tsv
  ON ${schema}.session_summaries;

-- Trigger fires on input-column changes only. search_text is a trigger output
-- (derived from structured_summary + summary_text) and listing it here was
-- redundant — PG's BEFORE semantics already prevent the assignment inside the
-- trigger body from re-firing the trigger.
CREATE TRIGGER trg_session_summaries_search_tsv
  BEFORE INSERT OR UPDATE OF summary_text, structured_summary
  ON ${schema}.session_summaries
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.session_summaries_search_tsv_update();

-- =========================================================================
-- Turn embeddings: per-user-turn vector embeddings
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.turn_embeddings (
  id               BIGSERIAL    PRIMARY KEY,
  session_row_id   BIGINT       NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
  tenant_id        TEXT         NOT NULL DEFAULT 'default',
  session_id       TEXT         NOT NULL,
  agent_id         TEXT         NOT NULL,
  source           TEXT,
  turn_index       INT          NOT NULL,
  message_index    INT          NOT NULL,
  role             TEXT         NOT NULL DEFAULT 'user' CHECK (role = 'user'),
  content_text     TEXT         NOT NULL,
  content_hash     TEXT         NOT NULL,
  -- Sized so HNSW can build at migrate time. Coerce DO block below upgrades
  -- pre-1.5.2 unsized columns.
  embedding        vector(1024) NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (session_row_id, message_index)
);

CREATE INDEX IF NOT EXISTS idx_turn_emb_session_row
  ON ${schema}.turn_embeddings (session_row_id);

CREATE INDEX IF NOT EXISTS idx_turn_emb_tenant_agent
  ON ${schema}.turn_embeddings (tenant_id, agent_id, source);

-- Coerce pre-1.5.2 unsized `vector` column for turn_embeddings.
-- NOT NULL so every row has a dim; existing_dim should always resolve.
DO $$
DECLARE
  is_unsized BOOLEAN;
  existing_dim INT;
  target_dim INT;
BEGIN
  SELECT format_type(atttypid, atttypmod) = 'vector'
    INTO is_unsized
    FROM pg_attribute
    WHERE attrelid = '${schema}.turn_embeddings'::regclass
      AND attname = 'embedding';

  IF is_unsized THEN
    EXECUTE 'SELECT vector_dims(embedding) FROM ${schema}.turn_embeddings WHERE embedding IS NOT NULL LIMIT 1'
      INTO existing_dim;
    target_dim := COALESCE(
      existing_dim,
      NULLIF(current_setting('aquifer.embedding_dim', true), '')::int,
      1024
    );
    EXECUTE 'ALTER TABLE ${schema}.turn_embeddings ALTER COLUMN embedding TYPE vector('
         || target_dim::text
         || ') USING embedding::vector('
         || target_dim::text
         || ')';
    RAISE NOTICE '[aquifer] turn_embeddings.embedding coerced from unsized vector to vector(%)', target_dim;
  END IF;
END$$;

-- HNSW approximate nearest-neighbor index for turn-level vector search.
-- See notes on session_summaries.embedding HNSW above. invalid_parameter_value
-- intentionally NOT caught — it used to mask the unsized-column schema bug.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_turn_emb_embedding_hnsw ON ${schema}.turn_embeddings USING hnsw (embedding vector_cosine_ops)';
  EXCEPTION
    WHEN feature_not_supported THEN
      RAISE NOTICE '[aquifer] HNSW not available on this pgvector; upgrade to >= 0.5.0 for index-accelerated vector search';
    WHEN out_of_memory THEN
      RAISE WARNING '[aquifer] HNSW build on turn_embeddings.embedding ran out of memory; raise maintenance_work_mem and re-run migrate()';
    WHEN program_limit_exceeded THEN
      RAISE WARNING '[aquifer] HNSW build on turn_embeddings.embedding exceeded an internal limit; inspect pgvector logs';
  END;
END$$;
