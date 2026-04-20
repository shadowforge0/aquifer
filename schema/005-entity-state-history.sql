-- entity_state_history: temporal state-change tracking on entities.
--
-- Captures discrete attribute transitions (e.g. version.stable=1.2.1 -> 1.3.0,
-- editor.preference=vim -> nvim). Designed as additive overlay on the entities
-- table; DROP-clean — no triggers/functions/views, removing this table leaves
-- the rest of Aquifer untouched.
--
-- See spec.md Q3 and ~/.claude/develop-runs/20260419-142432-aquifer-memory-routes/.

CREATE TABLE IF NOT EXISTS ${schema}.entity_state_history (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           TEXT          NOT NULL DEFAULT 'default',
  agent_id            TEXT          NOT NULL DEFAULT 'main',
  entity_id           BIGINT        NOT NULL
    REFERENCES ${schema}.entities(id) ON DELETE CASCADE,
  session_row_id      BIGINT
    REFERENCES ${schema}.sessions(id) ON DELETE SET NULL,
  evidence_session_id TEXT,
  attribute           TEXT          NOT NULL CHECK (btrim(attribute) <> ''),
  value               JSONB         NOT NULL,
  valid_from          TIMESTAMPTZ   NOT NULL,
  valid_to            TIMESTAMPTZ,
  evidence_text       TEXT          NOT NULL DEFAULT '',
  confidence          NUMERIC(4,3)  NOT NULL DEFAULT 0.7
    CHECK (confidence >= 0 AND confidence <= 1),
  source              TEXT          NOT NULL DEFAULT 'llm'
    CHECK (source IN ('llm', 'manual', 'infra')),
  idempotency_key     TEXT,
  supersedes_state_id BIGINT
    REFERENCES ${schema}.entity_state_history(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Partial UNIQUE: only one "current" (valid_to IS NULL) row per
-- (tenant, agent, entity, attribute). This is the temporal invariant —
-- two open intervals on the same key would mean the table is corrupt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_state_history_current
  ON ${schema}.entity_state_history (tenant_id, agent_id, entity_id, attribute)
  WHERE valid_to IS NULL;

-- Idempotency: same caller-supplied key writes once. Partial allows NULL keys
-- (manual writes don't always need them).
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_state_history_idempotency
  ON ${schema}.entity_state_history (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Hot path: history-by-attribute timeline scan, newest-first.
CREATE INDEX IF NOT EXISTS idx_entity_state_history_entity_attr_time
  ON ${schema}.entity_state_history
     (tenant_id, agent_id, entity_id, attribute, valid_from DESC, id DESC);

-- Hot path: full history for an entity (no attribute filter).
CREATE INDEX IF NOT EXISTS idx_entity_state_history_entity_time
  ON ${schema}.entity_state_history
     (tenant_id, agent_id, entity_id, valid_from DESC, id DESC);

-- Diagnostic: trace all state changes captured from a single session.
CREATE INDEX IF NOT EXISTS idx_entity_state_history_evidence_session
  ON ${schema}.entity_state_history
     (tenant_id, agent_id, evidence_session_id, created_at DESC)
  WHERE evidence_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_state_history_session_row
  ON ${schema}.entity_state_history (session_row_id)
  WHERE session_row_id IS NOT NULL;

COMMENT ON TABLE ${schema}.entity_state_history IS
  'Bi-temporal state changes on entities. Each row = one (entity, attribute) value valid over [valid_from, valid_to). NULL valid_to = current. supersedes_state_id chains supersession history.';

COMMENT ON COLUMN ${schema}.entity_state_history.attribute IS
  'Stable snake_case path identifying what changed (e.g. version.stable, editor.preference, runtime.node.version). Caller-defined; treat as opaque key.';

COMMENT ON COLUMN ${schema}.entity_state_history.valid_from IS
  'When the new value became true in the real world (not when it was observed). Use evidence anchor; fall back to session started_at if unspecified.';

COMMENT ON COLUMN ${schema}.entity_state_history.valid_to IS
  'NULL = currently valid. Otherwise, the timestamp at which a successor row took over. Closed intervals must satisfy valid_to > valid_from.';

COMMENT ON COLUMN ${schema}.entity_state_history.idempotency_key IS
  'Caller-supplied dedupe key. Default: sha256(tenant, agent, entity, attribute, canonical_json(value), valid_from, source). Replay safe.';

COMMENT ON COLUMN ${schema}.entity_state_history.supersedes_state_id IS
  'Chain pointer to the row this one closed (set valid_to on). NULL if this is the first known value for (entity, attribute).';

COMMENT ON COLUMN ${schema}.entity_state_history.evidence_session_id IS
  'Session that produced this evidence (text-level session_id, not session_row_id). For audit / re-extraction.';
