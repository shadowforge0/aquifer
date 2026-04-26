-- Aquifer v1 compaction lineage and candidate ledger
-- Requires: 007-v1-foundation.sql, 009-v1-assertion-plane.sql, and 012-v1-compaction-lease.sql
-- Usage: replace ${schema} with actual schema name
--
-- Aggregate compaction candidates must remain auditable before promotion and
-- every promoted row must point back to the compaction run that created it.

CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_runs_tenant_row
  ON ${schema}.compaction_runs (tenant_id, id);

ALTER TABLE ${schema}.memory_records
  ADD COLUMN IF NOT EXISTS created_by_compaction_run_id BIGINT;

ALTER TABLE ${schema}.fact_assertions_v1
  ADD COLUMN IF NOT EXISTS created_by_compaction_run_id BIGINT;

ALTER TABLE ${schema}.evidence_refs
  ADD COLUMN IF NOT EXISTS created_by_compaction_run_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_memory_records_created_by_compaction_run
  ON ${schema}.memory_records (tenant_id, created_by_compaction_run_id)
  WHERE created_by_compaction_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fact_assertions_created_by_compaction_run
  ON ${schema}.fact_assertions_v1 (tenant_id, created_by_compaction_run_id)
  WHERE created_by_compaction_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_refs_created_by_compaction_run
  ON ${schema}.evidence_refs (tenant_id, created_by_compaction_run_id)
  WHERE created_by_compaction_run_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.memory_records'::regclass
       AND conname = 'memory_records_created_by_compaction_run_fk'
  ) THEN
    ALTER TABLE ${schema}.memory_records
      ADD CONSTRAINT memory_records_created_by_compaction_run_fk
      FOREIGN KEY (tenant_id, created_by_compaction_run_id)
      REFERENCES ${schema}.compaction_runs (tenant_id, id)
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
       AND conname = 'fact_assertions_created_by_compaction_run_fk'
  ) THEN
    ALTER TABLE ${schema}.fact_assertions_v1
      ADD CONSTRAINT fact_assertions_created_by_compaction_run_fk
      FOREIGN KEY (tenant_id, created_by_compaction_run_id)
      REFERENCES ${schema}.compaction_runs (tenant_id, id)
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
       AND conname = 'evidence_refs_created_by_compaction_run_fk'
  ) THEN
    ALTER TABLE ${schema}.evidence_refs
      ADD CONSTRAINT evidence_refs_created_by_compaction_run_fk
      FOREIGN KEY (tenant_id, created_by_compaction_run_id)
      REFERENCES ${schema}.compaction_runs (tenant_id, id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS ${schema}.compaction_candidates (
  id                   BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL DEFAULT 'default',
  compaction_run_id    BIGINT       NOT NULL,
  candidate_index      INTEGER      NOT NULL,
  candidate_hash       TEXT         NOT NULL CHECK (btrim(candidate_hash) <> ''),
  action               TEXT         NOT NULL DEFAULT 'planned'
                         CHECK (action IN (
                           'planned','promote','quarantine','skip','skipped','error'
                         )),
  reason               TEXT,
  memory_type          TEXT,
  canonical_key        TEXT,
  scope_kind           TEXT,
  scope_key            TEXT,
  context_key          TEXT,
  topic_key            TEXT,
  summary              TEXT,
  payload              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  source_memory_ids    BIGINT[]     NOT NULL DEFAULT ARRAY[]::BIGINT[],
  source_canonical_keys JSONB       NOT NULL DEFAULT '[]'::jsonb,
  memory_record_id     BIGINT,
  fact_assertion_id    BIGINT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(source_canonical_keys) = 'array'),
  CHECK (jsonb_array_length(source_canonical_keys) = cardinality(source_memory_ids))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.compaction_candidates'::regclass
       AND conname = 'compaction_candidates_run_fk'
  ) THEN
    ALTER TABLE ${schema}.compaction_candidates
      ADD CONSTRAINT compaction_candidates_run_fk
      FOREIGN KEY (tenant_id, compaction_run_id)
      REFERENCES ${schema}.compaction_runs (tenant_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.compaction_candidates'::regclass
       AND conname = 'compaction_candidates_memory_fk'
  ) THEN
    ALTER TABLE ${schema}.compaction_candidates
      ADD CONSTRAINT compaction_candidates_memory_fk
      FOREIGN KEY (tenant_id, memory_record_id)
      REFERENCES ${schema}.memory_records (tenant_id, id)
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
     WHERE conrelid = '${schema}.compaction_candidates'::regclass
       AND conname = 'compaction_candidates_fact_fk'
  ) THEN
    ALTER TABLE ${schema}.compaction_candidates
      ADD CONSTRAINT compaction_candidates_fact_fk
      FOREIGN KEY (tenant_id, fact_assertion_id)
      REFERENCES ${schema}.fact_assertions_v1 (tenant_id, id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_candidates_position
  ON ${schema}.compaction_candidates (tenant_id, compaction_run_id, candidate_index);

CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_candidates_hash
  ON ${schema}.compaction_candidates (tenant_id, compaction_run_id, candidate_hash);

CREATE INDEX IF NOT EXISTS idx_compaction_candidates_action
  ON ${schema}.compaction_candidates (tenant_id, action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_compaction_candidates_memory
  ON ${schema}.compaction_candidates (tenant_id, memory_record_id)
  WHERE memory_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_compaction_candidates_fact
  ON ${schema}.compaction_candidates (tenant_id, fact_assertion_id)
  WHERE fact_assertion_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_compaction_candidates_sources
  ON ${schema}.compaction_candidates USING GIN (source_memory_ids);

COMMENT ON TABLE ${schema}.compaction_candidates IS
  'Per-compaction-run aggregate candidate ledger. Planned, promoted, skipped, quarantined, and errored candidates remain auditable without bypassing promotion.';

COMMENT ON COLUMN ${schema}.memory_records.created_by_compaction_run_id IS
  'Compaction run that formally promoted this memory, if any. Planner-only candidates do not set this column.';
