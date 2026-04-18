-- Aquifer facts / consolidation extension
-- Requires: 001-base.sql applied first
-- Usage: replace ${schema} with actual schema name
--
-- Facts store long-lived subject/statement pairs with a lifecycle:
--   candidate → active → (stale | archived | superseded)
-- Consumers write candidates during enrich (via writeFactCandidates).
-- consolidate() then promotes / updates / confirms / archives them.

-- =========================================================================
-- Facts: long-lived current-state statements per (subject, agent)
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.facts (
  id                 BIGSERIAL    PRIMARY KEY,
  tenant_id          TEXT         NOT NULL DEFAULT 'default',
  subject_key        TEXT         NOT NULL,
  subject_label      TEXT         NOT NULL,
  statement          TEXT         NOT NULL,
  status             TEXT         NOT NULL DEFAULT 'candidate'
                       CHECK (status IN ('candidate','active','stale','archived','superseded')),
  importance         SMALLINT     NOT NULL DEFAULT 5,
  source_session_id  TEXT,
  agent_id           TEXT         NOT NULL DEFAULT 'main',
  evidence           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  superseded_by      BIGINT       REFERENCES ${schema}.facts(id) ON DELETE SET NULL,
  first_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_confirmed_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Migration: add tenant_id if upgrading from a legacy facts table (no tenant column).
ALTER TABLE ${schema}.facts ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- At most one active fact per (tenant, subject, agent)
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_active_subject
  ON ${schema}.facts (tenant_id, subject_key, agent_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_facts_active_agent
  ON ${schema}.facts (tenant_id, agent_id, importance DESC, last_confirmed_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_facts_status_created
  ON ${schema}.facts (tenant_id, status, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_facts_subject
  ON ${schema}.facts (tenant_id, subject_key);

CREATE INDEX IF NOT EXISTS idx_facts_source_session
  ON ${schema}.facts (source_session_id)
  WHERE source_session_id IS NOT NULL;

COMMENT ON TABLE ${schema}.facts IS 'Fact candidates and active facts per (tenant, subject, agent) with consolidation lifecycle';

-- =========================================================================
-- Fact ↔ Entity join (optional, only when entities enabled)
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.fact_entities (
  id         BIGSERIAL    PRIMARY KEY,
  fact_id    BIGINT       NOT NULL REFERENCES ${schema}.facts(id) ON DELETE CASCADE,
  entity_id  BIGINT       NOT NULL,
  UNIQUE (fact_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_entities_entity_id
  ON ${schema}.fact_entities (entity_id);

COMMENT ON TABLE ${schema}.fact_entities IS 'Join table linking facts to entities (FK to entities is soft — entities table is optional)';
