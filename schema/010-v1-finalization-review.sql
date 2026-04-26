-- Aquifer v1 finalization review and lineage
-- Requires: 001-base.sql, 007-v1-foundation.sql, 008-session-finalizations.sql, 009-v1-assertion-plane.sql
-- Usage: replace ${schema} with actual schema name
--
-- Finalization must leave a human-reviewable artifact and row-level lineage.
-- DB storage alone is not treated as usable runtime memory.

-- =========================================================================
-- Finalization ledger: explicit human review and minimal SessionStart text
-- =========================================================================
ALTER TABLE ${schema}.session_finalizations
  ADD COLUMN IF NOT EXISTS summary_text TEXT,
  ADD COLUMN IF NOT EXISTS structured_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS human_review_text TEXT,
  ADD COLUMN IF NOT EXISTS session_start_text TEXT;

COMMENT ON COLUMN ${schema}.session_finalizations.human_review_text IS
  'Human-facing finalization review: concise summary of what was made active, left open, quarantined, and excluded.';

COMMENT ON COLUMN ${schema}.session_finalizations.session_start_text IS
  'Minimal active curated context eligible for SessionStart injection; excludes raw transcript/debug/audit fields.';

-- =========================================================================
-- Lifecycle semantics: incorrect is an explicit non-serving state
-- =========================================================================
ALTER TABLE ${schema}.memory_records
  DROP CONSTRAINT IF EXISTS memory_records_status_check;

ALTER TABLE ${schema}.memory_records
  ADD CONSTRAINT memory_records_status_check
  CHECK (status IN (
    'candidate','active','stale','superseded','revoked',
    'tombstoned','quarantined','archived','incorrect'
  ));

ALTER TABLE ${schema}.fact_assertions_v1
  DROP CONSTRAINT IF EXISTS fact_assertions_v1_status_check;

ALTER TABLE ${schema}.fact_assertions_v1
  ADD CONSTRAINT fact_assertions_v1_status_check
  CHECK (status IN (
    'candidate','active','stale','superseded','revoked',
    'tombstoned','quarantined','archived','incorrect'
  ));

-- =========================================================================
-- Row-level finalization lineage
-- =========================================================================
ALTER TABLE ${schema}.memory_records
  ADD COLUMN IF NOT EXISTS created_by_finalization_id BIGINT;

ALTER TABLE ${schema}.fact_assertions_v1
  ADD COLUMN IF NOT EXISTS created_by_finalization_id BIGINT;

ALTER TABLE ${schema}.evidence_refs
  ADD COLUMN IF NOT EXISTS created_by_finalization_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_memory_records_created_by_finalization
  ON ${schema}.memory_records (tenant_id, created_by_finalization_id)
  WHERE created_by_finalization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fact_assertions_created_by_finalization
  ON ${schema}.fact_assertions_v1 (tenant_id, created_by_finalization_id)
  WHERE created_by_finalization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_refs_created_by_finalization
  ON ${schema}.evidence_refs (tenant_id, created_by_finalization_id)
  WHERE created_by_finalization_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.memory_records'::regclass
       AND conname = 'memory_records_created_by_finalization_fk'
  ) THEN
    ALTER TABLE ${schema}.memory_records
      ADD CONSTRAINT memory_records_created_by_finalization_fk
      FOREIGN KEY (created_by_finalization_id)
      REFERENCES ${schema}.session_finalizations (id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.fact_assertions_v1'::regclass
       AND conname = 'fact_assertions_created_by_finalization_fk'
  ) THEN
    ALTER TABLE ${schema}.fact_assertions_v1
      ADD CONSTRAINT fact_assertions_created_by_finalization_fk
      FOREIGN KEY (created_by_finalization_id)
      REFERENCES ${schema}.session_finalizations (id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.evidence_refs'::regclass
       AND conname = 'evidence_refs_created_by_finalization_fk'
  ) THEN
    ALTER TABLE ${schema}.evidence_refs
      ADD CONSTRAINT evidence_refs_created_by_finalization_fk
      FOREIGN KEY (created_by_finalization_id)
      REFERENCES ${schema}.session_finalizations (id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END;
$$;

-- =========================================================================
-- Candidate ledger: every extracted item has an action and reason
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.finalization_candidates (
  id                   BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL DEFAULT 'default',
  finalization_id      BIGINT       NOT NULL REFERENCES ${schema}.session_finalizations(id) ON DELETE CASCADE,
  session_id           TEXT,
  candidate_index      INTEGER      NOT NULL,
  action               TEXT         NOT NULL
                         CHECK (action IN (
                           'promote','quarantine','skip','skipped','supersede','error'
                         )),
  reason               TEXT,
  memory_type          TEXT,
  canonical_key        TEXT,
  summary              TEXT,
  payload              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  provenance           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  memory_record_id     BIGINT,
  fact_assertion_id    BIGINT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_finalization_candidates_position
  ON ${schema}.finalization_candidates (tenant_id, finalization_id, candidate_index);

CREATE INDEX IF NOT EXISTS idx_finalization_candidates_action
  ON ${schema}.finalization_candidates (tenant_id, action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_finalization_candidates_memory
  ON ${schema}.finalization_candidates (tenant_id, memory_record_id)
  WHERE memory_record_id IS NOT NULL;

COMMENT ON TABLE ${schema}.finalization_candidates IS
  'Per-finalization candidate ledger. Promoted, skipped, quarantined, and incorrect candidates remain auditable without becoming runtime memory.';
