-- Aquifer base schema
-- Usage: replace ${schema} with actual schema name (e.g., 'aquifer')

CREATE EXTENSION IF NOT EXISTS vector;
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
-- Session segments: conversation boundary metadata
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.session_segments (
  id                  BIGSERIAL    PRIMARY KEY,
  session_row_id      BIGINT       NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
  segment_no          INT          NOT NULL,
  start_msg_idx       INT,
  end_msg_idx         INT,
  started_at          TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  raw_msg_count       INT          NOT NULL DEFAULT 0,
  effective_msg_count INT          NOT NULL DEFAULT 0,
  boundary_type       TEXT,
  boundary_meta       JSONB        NOT NULL DEFAULT '{}',
  UNIQUE (session_row_id, segment_no)
);

CREATE INDEX IF NOT EXISTS idx_session_segments_row
  ON ${schema}.session_segments (session_row_id);

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
  boundary_count           INT          NOT NULL DEFAULT 0,
  fresh_tail_count         INT          NOT NULL DEFAULT 0,
  started_at               TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  summary_text             TEXT,
  structured_summary       JSONB        NOT NULL DEFAULT '{}',
  embedding                vector,
  search_tsv               TSVECTOR,
  access_count             INT          NOT NULL DEFAULT 0,
  last_accessed_at         TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_summaries_tenant
  ON ${schema}.session_summaries (tenant_id);

CREATE INDEX IF NOT EXISTS idx_summaries_search_tsv
  ON ${schema}.session_summaries USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS idx_summaries_embedding
  ON ${schema}.session_summaries (session_row_id)
  WHERE embedding IS NOT NULL;

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

  NEW.search_tsv :=
    setweight(to_tsvector('simple', title_text), 'A') ||
    setweight(to_tsvector('simple', overview_text || ' ' || topics_text || ' ' || decisions_text), 'B') ||
    setweight(to_tsvector('simple', COALESCE(NEW.summary_text, '')), 'C') ||
    setweight(to_tsvector('simple', open_loops_text || ' ' || facts_text), 'D');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_session_summaries_search_tsv
  ON ${schema}.session_summaries;

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
  embedding        vector       NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (session_row_id, message_index)
);

CREATE INDEX IF NOT EXISTS idx_turn_emb_session_row
  ON ${schema}.turn_embeddings (session_row_id);

CREATE INDEX IF NOT EXISTS idx_turn_emb_tenant_agent
  ON ${schema}.turn_embeddings (tenant_id, agent_id, source);
