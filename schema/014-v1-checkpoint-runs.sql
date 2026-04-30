-- Aquifer v1 rolling checkpoint ledger
-- Requires: 007-v1-foundation.sql, 008-session-finalizations.sql, and 010-v1-finalization-review.sql
-- Usage: replace ${schema} with actual schema name
--
-- Adds additive checkpoint-run audit tables plus scope FK/snapshot support on
-- session_finalizations. This does not change serving truth or promotion.

CREATE UNIQUE INDEX IF NOT EXISTS idx_scopes_tenant_row
  ON ${schema}.scopes (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_finalizations_tenant_row
  ON ${schema}.session_finalizations (tenant_id, id);

ALTER TABLE ${schema}.scopes
  DROP CONSTRAINT IF EXISTS scopes_scope_kind_check;

ALTER TABLE ${schema}.scopes
  ADD CONSTRAINT scopes_scope_kind_check
  CHECK (scope_kind IN (
    'global','user','workspace','project','event','session',
    'host_runtime','assistant_instance','repo','task'
  ));

ALTER TABLE ${schema}.session_finalizations
  ADD COLUMN IF NOT EXISTS scope_id BIGINT,
  ADD COLUMN IF NOT EXISTS scope_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.session_finalizations'::regclass
       AND conname = 'session_finalizations_scope_snapshot_object_check'
  ) THEN
    ALTER TABLE ${schema}.session_finalizations
      ADD CONSTRAINT session_finalizations_scope_snapshot_object_check
      CHECK (jsonb_typeof(scope_snapshot) = 'object');
  END IF;
END;
$$;

UPDATE ${schema}.session_finalizations sf
   SET scope_id = s.id
  FROM ${schema}.scopes s
 WHERE sf.scope_id IS NULL
   AND sf.scope_kind IS NOT NULL
   AND sf.scope_key IS NOT NULL
   AND s.tenant_id = sf.tenant_id
   AND s.scope_kind = sf.scope_kind
   AND s.scope_key = sf.scope_key;

UPDATE ${schema}.session_finalizations sf
   SET scope_snapshot = jsonb_strip_nulls(
         jsonb_build_object(
           'scopeId', COALESCE(sf.scope_id, s.id),
           'scopeKind', COALESCE(sf.scope_kind, s.scope_kind),
           'scopeKey', COALESCE(sf.scope_key, s.scope_key),
           'contextKey', COALESCE(sf.context_key, s.context_key),
           'topicKey', COALESCE(sf.topic_key, s.topic_key),
           'parentScopeId', s.parent_scope_id,
           'inheritanceMode', s.inheritance_mode,
           'activeFrom', s.active_from,
           'activeTo', s.active_to
         )
       )
  FROM ${schema}.scopes s
 WHERE sf.scope_id = s.id
   AND sf.tenant_id = s.tenant_id
   AND sf.scope_snapshot = '{}'::jsonb;

