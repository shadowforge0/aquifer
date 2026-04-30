-- Aquifer v1 current-memory semantic recall anchors
-- Requires: 007-v1-foundation.sql
-- Usage: replace ${schema} with actual schema name

ALTER TABLE ${schema}.memory_records
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_memory_records_embedding_hnsw
      ON ${schema}.memory_records USING hnsw (embedding vector_cosine_ops)
      WHERE status = ''active'' AND visible_in_recall = true AND embedding IS NOT NULL';
  EXCEPTION
    WHEN undefined_object THEN
      RAISE WARNING '[aquifer] pgvector HNSW operator class unavailable; memory_records semantic recall will use lexical/coarse anchors until vector index is available';
    WHEN out_of_memory THEN
      RAISE WARNING '[aquifer] HNSW build on memory_records.embedding ran out of memory; raise maintenance_work_mem and re-run migrate()';
    WHEN program_limit_exceeded THEN
      RAISE WARNING '[aquifer] HNSW build on memory_records.embedding exceeded an internal limit; inspect pgvector logs';
  END;
END$$;

COMMENT ON COLUMN ${schema}.memory_records.embedding IS
  'Optional current-memory embedding used by curated semantic/hybrid session_recall. Legacy summaries remain evidence anchors, not current truth.';
