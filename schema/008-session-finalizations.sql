-- Aquifer v1 session finalization ledger
-- Requires: 001-base.sql and 007-v1-foundation.sql applied first
-- Usage: replace ${schema} with actual schema name

CREATE TABLE IF NOT EXISTS ${schema}.session_finalizations (
  id                 BIGSERIAL    PRIMARY KEY,
  tenant_id          TEXT         NOT NULL DEFAULT 'default',
  session_row_id     BIGINT       NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
  source             TEXT         NOT NULL DEFAULT 'api',
  host               TEXT         NOT NULL DEFAULT 'codex',
  agent_id           TEXT         NOT NULL DEFAULT 'main',
  session_id         TEXT         NOT NULL CHECK (btrim(session_id) <> ''),
  transcript_hash    TEXT         NOT NULL CHECK (btrim(transcript_hash) <> ''),
  phase              TEXT         NOT NULL DEFAULT 'curated_memory_v1',
  mode               TEXT         NOT NULL DEFAULT 'handoff'
                       CHECK (mode IN (
                         'handoff','session_end','session_start_recovery','afterburn','manual'
                       )),
  status             TEXT         NOT NULL DEFAULT 'pending'
                       CHECK (status IN (
                         'pending','processing','finalized','failed','skipped','declined','deferred'
                       )),
  finalizer_model    TEXT,
  scope_kind         TEXT,
  scope_key          TEXT,
  context_key        TEXT,
  topic_key          TEXT,
  summary_row_id     BIGINT,
  memory_result      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  error              TEXT,
  metadata           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  claimed_at         TIMESTAMPTZ,
  finalized_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_finalizations_identity
  ON ${schema}.session_finalizations (
    tenant_id, source, agent_id, session_id, transcript_hash, phase
  );

CREATE INDEX IF NOT EXISTS idx_session_finalizations_status
  ON ${schema}.session_finalizations (tenant_id, host, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_finalizations_session
  ON ${schema}.session_finalizations (tenant_id, agent_id, session_id, updated_at DESC);

COMMENT ON TABLE ${schema}.session_finalizations IS
  'v1 finalization ledger. DB is source of truth; local consumer markers are recovery hints only.';
