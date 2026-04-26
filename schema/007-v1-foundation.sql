-- Aquifer v1 curated-memory foundation
-- Requires: 001-base.sql applied first
-- Usage: replace ${schema} with actual schema name
--
-- This migration is additive. It creates a sidecar curated-memory plane while
-- leaving the existing 1.5.x sessions/session_summaries/turn_embeddings path
-- untouched. Legacy session tables remain evidence/source material until a
-- later serving-mode switch.

-- =========================================================================
-- Scopes: explicit applicability boundary for curated memory
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.scopes (
  id                 BIGSERIAL    PRIMARY KEY,
  tenant_id          TEXT         NOT NULL DEFAULT 'default',
  scope_kind         TEXT         NOT NULL
                       CHECK (scope_kind IN (
                         'global','user','workspace','project','event','session',
                         'host_runtime','assistant_instance'
                       )),
  scope_key          TEXT         NOT NULL CHECK (btrim(scope_key) <> ''),
  parent_scope_id    BIGINT       REFERENCES ${schema}.scopes(id) ON DELETE SET NULL,
  inheritance_mode   TEXT         NOT NULL DEFAULT 'defaultable'
                       CHECK (inheritance_mode IN ('exclusive','defaultable','additive','non_inheritable')),
  context_key        TEXT,
  topic_key          TEXT,
  metadata           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  active_from        TIMESTAMPTZ,
  active_to          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (active_to IS NULL OR active_from IS NULL OR active_to > active_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scopes_tenant_kind_key
  ON ${schema}.scopes (tenant_id, scope_kind, scope_key);

CREATE INDEX IF NOT EXISTS idx_scopes_parent
  ON ${schema}.scopes (parent_scope_id)
  WHERE parent_scope_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scopes_context_topic
  ON ${schema}.scopes (tenant_id, context_key, topic_key)
  WHERE context_key IS NOT NULL OR topic_key IS NOT NULL;

COMMENT ON TABLE ${schema}.scopes IS
  'v1 curated-memory scope tree. Scope controls applicability; default is not global promotion.';

-- =========================================================================
-- Versions: policy/model/schema provenance for deterministic replay
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.versions (
  id              BIGSERIAL    PRIMARY KEY,
  tenant_id       TEXT         NOT NULL DEFAULT 'default',
  version_kind    TEXT         NOT NULL
                    CHECK (version_kind IN (
                      'schema','normalizer','extractor','promotion_policy',
                      'embedding_model','ranker','bootstrap_policy','recall_policy','other'
                    )),
  version         TEXT         NOT NULL CHECK (btrim(version) <> ''),
  version_hash    TEXT         NOT NULL CHECK (btrim(version_hash) <> ''),
  active          BOOLEAN      NOT NULL DEFAULT false,
  metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  released_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  retired_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (retired_at IS NULL OR retired_at >= released_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_tenant_kind_hash
  ON ${schema}.versions (tenant_id, version_kind, version_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_one_active_per_kind
  ON ${schema}.versions (tenant_id, version_kind)
  WHERE active;

COMMENT ON TABLE ${schema}.versions IS
  'v1 replay metadata for schema, normalizer, extractor, promotion, embedding, ranker, and bootstrap policies.';

-- =========================================================================
-- Memory records: runtime-visible curated memory
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.memory_records (
  id                    BIGSERIAL    PRIMARY KEY,
  tenant_id             TEXT         NOT NULL DEFAULT 'default',
  memory_type           TEXT         NOT NULL
                          CHECK (memory_type IN (
                            'fact','state','decision','preference','constraint',
                            'entity_note','open_loop','conclusion'
                          )),
  canonical_key         TEXT         NOT NULL CHECK (btrim(canonical_key) <> ''),
  scope_id              BIGINT       NOT NULL REFERENCES ${schema}.scopes(id) ON DELETE RESTRICT,
  context_key           TEXT,
  topic_key             TEXT,
  title                 TEXT,
  summary               TEXT         NOT NULL DEFAULT '',
  payload               JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status                TEXT         NOT NULL DEFAULT 'candidate'
                          CHECK (status IN (
                            'candidate','active','stale','superseded','revoked',
                            'tombstoned','quarantined','archived'
                          )),
  authority             TEXT         NOT NULL DEFAULT 'llm_inference'
                          CHECK (authority IN (
                            'user_explicit','executable_evidence','verified_summary',
                            'llm_inference','raw_transcript','manual','system'
                          )),
  accepted_at           TIMESTAMPTZ,
  valid_from            TIMESTAMPTZ,
  valid_to              TIMESTAMPTZ,
  stale_after           TIMESTAMPTZ,
  superseded_by         BIGINT       REFERENCES ${schema}.memory_records(id) ON DELETE SET NULL,
  version_id            BIGINT       REFERENCES ${schema}.versions(id) ON DELETE SET NULL,
  visible_in_bootstrap  BOOLEAN      NOT NULL DEFAULT false,
  visible_in_recall     BOOLEAN      NOT NULL DEFAULT false,
  rank_features         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  search_tsv            TSVECTOR,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  CHECK (
    status = 'active'
    OR (visible_in_bootstrap = false AND visible_in_recall = false)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_records_active_canonical
  ON ${schema}.memory_records (tenant_id, canonical_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_records_scope_bootstrap
  ON ${schema}.memory_records (tenant_id, scope_id, status, visible_in_bootstrap, accepted_at DESC, id)
  WHERE visible_in_bootstrap;

CREATE INDEX IF NOT EXISTS idx_memory_records_scope_recall
  ON ${schema}.memory_records (tenant_id, scope_id, status, visible_in_recall, context_key, topic_key)
  WHERE visible_in_recall;

CREATE INDEX IF NOT EXISTS idx_memory_records_superseded_by
  ON ${schema}.memory_records (superseded_by)
  WHERE superseded_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_records_search_tsv
  ON ${schema}.memory_records USING GIN (search_tsv)
  WHERE visible_in_recall;

CREATE OR REPLACE FUNCTION ${schema}.memory_records_search_tsv_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_tsv :=
    to_tsvector('simple',
      COALESCE(NEW.title, '') || ' ' ||
      COALESCE(NEW.summary, '') || ' ' ||
      COALESCE(NEW.context_key, '') || ' ' ||
      COALESCE(NEW.topic_key, '')
    );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_memory_records_search_tsv
  ON ${schema}.memory_records;

CREATE TRIGGER trg_memory_records_search_tsv
  BEFORE INSERT OR UPDATE OF title, summary, context_key, topic_key
  ON ${schema}.memory_records
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.memory_records_search_tsv_update();

COMMENT ON TABLE ${schema}.memory_records IS
  'v1 curated memory serving source. bootstrap/session_recall read this plane when curated serving mode is enabled.';

-- =========================================================================
-- Evidence refs: provenance links to legacy or future evidence sources
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.evidence_refs (
  id             BIGSERIAL    PRIMARY KEY,
  tenant_id      TEXT         NOT NULL DEFAULT 'default',
  owner_kind     TEXT         NOT NULL
                   CHECK (owner_kind IN ('memory_record','fact','candidate')),
  owner_id       BIGINT       NOT NULL,
  source_kind    TEXT         NOT NULL
                   CHECK (source_kind IN (
                     'session','session_summary','turn_embedding','insight',
                     'entity_state','evidence_item','raw_event','external'
                   )),
  source_ref     TEXT         NOT NULL CHECK (btrim(source_ref) <> ''),
  relation_kind  TEXT         NOT NULL DEFAULT 'supporting'
                   CHECK (relation_kind IN ('primary','supporting','contradicting','derived_from','imported_from')),
  weight         REAL         NOT NULL DEFAULT 1.0 CHECK (weight >= 0),
  metadata       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_refs_dedupe
  ON ${schema}.evidence_refs (tenant_id, owner_kind, owner_id, source_kind, source_ref, relation_kind);

CREATE INDEX IF NOT EXISTS idx_evidence_refs_owner
  ON ${schema}.evidence_refs (tenant_id, owner_kind, owner_id);

CREATE INDEX IF NOT EXISTS idx_evidence_refs_source
  ON ${schema}.evidence_refs (tenant_id, source_kind, source_ref);

COMMENT ON TABLE ${schema}.evidence_refs IS
  'Append-only provenance links. Source may point to legacy sessions today or evidence_items/raw_events later.';

-- =========================================================================
-- Feedback: append-only v1 feedback events, not truth mutation
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.feedback (
  id                 BIGSERIAL    PRIMARY KEY,
  tenant_id          TEXT         NOT NULL DEFAULT 'default',
  target_kind        TEXT         NOT NULL
                       CHECK (target_kind IN ('memory_record','fact','candidate','recall_result','bootstrap','session')),
  target_id          TEXT         NOT NULL CHECK (btrim(target_id) <> ''),
  feedback_type      TEXT         NOT NULL
                       CHECK (feedback_type IN (
                         'helpful','irrelevant','scope_mismatch',
                         'confirm','stale','superseded','incorrect','conflict','expired',
                         'promote','pin','unpin','authority_mismatch','sensitive','archive'
                       )),
  actor_kind         TEXT         NOT NULL DEFAULT 'user'
                       CHECK (actor_kind IN ('user','agent','system','curator')),
  actor_id           TEXT,
  query_fingerprint  TEXT,
  note               TEXT,
  metadata           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_target
  ON ${schema}.feedback (tenant_id, target_kind, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_type
  ON ${schema}.feedback (tenant_id, feedback_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_query
  ON ${schema}.feedback (tenant_id, query_fingerprint)
  WHERE query_fingerprint IS NOT NULL;

COMMENT ON TABLE ${schema}.feedback IS
  'Append-only v1 feedback events. Feedback may affect ranking/review, not memory truth.';

-- =========================================================================
-- Compaction runs: deterministic daily/weekly/monthly consolidation ledger
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.compaction_runs (
  id                 BIGSERIAL    PRIMARY KEY,
  tenant_id          TEXT         NOT NULL DEFAULT 'default',
  cadence            TEXT         NOT NULL CHECK (cadence IN ('session','daily','weekly','monthly','manual')),
  period_start       TIMESTAMPTZ  NOT NULL,
  period_end         TIMESTAMPTZ  NOT NULL,
  input_hash         TEXT         NOT NULL CHECK (btrim(input_hash) <> ''),
  policy_version     TEXT         NOT NULL DEFAULT 'v1',
  status             TEXT         NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','applied','failed','skipped')),
  output             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  error              TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  applied_at         TIMESTAMPTZ,
  CHECK (period_end > period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_runs_dedupe
  ON ${schema}.compaction_runs (tenant_id, cadence, period_start, period_end, input_hash, policy_version);

CREATE INDEX IF NOT EXISTS idx_compaction_runs_status
  ON ${schema}.compaction_runs (tenant_id, cadence, status, period_end DESC);

COMMENT ON TABLE ${schema}.compaction_runs IS
  'v1 deterministic consolidation ledger. Runs record candidates/status updates; they do not bypass promotion policy.';
