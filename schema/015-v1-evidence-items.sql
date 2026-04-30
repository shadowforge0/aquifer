-- Aquifer v1 retrieval-grade evidence items
-- Requires: 001-base.sql, 007-v1-foundation.sql, 008-session-finalizations.sql
-- Usage: replace ${schema} with actual schema name

CREATE TABLE IF NOT EXISTS ${schema}.evidence_items (
  id                         BIGSERIAL    PRIMARY KEY,
  tenant_id                  TEXT         NOT NULL DEFAULT 'default',
  source_kind                TEXT         NOT NULL
                               CHECK (source_kind IN (
                                 'session','session_summary','turn_embedding','insight',
                                 'entity_state','evidence_item','raw_event','external'
                               )),
  source_ref                 TEXT         NOT NULL CHECK (btrim(source_ref) <> ''),
  session_row_id             BIGINT       REFERENCES ${schema}.sessions(id) ON DELETE SET NULL,
  turn_embedding_id          BIGINT       REFERENCES ${schema}.turn_embeddings(id) ON DELETE SET NULL,
  summary_row_id             BIGINT       REFERENCES ${schema}.session_summaries(session_row_id) ON DELETE SET NULL,
  created_by_finalization_id BIGINT       REFERENCES ${schema}.session_finalizations(id) ON DELETE SET NULL,
  excerpt_text               TEXT         NOT NULL CHECK (btrim(excerpt_text) <> ''),
  excerpt_hash               TEXT         NOT NULL CHECK (btrim(excerpt_hash) <> ''),
  embedding                  vector(1024),
  search_tsv                 TSVECTOR,
  metadata                   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_items_dedupe
  ON ${schema}.evidence_items (tenant_id, source_kind, source_ref, excerpt_hash);

CREATE INDEX IF NOT EXISTS idx_evidence_items_source
  ON ${schema}.evidence_items (tenant_id, source_kind, source_ref);

CREATE INDEX IF NOT EXISTS idx_evidence_items_finalization
  ON ${schema}.evidence_items (tenant_id, created_by_finalization_id)
  WHERE created_by_finalization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_items_search_tsv
  ON ${schema}.evidence_items USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS idx_evidence_items_excerpt_trgm
  ON ${schema}.evidence_items USING GIN (excerpt_text gin_trgm_ops);

CREATE OR REPLACE FUNCTION ${schema}.evidence_items_search_tsv_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    NEW.search_tsv := to_tsvector('zhcfg', COALESCE(NEW.excerpt_text, ''));
  EXCEPTION WHEN undefined_object OR undefined_function THEN
    NEW.search_tsv := to_tsvector('simple', COALESCE(NEW.excerpt_text, ''));
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evidence_items_search_tsv
  ON ${schema}.evidence_items;

CREATE TRIGGER trg_evidence_items_search_tsv
  BEFORE INSERT OR UPDATE OF excerpt_text
  ON ${schema}.evidence_items
  FOR EACH ROW
  EXECUTE FUNCTION ${schema}.evidence_items_search_tsv_update();

ALTER TABLE ${schema}.evidence_refs
  ADD COLUMN IF NOT EXISTS evidence_item_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_evidence_refs_evidence_item
  ON ${schema}.evidence_refs (tenant_id, evidence_item_id)
  WHERE evidence_item_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '${schema}.evidence_refs'::regclass
      AND conname = 'evidence_refs_evidence_item_fk'
  ) THEN
    ALTER TABLE ${schema}.evidence_refs
      ADD CONSTRAINT evidence_refs_evidence_item_fk
      FOREIGN KEY (evidence_item_id)
      REFERENCES ${schema}.evidence_items(id)
      ON DELETE SET NULL;
  END IF;
END$$;

COMMENT ON TABLE ${schema}.evidence_items IS
  'Retrieval-grade evidence units. Unlike coarse session_summary refs, these are searchable anchors that can support individual memory_records.';

COMMENT ON COLUMN ${schema}.evidence_refs.evidence_item_id IS
  'Optional typed link to a retrieval-grade evidence item. source_kind/source_ref remain the audit-compatible source identity.';
