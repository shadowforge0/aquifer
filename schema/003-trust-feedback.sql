-- Aquifer trust feedback extension
-- Requires: 001-base.sql applied first
-- Usage: replace ${schema} with actual schema name

-- =========================================================================
-- Trust score: per-session summary quality metric
-- =========================================================================
ALTER TABLE ${schema}.session_summaries
  ADD COLUMN IF NOT EXISTS trust_score REAL NOT NULL DEFAULT 0.5
  CHECK (trust_score >= 0 AND trust_score <= 1);

-- =========================================================================
-- Session feedback: audit trail for user feedback on session summaries
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.session_feedback (
  id             BIGSERIAL    PRIMARY KEY,
  session_row_id BIGINT       NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
  tenant_id      TEXT         NOT NULL DEFAULT 'default',
  agent_id       TEXT         NOT NULL DEFAULT 'agent',
  session_id     TEXT         NOT NULL,
  verdict        TEXT         NOT NULL CHECK (verdict IN ('helpful', 'unhelpful')),
  note           TEXT,
  trust_before   REAL         NOT NULL,
  trust_after    REAL         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_feedback_session
  ON ${schema}.session_feedback (session_row_id, created_at DESC);
