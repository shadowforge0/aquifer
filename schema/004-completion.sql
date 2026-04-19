-- 004-completion.sql — cross-session completion schema (P1 foundation)
--
-- Adds the minimal DDL needed for the aquifer-completion capability surface:
--   * shared set_updated_at() trigger function (reused by narratives, consumer_profiles,
--     and future completion tables)
--   * sessions.consolidation_phases JSONB (per-phase state map; see consolidation
--     orchestration spec)
--   * narratives table — cross-session state snapshot with supersede chain
--   * consumer_profiles table — consumer schema registry with composite primary key
--     (tenant_id, consumer_id, version) for future multi-tenant safety
--
-- All identifiers stay parameterised on ${schema} so P4 schema rename
-- (miranda → aquifer) is a one-line config change rather than a DDL rewrite.

-- Ensure pg_trgm available (used by existing migrations; re-declared for independent
-- run safety).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Shared trigger: bump updated_at on row modification.
CREATE OR REPLACE FUNCTION ${schema}.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- sessions.consolidation_phases: per-phase state map keyed by phase name.
-- Shape (documented in spec, enforced at application layer):
--   {
--     "<phase>": {
--       "status": "pending|claimed|running|succeeded|failed|skipped",
--       "attempts": int,
--       "idempotencyKey": string?, "claimToken": string?, "workerId": string?,
--       "startedAt": iso?, "finishedAt": iso?, "retryAfter": iso?,
--       "errorCode": string?, "errorMessage": string?,
--       "outputRef": { ... }?
--     }
--   }
ALTER TABLE ${schema}.sessions
  ADD COLUMN IF NOT EXISTS consolidation_phases JSONB NOT NULL DEFAULT '{}'::jsonb;

