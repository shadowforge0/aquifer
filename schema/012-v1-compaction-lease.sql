-- Aquifer v1 compaction claim lease guard
-- Requires: 011-v1-compaction-claim.sql
-- Usage: replace ${schema} with actual schema name
--
-- Adds row-level lease expiry for compaction claims. Lease expiry is a DB
-- timestamp fact, not a caller-clock interpretation of claimed_at.

ALTER TABLE ${schema}.compaction_runs
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reclaimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reclaimed_by_worker_id TEXT;

UPDATE ${schema}.compaction_runs
   SET lease_expires_at = claimed_at + interval '600 seconds'
 WHERE status = 'applying'
   AND claimed_at IS NOT NULL
   AND lease_expires_at IS NULL;

ALTER TABLE ${schema}.compaction_runs
  DROP CONSTRAINT IF EXISTS compaction_runs_applying_lease_check;

ALTER TABLE ${schema}.compaction_runs
  ADD CONSTRAINT compaction_runs_applying_lease_check
  CHECK (
    status <> 'applying'
    OR (
      lease_expires_at IS NOT NULL
      AND lease_expires_at > claimed_at
    )
  );

CREATE INDEX IF NOT EXISTS idx_compaction_runs_claim_lease
  ON ${schema}.compaction_runs (
    tenant_id, cadence, period_start, period_end, policy_version, lease_expires_at
  )
  WHERE status = 'applying';

COMMENT ON COLUMN ${schema}.compaction_runs.lease_expires_at IS
  'DB-time expiry for the current apply claim. Competing workers may reclaim only after this timestamp.';
