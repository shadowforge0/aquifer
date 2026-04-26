-- Aquifer v1 compaction claim/apply guard
-- Requires: 007-v1-foundation.sql and 009-v1-assertion-plane.sql
-- Usage: replace ${schema} with actual schema name
--
-- Adds the minimum DB contract needed before compaction_runs can coordinate
-- daily/weekly/monthly apply workers. This remains a ledger/claim guard; it
-- does not create or promote aggregate memory.

ALTER TABLE ${schema}.compaction_runs
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS apply_token TEXT;

ALTER TABLE ${schema}.compaction_runs
  DROP CONSTRAINT IF EXISTS compaction_runs_status_check;

ALTER TABLE ${schema}.compaction_runs
  ADD CONSTRAINT compaction_runs_status_check
  CHECK (status IN ('planned','applying','applied','failed','skipped'));

ALTER TABLE ${schema}.compaction_runs
  DROP CONSTRAINT IF EXISTS compaction_runs_applying_claim_check;

ALTER TABLE ${schema}.compaction_runs
  ADD CONSTRAINT compaction_runs_applying_claim_check
  CHECK (
    status <> 'applying'
    OR (
      claimed_at IS NOT NULL
      AND worker_id IS NOT NULL
      AND btrim(worker_id) <> ''
      AND apply_token IS NOT NULL
      AND btrim(apply_token) <> ''
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_runs_one_live_apply
  ON ${schema}.compaction_runs (tenant_id, cadence, period_start, period_end, policy_version)
  WHERE status = 'applying';

CREATE INDEX IF NOT EXISTS idx_compaction_runs_claims
  ON ${schema}.compaction_runs (tenant_id, cadence, status, claimed_at DESC)
  WHERE status = 'applying';

COMMENT ON COLUMN ${schema}.compaction_runs.apply_token IS
  'Opaque per-claim token. Apply/finalize code must present the claimed token before mutating memory.';
