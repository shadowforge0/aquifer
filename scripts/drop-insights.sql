-- DROP-clean script for insights (Q4 bitter-lesson escape hatch).
--
-- Removes the table and all dependent indexes. Nothing else in Aquifer
-- references it directly, so DROP CASCADE is safe and complete.

DROP TABLE IF EXISTS :"schema".insights CASCADE;

-- Verify nothing remains.
SELECT to_regclass(:'schema' || '.insights') AS table_after_drop;
SELECT to_regclass(:'schema' || '.idx_insights_active') AS idx_active_after_drop;
SELECT to_regclass(:'schema' || '.idx_insights_embedding') AS idx_embedding_after_drop;
-- All three should report NULL.
