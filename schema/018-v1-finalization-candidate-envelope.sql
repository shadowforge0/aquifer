-- Aquifer v1 finalization candidate envelope
-- Requires: 008-session-finalizations.sql, 010-v1-finalization-review.sql
-- Usage: replace ${schema} with actual schema name
--
-- The candidate envelope is producer material, not serving truth. It records
-- the structured synthesis input/output that core finalization validated before
-- promoting active current memory.

ALTER TABLE ${schema}.session_finalizations
  ADD COLUMN IF NOT EXISTS candidate_envelope JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS candidate_envelope_hash TEXT,
  ADD COLUMN IF NOT EXISTS candidate_envelope_version TEXT,
  ADD COLUMN IF NOT EXISTS coverage JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN ${schema}.session_finalizations.candidate_envelope IS
  'Structured current-memory candidate envelope produced by handoff/recovery synthesis; producer material, not serving truth.';

COMMENT ON COLUMN ${schema}.session_finalizations.candidate_envelope_hash IS
  'Stable hash of the candidate envelope used for audit and replay comparison.';

COMMENT ON COLUMN ${schema}.session_finalizations.candidate_envelope_version IS
  'Version of the producer envelope contract, for example handoff_current_memory_synthesis_v1.';

COMMENT ON COLUMN ${schema}.session_finalizations.coverage IS
  'Coverage metadata for partial transcript, previous bootstrap, checkpoint, or other synthesis inputs.';

CREATE INDEX IF NOT EXISTS idx_session_finalizations_candidate_envelope_hash
  ON ${schema}.session_finalizations (tenant_id, candidate_envelope_hash)
  WHERE candidate_envelope_hash IS NOT NULL;

ALTER TABLE ${schema}.finalization_candidates
  ADD COLUMN IF NOT EXISTS candidate_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_finalization_candidates_hash
  ON ${schema}.finalization_candidates (tenant_id, finalization_id, candidate_hash)
  WHERE candidate_hash IS NOT NULL;

COMMENT ON COLUMN ${schema}.finalization_candidates.candidate_hash IS
  'Stable per-candidate hash. candidate_index remains an ordered audit position.';
