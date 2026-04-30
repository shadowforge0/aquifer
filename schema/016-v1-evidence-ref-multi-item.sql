-- Aquifer v1 evidence refs can point at multiple retrieval-grade evidence items
-- Requires: 007-v1-foundation.sql, 015-v1-evidence-items.sql
-- Usage: replace ${schema} with actual schema name

DROP INDEX IF EXISTS ${schema}.idx_evidence_refs_dedupe;

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_refs_source_dedupe
  ON ${schema}.evidence_refs (tenant_id, owner_kind, owner_id, source_kind, source_ref, relation_kind)
  WHERE evidence_item_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_refs_evidence_item_dedupe
  ON ${schema}.evidence_refs (tenant_id, owner_kind, owner_id, evidence_item_id, relation_kind)
  WHERE evidence_item_id IS NOT NULL;

COMMENT ON INDEX ${schema}.idx_evidence_refs_source_dedupe IS
  'Legacy/coarse provenance dedupe for refs that do not yet point at retrieval-grade evidence_items.';

COMMENT ON INDEX ${schema}.idx_evidence_refs_evidence_item_dedupe IS
  'Allows multiple evidence_items for the same owner/source while deduping each typed evidence item link.';
