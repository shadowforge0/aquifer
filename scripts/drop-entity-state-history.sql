-- DROP-clean script for entity_state_history (Q3 bitter-lesson escape hatch).
--
-- Run this if you decide native long-context / agentic memory has obviated the
-- temporal state-change layer. Removes the table and all dependent indexes;
-- nothing else in Aquifer references it directly (FK is one-way: this table
-- references entities/sessions, not the reverse).
--
-- Usage:
--   psql $DATABASE_URL -v schema=miranda -f scripts/drop-entity-state-history.sql

DROP TABLE IF EXISTS :"schema".entity_state_history CASCADE;

-- Verify nothing remains.
SELECT to_regclass(:'schema' || '.entity_state_history') AS table_after_drop;
SELECT to_regclass(:'schema' || '.idx_entity_state_history_current') AS idx_current_after_drop;
SELECT to_regclass(:'schema' || '.idx_entity_state_history_idempotency') AS idx_idempotency_after_drop;
-- All three should report NULL.
