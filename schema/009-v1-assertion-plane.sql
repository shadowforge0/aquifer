-- Aquifer v1 structured assertion plane
-- Requires: 001-base.sql, 007-v1-foundation.sql, and 008-session-finalizations.sql
-- Usage: replace ${schema} with actual schema name
--
-- This migration is additive. It introduces a new v1 structured assertion
-- table and related integrity guards without repurposing legacy 004-facts rows.

-- =========================================================================
-- Scope tenant safety: prevent future cross-tenant ancestry leakage
-- =========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_scopes_tenant_row
  ON ${schema}.scopes (tenant_id, id);

CREATE OR REPLACE FUNCTION ${schema}.scope_parent_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_tenant TEXT;
BEGIN
  IF NEW.parent_scope_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id
    INTO parent_tenant
    FROM ${schema}.scopes
   WHERE id = NEW.parent_scope_id;

  IF parent_tenant IS NOT NULL AND parent_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'scope parent tenant mismatch: child tenant=% parent scope id=% parent tenant=%',
      NEW.tenant_id, NEW.parent_scope_id, parent_tenant
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_scopes_parent_tenant_guard
  ON ${schema}.scopes;

CREATE TRIGGER trg_scopes_parent_tenant_guard
  BEFORE INSERT OR UPDATE OF tenant_id, parent_scope_id
  ON ${schema}.scopes
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.scope_parent_tenant_guard();

-- =========================================================================
-- fact_assertions_v1: structured assertion plane for curated memory
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.fact_assertions_v1 (
  id                 BIGSERIAL    PRIMARY KEY,
  tenant_id          TEXT         NOT NULL DEFAULT 'default',
  canonical_key      TEXT         NOT NULL CHECK (btrim(canonical_key) <> ''),
  scope_id           BIGINT       NOT NULL REFERENCES ${schema}.scopes(id) ON DELETE RESTRICT,
  subject_entity_id  BIGINT,
  predicate          TEXT         NOT NULL CHECK (btrim(predicate) <> ''),
  object_kind        TEXT         NOT NULL
                       CHECK (object_kind IN ('entity','value','none')),
  object_entity_id   BIGINT,
  object_value_json  JSONB,
  qualifiers_json    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  valid_from         TIMESTAMPTZ,
  valid_to           TIMESTAMPTZ,
  observed_at        TIMESTAMPTZ,
  stale_after        TIMESTAMPTZ,
  accepted_at        TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  superseded_at      TIMESTAMPTZ,
  status             TEXT         NOT NULL DEFAULT 'candidate'
                       CHECK (status IN (
                         'candidate','active','stale','superseded','revoked',
                         'tombstoned','quarantined','archived'
                       )),
  authority          TEXT         NOT NULL DEFAULT 'llm_inference'
                       CHECK (authority IN (
                         'user_explicit','executable_evidence','verified_summary',
                         'llm_inference','raw_transcript','manual','system'
                       )),
  assertion_hash     TEXT         NOT NULL CHECK (btrim(assertion_hash) <> ''),
  superseded_by      BIGINT       REFERENCES ${schema}.fact_assertions_v1(id) ON DELETE SET NULL,
  version_id         BIGINT       REFERENCES ${schema}.versions(id) ON DELETE SET NULL,
  metadata           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  CHECK (revoked_at IS NULL OR accepted_at IS NULL OR revoked_at >= accepted_at),
  CHECK (superseded_at IS NULL OR accepted_at IS NULL OR superseded_at >= accepted_at),
  CHECK (NOT (revoked_at IS NOT NULL AND superseded_at IS NOT NULL)),
  CHECK (
    (object_kind = 'entity' AND object_entity_id IS NOT NULL AND object_value_json IS NULL)
    OR (object_kind = 'value' AND object_entity_id IS NULL AND object_value_json IS NOT NULL)
    OR (object_kind = 'none' AND object_entity_id IS NULL AND object_value_json IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_assertions_v1_tenant_row
  ON ${schema}.fact_assertions_v1 (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_assertions_v1_active_canonical
  ON ${schema}.fact_assertions_v1 (tenant_id, canonical_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_fact_assertions_v1_scope_status
  ON ${schema}.fact_assertions_v1 (tenant_id, scope_id, status, observed_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_fact_assertions_v1_hash
  ON ${schema}.fact_assertions_v1 (tenant_id, assertion_hash);

CREATE INDEX IF NOT EXISTS idx_fact_assertions_v1_superseded_by
  ON ${schema}.fact_assertions_v1 (superseded_by)
  WHERE superseded_by IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.fact_assertions_v1'::regclass
       AND conname = 'fact_assertions_v1_scope_tenant_fk'
  ) THEN
    ALTER TABLE ${schema}.fact_assertions_v1
      ADD CONSTRAINT fact_assertions_v1_scope_tenant_fk
      FOREIGN KEY (tenant_id, scope_id)
      REFERENCES ${schema}.scopes (tenant_id, id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$$;

COMMENT ON TABLE ${schema}.fact_assertions_v1 IS
  'v1 structured assertion plane. New table; does not reuse legacy 004-facts rows.';

-- =========================================================================
-- memory_records: structured-assertion linkage + system-time lifecycle fields
-- =========================================================================
ALTER TABLE ${schema}.memory_records
  ADD COLUMN IF NOT EXISTS backing_fact_id BIGINT,
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_records_tenant_row
  ON ${schema}.memory_records (tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_memory_records_backing_fact
  ON ${schema}.memory_records (tenant_id, backing_fact_id)
  WHERE backing_fact_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.memory_records'::regclass
       AND conname = 'memory_records_scope_tenant_fk'
  ) THEN
    ALTER TABLE ${schema}.memory_records
      ADD CONSTRAINT memory_records_scope_tenant_fk
      FOREIGN KEY (tenant_id, scope_id)
      REFERENCES ${schema}.scopes (tenant_id, id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.memory_records'::regclass
       AND conname = 'memory_records_backing_fact_tenant_fk'
  ) THEN
    ALTER TABLE ${schema}.memory_records
      ADD CONSTRAINT memory_records_backing_fact_tenant_fk
      FOREIGN KEY (tenant_id, backing_fact_id)
      REFERENCES ${schema}.fact_assertions_v1 (tenant_id, id)
      NOT VALID;
  END IF;
END;
$$;

-- =========================================================================
-- compaction_runs: source/output coverage fields for auditability
-- =========================================================================
ALTER TABLE ${schema}.compaction_runs
  ADD COLUMN IF NOT EXISTS source_coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS output_coverage JSONB NOT NULL DEFAULT '{}'::jsonb;