UPDATE ${schema}.session_finalizations
   SET scope_snapshot = jsonb_strip_nulls(
         jsonb_build_object(
           'scopeId', scope_id,
           'scopeKind', scope_kind,
           'scopeKey', scope_key,
           'contextKey', context_key,
           'topicKey', topic_key
         )
       )
 WHERE scope_snapshot = '{}'::jsonb
   AND (
     scope_id IS NOT NULL
     OR scope_kind IS NOT NULL
     OR scope_key IS NOT NULL
     OR context_key IS NOT NULL
     OR topic_key IS NOT NULL
   );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.session_finalizations'::regclass
       AND conname = 'session_finalizations_scope_fk'
  ) THEN
    ALTER TABLE ${schema}.session_finalizations
      ADD CONSTRAINT session_finalizations_scope_fk
      FOREIGN KEY (tenant_id, scope_id)
      REFERENCES ${schema}.scopes (tenant_id, id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_session_finalizations_scope
  ON ${schema}.session_finalizations (tenant_id, scope_id, finalized_at DESC, updated_at DESC)
  WHERE scope_id IS NOT NULL;

COMMENT ON COLUMN ${schema}.session_finalizations.scope_id IS
  'Resolved v1 scope row for this finalization when the producer knows it.';

COMMENT ON COLUMN ${schema}.session_finalizations.scope_snapshot IS
  'Compact scope audit snapshot captured at finalization time; serving still reads live curated memory.';

CREATE TABLE IF NOT EXISTS ${schema}.checkpoint_runs (
  id                         BIGSERIAL    PRIMARY KEY,
  tenant_id                  TEXT         NOT NULL DEFAULT 'default',
  scope_id                   BIGINT       NOT NULL,
  checkpoint_key             TEXT         NOT NULL CHECK (btrim(checkpoint_key) <> ''),
  from_finalization_id_exclusive BIGINT   NOT NULL DEFAULT 0 CHECK (from_finalization_id_exclusive >= 0),
  to_finalization_id_inclusive BIGINT,
  status                     TEXT         NOT NULL DEFAULT 'pending'
                               CHECK (status IN (
                                 'pending','processing','finalized','failed','skipped'
                               )),
  window_start               TIMESTAMPTZ,
  window_end                 TIMESTAMPTZ,
  scope_snapshot             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  checkpoint_text            TEXT,
  checkpoint_payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  error                      TEXT,
  metadata                   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  claimed_at                 TIMESTAMPTZ,
  finalized_at               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(scope_snapshot) = 'object'),
  CHECK (jsonb_typeof(checkpoint_payload) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (
    to_finalization_id_inclusive IS NULL
    OR to_finalization_id_inclusive > from_finalization_id_exclusive
  ),
  CHECK (
    (window_start IS NULL AND window_end IS NULL)
    OR (
      window_start IS NOT NULL
      AND window_end IS NOT NULL
      AND window_end > window_start
    )
  )
);

ALTER TABLE ${schema}.checkpoint_runs
  ADD COLUMN IF NOT EXISTS from_finalization_id_exclusive BIGINT,
  ADD COLUMN IF NOT EXISTS to_finalization_id_inclusive BIGINT;

UPDATE ${schema}.checkpoint_runs
   SET from_finalization_id_exclusive = COALESCE(
         from_finalization_id_exclusive,
         substring(checkpoint_key FROM 'finalization:([0-9]+)-')::bigint,
         0
       ),
       to_finalization_id_inclusive = COALESCE(
         to_finalization_id_inclusive,
         substring(checkpoint_key FROM '-([0-9]+)$')::bigint
       )
 WHERE from_finalization_id_exclusive IS NULL
    OR to_finalization_id_inclusive IS NULL;

ALTER TABLE ${schema}.checkpoint_runs
  ALTER COLUMN from_finalization_id_exclusive SET DEFAULT 0;

ALTER TABLE ${schema}.checkpoint_runs
  ALTER COLUMN from_finalization_id_exclusive SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.checkpoint_runs'::regclass
       AND conname = 'checkpoint_runs_from_finalization_nonnegative_check'
  ) THEN
    ALTER TABLE ${schema}.checkpoint_runs
      ADD CONSTRAINT checkpoint_runs_from_finalization_nonnegative_check
      CHECK (from_finalization_id_exclusive >= 0)
      NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.checkpoint_runs'::regclass
       AND conname = 'checkpoint_runs_finalization_range_order_check'
  ) THEN
    ALTER TABLE ${schema}.checkpoint_runs
      ADD CONSTRAINT checkpoint_runs_finalization_range_order_check
      CHECK (
        to_finalization_id_inclusive IS NULL
        OR to_finalization_id_inclusive > from_finalization_id_exclusive
      )
      NOT VALID;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoint_runs_identity
  ON ${schema}.checkpoint_runs (tenant_id, scope_id, checkpoint_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoint_runs_scope_range
  ON ${schema}.checkpoint_runs (
    tenant_id, scope_id, from_finalization_id_exclusive, to_finalization_id_inclusive
  )
  WHERE to_finalization_id_inclusive IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoint_runs_tenant_row
  ON ${schema}.checkpoint_runs (tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_checkpoint_runs_status
  ON ${schema}.checkpoint_runs (tenant_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_checkpoint_runs_scope_window
  ON ${schema}.checkpoint_runs (tenant_id, scope_id, window_end DESC, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_checkpoint_runs_scope_finalization_range
  ON ${schema}.checkpoint_runs (
    tenant_id, scope_id, from_finalization_id_exclusive, to_finalization_id_inclusive, status
  )
  WHERE to_finalization_id_inclusive IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.checkpoint_runs'::regclass
       AND conname = 'checkpoint_runs_scope_fk'
  ) THEN
    ALTER TABLE ${schema}.checkpoint_runs
      ADD CONSTRAINT checkpoint_runs_scope_fk
      FOREIGN KEY (tenant_id, scope_id)
      REFERENCES ${schema}.scopes (tenant_id, id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$$;

COMMENT ON TABLE ${schema}.checkpoint_runs IS
  'Rolling checkpoint audit ledger. Runs summarize scope-bounded source finalizations without changing serving truth.';

CREATE TABLE IF NOT EXISTS ${schema}.checkpoint_run_sources (
  id               BIGSERIAL    PRIMARY KEY,
  tenant_id        TEXT         NOT NULL DEFAULT 'default',
  checkpoint_run_id BIGINT      NOT NULL,
  finalization_id  BIGINT       NOT NULL,
  source_index     INTEGER      NOT NULL CHECK (source_index >= 0),
  scope_id         BIGINT,
  scope_snapshot   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  session_row_id   BIGINT,
  session_id       TEXT,
  transcript_hash  TEXT,
  summary_row_id   BIGINT,
  finalized_at     TIMESTAMPTZ,
  metadata         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(scope_snapshot) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoint_run_sources_position
  ON ${schema}.checkpoint_run_sources (tenant_id, checkpoint_run_id, source_index);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoint_run_sources_finalization
  ON ${schema}.checkpoint_run_sources (tenant_id, checkpoint_run_id, finalization_id);

CREATE INDEX IF NOT EXISTS idx_checkpoint_run_sources_scope
  ON ${schema}.checkpoint_run_sources (tenant_id, scope_id, finalized_at DESC, id DESC)
  WHERE scope_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_checkpoint_run_sources_lookup
  ON ${schema}.checkpoint_run_sources (tenant_id, finalization_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = '${schema}.checkpoint_run_sources'::regclass
       AND conname = 'checkpoint_run_sources_run_fk'
  ) THEN
    ALTER TABLE ${schema}.checkpoint_run_sources
      ADD CONSTRAINT checkpoint_run_sources_run_fk
      FOREIGN KEY (tenant_id, checkpoint_run_id)
      REFERENCES ${schema}.checkpoint_runs (tenant_id, id)
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
     WHERE conrelid = '${schema}.checkpoint_run_sources'::regclass
       AND conname = 'checkpoint_run_sources_finalization_fk'
  ) THEN
    ALTER TABLE ${schema}.checkpoint_run_sources
      ADD CONSTRAINT checkpoint_run_sources_finalization_fk
      FOREIGN KEY (tenant_id, finalization_id)
      REFERENCES ${schema}.session_finalizations (tenant_id, id)
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
     WHERE conrelid = '${schema}.checkpoint_run_sources'::regclass
       AND conname = 'checkpoint_run_sources_scope_fk'
  ) THEN
    ALTER TABLE ${schema}.checkpoint_run_sources
      ADD CONSTRAINT checkpoint_run_sources_scope_fk
      FOREIGN KEY (tenant_id, scope_id)
      REFERENCES ${schema}.scopes (tenant_id, id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$$;

COMMENT ON TABLE ${schema}.checkpoint_run_sources IS
  'Per-checkpoint source lineage. Each row captures the finalization input used to build a rolling checkpoint.';
