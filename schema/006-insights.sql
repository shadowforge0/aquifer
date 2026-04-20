-- insights: higher-order reflection from session content (Q4).
--
-- Holds preferences, recurring patterns, frustrations, and successful
-- workflows distilled from session_summaries over a window. Vector-indexed
-- for natural-language recall via aquifer.recallInsights().
--
-- DROP-clean: no triggers/functions, no FK from anywhere else into this table.
-- See scripts/drop-insights.sql.

CREATE TABLE IF NOT EXISTS ${schema}.insights (
  id                  BIGSERIAL    PRIMARY KEY,
  tenant_id           TEXT         NOT NULL DEFAULT 'default',
  agent_id            TEXT         NOT NULL,
  insight_type        TEXT         NOT NULL
    CHECK (insight_type IN ('preference', 'pattern', 'frustration', 'workflow')),
  title               TEXT         NOT NULL CHECK (btrim(title) <> ''),
  body                TEXT         NOT NULL CHECK (btrim(body) <> ''),
  source_session_ids  TEXT[]       NOT NULL DEFAULT '{}',
  evidence_window     TSTZRANGE    NOT NULL,
  -- embedding: sized vector so HNSW can be built at migrate time. 1024 matches
  -- the autodetect default (ollama bge-m3). Operators using a provider with
  -- different dimensions (e.g. openai text-embedding-3-small = 1536) should
  -- set `aquifer.embedding_dim` via GUC before running migrate(), or the
  -- coerce block below will pick it up.
  embedding           vector(1024),
  importance          REAL         NOT NULL DEFAULT 0.5
    CHECK (importance >= 0 AND importance <= 1),
  status              TEXT         NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stale', 'superseded')),
  superseded_by       BIGINT       REFERENCES ${schema}.insights(id) ON DELETE SET NULL,
  idempotency_key     TEXT,
  metadata            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Phase 2 C1: canonical_key_v2 identifies the CLAIM (type + canonicalClaim +
-- entitySet). idempotency_key keeps its revision-level role. Old rows have
-- canonical_key_v2 = NULL and are not retrofitted; new writes populate it.
ALTER TABLE ${schema}.insights
  ADD COLUMN IF NOT EXISTS canonical_key_v2 TEXT;

-- Hot path: recall by agent + type, importance-ranked. Partial idx keeps
-- the index small by skipping stale/superseded rows.
CREATE INDEX IF NOT EXISTS idx_insights_active
  ON ${schema}.insights (tenant_id, agent_id, insight_type, importance DESC, created_at DESC)
  WHERE status = 'active';

-- Idempotency: caller-supplied key writes once. Partial allows NULL keys.
CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_idempotency
  ON ${schema}.insights (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Phase 2 C1: preflight lookup for canonical_key_v2 active row.
-- NOT unique — canonical identity can have multiple revisions (legacy as
-- 'superseded'); only the latest stays 'active'. Partial keeps index small.
CREATE INDEX IF NOT EXISTS idx_insights_canonical_v2_active
  ON ${schema}.insights (tenant_id, agent_id, insight_type, canonical_key_v2, created_at DESC)
  WHERE status = 'active' AND canonical_key_v2 IS NOT NULL;

-- Coerce pre-1.5.1 unsized `vector` column to a sized type so HNSW can be
-- built. Pre-1.5.1 declared `embedding vector` (no dim) which makes HNSW
-- creation permanently impossible — the "defer until first row" pattern
-- was a broken diagnosis of the real problem (pgvector needs a dim on the
-- COLUMN, not just the data). Idempotent: skipped if already sized.
-- Dim priority: existing row dim > `aquifer.embedding_dim` GUC > 1024 default.
-- Note: ${schema} is substituted to a quoted identifier by the loader, so
-- we string-concat rather than format(%I, ...) to avoid double-quoting.
DO $$
DECLARE
  is_unsized BOOLEAN;
  existing_dim INT;
  target_dim INT;
BEGIN
  SELECT format_type(atttypid, atttypmod) = 'vector'
    INTO is_unsized
    FROM pg_attribute
    WHERE attrelid = '${schema}.insights'::regclass
      AND attname = 'embedding';

  IF is_unsized THEN
    EXECUTE 'SELECT vector_dims(embedding) FROM ${schema}.insights WHERE embedding IS NOT NULL LIMIT 1'
      INTO existing_dim;
    target_dim := COALESCE(
      existing_dim,
      NULLIF(current_setting('aquifer.embedding_dim', true), '')::int,
      1024
    );
    EXECUTE 'ALTER TABLE ${schema}.insights ALTER COLUMN embedding TYPE vector('
         || target_dim::text
         || ') USING embedding::vector('
         || target_dim::text
         || ')';
    RAISE NOTICE '[aquifer] insights.embedding coerced from unsized vector to vector(%)', target_dim;
  END IF;
END$$;

-- Vector index: HNSW for cosine distance, only over active insights with
-- embeddings. Column is now sized so this builds on fresh installs too.
-- Defer / out-of-memory / unavailable handlers kept as safety nets.
DO $$
BEGIN
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_insights_embedding
    ON ${schema}.insights USING hnsw (embedding vector_cosine_ops)
    WHERE status = ''active'' AND embedding IS NOT NULL';
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE '[aquifer] pgvector hnsw operator not available; skipping HNSW index on insights';
  WHEN feature_not_supported THEN
    RAISE NOTICE '[aquifer] HNSW not available on this pgvector; upgrade to >= 0.5.0 for index-accelerated insights recall';
  WHEN out_of_memory THEN
    RAISE WARNING '[aquifer] HNSW build on insights.embedding ran out of memory; raise maintenance_work_mem and re-run migrate()';
  WHEN program_limit_exceeded THEN
    RAISE WARNING '[aquifer] HNSW build on insights.embedding exceeded an internal limit; inspect pgvector logs';
END$$;

-- Diagnostic: who-references-which-session, for audit / re-extraction.
CREATE INDEX IF NOT EXISTS idx_insights_source_sessions
  ON ${schema}.insights USING GIN (source_session_ids)
  WHERE status = 'active';

COMMENT ON TABLE ${schema}.insights IS
  'Higher-order observations distilled from sessions. NOT facts (use entity_state_history). NOT raw recap (use session_summaries). Reflection / skill memory.';

COMMENT ON COLUMN ${schema}.insights.insight_type IS
  'preference = stable user preference; pattern = recurring behaviour/decision; frustration = repeated pain point; workflow = reusable procedure that worked.';

COMMENT ON COLUMN ${schema}.insights.evidence_window IS
  'Time range of source sessions used to derive this insight. Half-open by convention.';

COMMENT ON COLUMN ${schema}.insights.importance IS
  'Caller-supplied [0,1]; recall ranking blends with semantic score and recency.';

COMMENT ON COLUMN ${schema}.insights.canonical_key_v2 IS
  'Phase 2 C1: stable claim identity = sha256(tenant|agent|type|normalizeCanonicalClaim(claim)|normalizeEntitySet(entities)). Survives LLM title drift. idempotency_key tracks revisions within a claim.';

COMMENT ON COLUMN ${schema}.insights.idempotency_key IS
  'Revision-level dedupe key. Default in writer: sha256(canonical_key_v2, normalized_body, sorted_session_ids, window). Same claim in same window with same body = duplicate; body change or window extend = new revision (old superseded).';