-- narratives: cross-session state snapshots with scope-based addressing and
-- supersede chain. Only one 'active' row per (tenant, agent, scope, scope_key).
CREATE TABLE IF NOT EXISTS ${schema}.narratives (
  id                          BIGSERIAL    PRIMARY KEY,
  tenant_id                   TEXT         NOT NULL DEFAULT 'default',
  session_row_id              BIGINT       REFERENCES ${schema}.sessions(id) ON DELETE SET NULL,
  source_session_id           TEXT,
  agent_id                    TEXT         NOT NULL DEFAULT 'main',
  consumer_profile_id         TEXT         NOT NULL,
  consumer_profile_version    INT          NOT NULL,
  consumer_schema_hash        TEXT         NOT NULL,
  idempotency_key             TEXT         UNIQUE,
  scope                       TEXT         NOT NULL DEFAULT 'agent'
    CHECK (scope IN ('agent', 'workspace', 'project', 'custom')),
  scope_key                   TEXT         NOT NULL,
  text                        TEXT         NOT NULL,
  status                      TEXT         NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'superseded')),
  based_on_fact_ids           BIGINT[]     NOT NULL DEFAULT '{}',
  metadata                    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  superseded_by_narrative_id  BIGINT       REFERENCES ${schema}.narratives(id) ON DELETE SET NULL,
  effective_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  search_tsv                  TSVECTOR,
  search_text                 TEXT,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Only one active narrative per (tenant, agent, scope, scope_key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_narratives_active_scope
  ON ${schema}.narratives (tenant_id, agent_id, scope, scope_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_narratives_effective_at
  ON ${schema}.narratives (tenant_id, agent_id, effective_at DESC);

CREATE INDEX IF NOT EXISTS idx_narratives_search_tsv
  ON ${schema}.narratives USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS idx_narratives_search_text_trgm
  ON ${schema}.narratives USING GIN (search_text gin_trgm_ops);

CREATE OR REPLACE FUNCTION ${schema}.narratives_search_tsv_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text := COALESCE(NEW.text, '') || ' ' || COALESCE(NEW.metadata::text, '');
  NEW.search_tsv  := setweight(to_tsvector('simple', COALESCE(NEW.text, '')), 'A');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_narratives_search_tsv ON ${schema}.narratives;
CREATE TRIGGER trg_narratives_search_tsv
  BEFORE INSERT OR UPDATE OF text, metadata
  ON ${schema}.narratives
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.narratives_search_tsv_update();

DROP TRIGGER IF EXISTS trg_narratives_updated_at ON ${schema}.narratives;
CREATE TRIGGER trg_narratives_updated_at
  BEFORE UPDATE ON ${schema}.narratives
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.set_updated_at();

-- consumer_profiles: registry for consumer output contracts.
-- Composite primary key (tenant_id, consumer_id, version) future-proofs multi-tenant.
-- profile_hash UNIQUE per (consumer_id, version) catches accidental hash drift within
-- a consumer version.
CREATE TABLE IF NOT EXISTS ${schema}.consumer_profiles (
  tenant_id       TEXT         NOT NULL DEFAULT 'default',
  consumer_id     TEXT         NOT NULL,
  version         INT          NOT NULL,
  profile_hash    TEXT         NOT NULL,
  profile_json    JSONB        NOT NULL,
  loaded_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deprecated_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer_id, version),
  UNIQUE (consumer_id, version, profile_hash)
);

CREATE INDEX IF NOT EXISTS idx_consumer_profiles_active
  ON ${schema}.consumer_profiles (tenant_id, consumer_id, version DESC)
  WHERE deprecated_at IS NULL;

DROP TRIGGER IF EXISTS trg_consumer_profiles_updated_at ON ${schema}.consumer_profiles;
CREATE TRIGGER trg_consumer_profiles_updated_at
  BEFORE UPDATE ON ${schema}.consumer_profiles
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.set_updated_at();

-- timeline_events: append-only event log keyed by (tenant, agent, occurred_at).
-- category vocabulary is consumer-owned (focus/todo/mood/handoff/narrative/cli
-- for Miranda default), event shape is strict core. idempotency_key UNIQUE
-- across the table to make caller-driven dedupe safe.
CREATE TABLE IF NOT EXISTS ${schema}.timeline_events (
  id                          BIGSERIAL    PRIMARY KEY,
  tenant_id                   TEXT         NOT NULL DEFAULT 'default',
  session_row_id              BIGINT       REFERENCES ${schema}.sessions(id) ON DELETE SET NULL,
  source_session_id           TEXT,
  agent_id                    TEXT         NOT NULL DEFAULT 'main',
  consumer_profile_id         TEXT         NOT NULL,
  consumer_profile_version    INT          NOT NULL,
  consumer_schema_hash        TEXT         NOT NULL,
  idempotency_key             TEXT         UNIQUE,
  occurred_at                 TIMESTAMPTZ  NOT NULL,
  source                      TEXT         NOT NULL,
  session_ref                 TEXT,
  category                    TEXT         NOT NULL,
  text                        TEXT         NOT NULL,
  metadata                    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  search_tsv                  TSVECTOR,
  search_text                 TEXT,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_events_occurred_at
  ON ${schema}.timeline_events (tenant_id, agent_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_timeline_events_category
  ON ${schema}.timeline_events (tenant_id, agent_id, category, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_timeline_events_search_tsv
  ON ${schema}.timeline_events USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS idx_timeline_events_search_text_trgm
  ON ${schema}.timeline_events USING GIN (search_text gin_trgm_ops);

CREATE OR REPLACE FUNCTION ${schema}.timeline_events_search_tsv_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text :=
    COALESCE(NEW.category, '') || ' ' ||
    COALESCE(NEW.text, '') || ' ' ||
    COALESCE(NEW.metadata::text, '');

  NEW.search_tsv :=
    setweight(to_tsvector('simple', COALESCE(NEW.category, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(NEW.text, '')), 'A');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_timeline_events_search_tsv ON ${schema}.timeline_events;
CREATE TRIGGER trg_timeline_events_search_tsv
  BEFORE INSERT OR UPDATE OF category, text, metadata
  ON ${schema}.timeline_events
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.timeline_events_search_tsv_update();

DROP TRIGGER IF EXISTS trg_timeline_events_updated_at ON ${schema}.timeline_events;
CREATE TRIGGER trg_timeline_events_updated_at
  BEFORE UPDATE ON ${schema}.timeline_events
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.set_updated_at();

-- session_states: latest-snapshot-per-scope with supersede chain.
-- is_latest + partial unique index enforces at-most-one latest per
-- (tenant, agent, scope_key); writer supersedes prior latest atomically.
CREATE TABLE IF NOT EXISTS ${schema}.session_states (
  id                          BIGSERIAL    PRIMARY KEY,
  tenant_id                   TEXT         NOT NULL DEFAULT 'default',
  session_row_id              BIGINT       REFERENCES ${schema}.sessions(id) ON DELETE SET NULL,
  source_session_id           TEXT,
  agent_id                    TEXT         NOT NULL DEFAULT 'main',
  scope_key                   TEXT         NOT NULL,
  consumer_profile_id         TEXT         NOT NULL,
  consumer_profile_version    INT          NOT NULL,
  consumer_schema_hash        TEXT         NOT NULL,
  idempotency_key             TEXT         UNIQUE,
  goal                        TEXT,
  active_work                 JSONB        NOT NULL DEFAULT '[]'::jsonb,
  blockers                    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  affect                      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  payload                     JSONB        NOT NULL,
  is_latest                   BOOLEAN      NOT NULL DEFAULT true,
  supersedes_state_id         BIGINT       REFERENCES ${schema}.session_states(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_states_latest
  ON ${schema}.session_states (tenant_id, agent_id, scope_key)
  WHERE is_latest = true;

CREATE INDEX IF NOT EXISTS idx_session_states_agent
  ON ${schema}.session_states (tenant_id, agent_id, created_at DESC);

-- session_handoffs: append-only handoff log. getLatest by (agent) or (agent, session).
-- No latest-enforcement — every write is a row; retrieval sorts by created_at DESC.
CREATE TABLE IF NOT EXISTS ${schema}.session_handoffs (
  id                          BIGSERIAL    PRIMARY KEY,
  tenant_id                   TEXT         NOT NULL DEFAULT 'default',
  session_row_id              BIGINT       REFERENCES ${schema}.sessions(id) ON DELETE SET NULL,
  source_session_id           TEXT         NOT NULL,
  agent_id                    TEXT         NOT NULL DEFAULT 'main',
  consumer_profile_id         TEXT         NOT NULL,
  consumer_profile_version    INT          NOT NULL,
  consumer_schema_hash        TEXT         NOT NULL,
  idempotency_key             TEXT         UNIQUE,
  status                      TEXT         NOT NULL,
  last_step                   TEXT,
  next_step                   TEXT,
  blockers                    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  decided                     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  open_loops                  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  payload                     JSONB        NOT NULL,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_handoffs_agent
  ON ${schema}.session_handoffs (tenant_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_handoffs_session
  ON ${schema}.session_handoffs (tenant_id, source_session_id, created_at DESC);

-- decisions: append-only decision log. status vocabulary
-- (proposed/committed/reversed) lives in a CHECK constraint so bad writes
-- fail at DB boundary. reversed_by_decision_id forms a supersede chain.
CREATE TABLE IF NOT EXISTS ${schema}.decisions (
  id                          BIGSERIAL    PRIMARY KEY,
  tenant_id                   TEXT         NOT NULL DEFAULT 'default',
  session_row_id              BIGINT       REFERENCES ${schema}.sessions(id) ON DELETE SET NULL,
  source_session_id           TEXT,
  agent_id                    TEXT         NOT NULL DEFAULT 'main',
  consumer_profile_id         TEXT         NOT NULL,
  consumer_profile_version    INT          NOT NULL,
  consumer_schema_hash        TEXT         NOT NULL,
  idempotency_key             TEXT         UNIQUE,
  payload                     JSONB        NOT NULL,
  status                      TEXT         NOT NULL
    CHECK (status IN ('proposed', 'committed', 'reversed')),
  decision_text               TEXT         NOT NULL,
  reason_text                 TEXT,
  decided_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  reversed_by_decision_id     BIGINT       REFERENCES ${schema}.decisions(id) ON DELETE SET NULL,
  metadata                    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  search_tsv                  TSVECTOR,
  search_text                 TEXT,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decisions_status
  ON ${schema}.decisions (tenant_id, agent_id, status, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_session
  ON ${schema}.decisions (tenant_id, source_session_id);

CREATE INDEX IF NOT EXISTS idx_decisions_search_tsv
  ON ${schema}.decisions USING GIN (search_tsv);

CREATE OR REPLACE FUNCTION ${schema}.decisions_search_tsv_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text :=
    COALESCE(NEW.decision_text, '') || ' ' ||
    COALESCE(NEW.reason_text, '') || ' ' ||
    COALESCE(NEW.metadata::text, '');

  NEW.search_tsv :=
    setweight(to_tsvector('simple', COALESCE(NEW.decision_text, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.reason_text, '')), 'B');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_decisions_search_tsv ON ${schema}.decisions;
CREATE TRIGGER trg_decisions_search_tsv
  BEFORE INSERT OR UPDATE OF decision_text, reason_text, metadata
  ON ${schema}.decisions
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.decisions_search_tsv_update();

DROP TRIGGER IF EXISTS trg_decisions_updated_at ON ${schema}.decisions;
CREATE TRIGGER trg_decisions_updated_at
  BEFORE UPDATE ON ${schema}.decisions
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.set_updated_at();

-- artifacts: records producer-declared outputs (daily md, render, export).
-- Aquifer doesn't interpret payload — producers own shape. status lifecycle
-- pending → produced|failed|discarded.
CREATE TABLE IF NOT EXISTS ${schema}.artifacts (
  id                          BIGSERIAL    PRIMARY KEY,
  tenant_id                   TEXT         NOT NULL DEFAULT 'default',
  session_row_id              BIGINT       REFERENCES ${schema}.sessions(id) ON DELETE SET NULL,
  source_session_id           TEXT,
  agent_id                    TEXT         NOT NULL DEFAULT 'main',
  consumer_profile_id         TEXT         NOT NULL,
  consumer_profile_version    INT          NOT NULL,
  consumer_schema_hash        TEXT         NOT NULL,
  idempotency_key             TEXT         UNIQUE,
  producer_id                 TEXT         NOT NULL,
  artifact_type               TEXT         NOT NULL,
  trigger_phase               TEXT,
  format                      TEXT         NOT NULL,
  destination                 TEXT         NOT NULL,
  status                      TEXT         NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'produced', 'failed', 'discarded')),
  content_ref                 TEXT,
  payload                     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  metadata                    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  produced_at                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_lookup
  ON ${schema}.artifacts (tenant_id, agent_id, producer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_artifacts_session
  ON ${schema}.artifacts (tenant_id, source_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_artifacts_status
  ON ${schema}.artifacts (tenant_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_artifacts_updated_at ON ${schema}.artifacts;
CREATE TRIGGER trg_artifacts_updated_at
  BEFORE UPDATE ON ${schema}.artifacts
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.set_updated_at();
