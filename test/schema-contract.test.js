'use strict';

/**
 * Static contract tests for schema SQL files. These guard invariants that
 * can't be expressed as runtime DB queries without reproducing specific
 * failure conditions (pgvector version, memory exhaustion, etc.).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BASE_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '001-base.sql'),
  'utf8'
);

describe('schema/001-base.sql HNSW exception handling', () => {
  // Both HNSW CREATE INDEX statements live in DO $$ BEGIN...EXCEPTION blocks.
  // They must NOTICE (not hard-fail migrate) on known recoverable failures:
  //   - pgvector < 0.5.0 without HNSW support   → 0A000 feature_not_supported
  //   - maintenance_work_mem too low            → 53200 out_of_memory
  //   - build internal limit exceeded           → 54000 program_limit_exceeded
  //
  // `invalid_parameter_value` was REMOVED in 1.5.2 — it used to mask the
  // unsized-vector schema bug. Columns are now sized at CREATE TABLE time
  // (or coerced by the DO block), so HNSW builds directly.
  const REQUIRED_CODES = [
    'feature_not_supported',
    'out_of_memory',
    'program_limit_exceeded',
  ];

  for (const code of REQUIRED_CODES) {
    it(`both HNSW DO blocks handle ${code}`, () => {
      const occurrences = (BASE_SQL.match(new RegExp(code, 'g')) || []).length;
      assert.ok(occurrences >= 2,
        `${code} must appear in at least 2 HNSW DO blocks (summary + turn); found ${occurrences}`);
    });
  }

  it('HNSW DO blocks no longer catch invalid_parameter_value', () => {
    // Grab every DO $$...END$$ block, keep the ones that actually build an
    // HNSW index, then assert none of them catch invalid_parameter_value.
    const doBlocks = BASE_SQL.match(/DO \$\$[\s\S]*?END\$\$;/g) || [];
    const hnswBlocks = doBlocks.filter(b => /hnsw/i.test(b) && /EXCEPTION/.test(b));
    assert.ok(hnswBlocks.length >= 2,
      `expected at least 2 HNSW DO blocks (summary + turn); found ${hnswBlocks.length}`);
    for (const block of hnswBlocks) {
      assert.doesNotMatch(block, /invalid_parameter_value/,
        'HNSW block must not swallow invalid_parameter_value — masks real schema bugs');
    }
  });
});

describe('schema/001-base.sql embedding columns are sized', () => {
  it('session_summaries.embedding declares a dimension', () => {
    assert.match(BASE_SQL, /session_summaries[\s\S]*?\bembedding\s+vector\(\d+\)/,
      'session_summaries.embedding must be vector(N); unsized blocks HNSW');
  });

  it('turn_embeddings.embedding declares a dimension', () => {
    assert.match(BASE_SQL, /turn_embeddings[\s\S]*?\bembedding\s+vector\(\d+\)/,
      'turn_embeddings.embedding must be vector(N); unsized blocks HNSW');
  });

  it('includes coerce blocks for both tables', () => {
    const coerceCount = (BASE_SQL.match(/ALTER COLUMN embedding TYPE vector\(/g) || []).length;
    assert.ok(coerceCount >= 2,
      `expected at least 2 ALTER ... TYPE vector(N) coerce blocks (summary + turn); found ${coerceCount}`);
  });
});

const ENTITIES_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '002-entities.sql'),
  'utf8'
);

describe('schema/002-entities.sql embedding column is sized', () => {
  it('entities.embedding declares a dimension', () => {
    assert.match(ENTITIES_SQL, /\bembedding\s+vector\(\d+\)/,
      'entities.embedding must be vector(N)');
  });

  it('includes a coerce block for pre-1.5.2 unsized columns', () => {
    assert.match(ENTITIES_SQL, /ALTER COLUMN embedding TYPE vector\(/,
      'entities coerce block missing');
  });
});

const INSIGHTS_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '006-insights.sql'),
  'utf8'
);

describe('schema/006-insights.sql embedding column is sized', () => {
  // Regression guard for 1.5.0 → 1.5.1 fix: the `embedding` column was
  // declared as unsized `vector`, which blocks HNSW index creation
  // permanently. The fix declares it `vector(N)` AND keeps an idempotent
  // coerce block for pre-1.5.1 installs that already have unsized columns.

  it('embedding column has an explicit dimension', () => {
    assert.match(INSIGHTS_SQL, /\bembedding\s+vector\(\d+\)/,
      'embedding must be declared as vector(N) with a dimension; unsized `vector` breaks HNSW');
    assert.doesNotMatch(INSIGHTS_SQL, /\bembedding\s+vector\b\s*,/,
      'embedding must not be declared as unsized `vector` (prevents HNSW index creation)');
  });

  it('includes a coerce block for pre-1.5.1 unsized columns', () => {
    assert.match(INSIGHTS_SQL, /ALTER COLUMN embedding TYPE vector\(/,
      'must contain an ALTER COLUMN ... TYPE vector(N) statement to upgrade existing installs');
    assert.match(INSIGHTS_SQL, /format_type\(atttypid, atttypmod\)\s*=\s*'vector'/,
      'coerce block must detect unsized vector via pg_attribute introspection');
  });

  it('HNSW DO block no longer swallows invalid_parameter_value', () => {
    const hnswBlockMatch = INSIGHTS_SQL.match(
      /CREATE INDEX IF NOT EXISTS idx_insights_embedding[\s\S]*?END\$\$/
    );
    assert.ok(hnswBlockMatch, 'could not locate insights HNSW DO block');
    assert.doesNotMatch(hnswBlockMatch[0], /invalid_parameter_value/,
      'HNSW block must not catch invalid_parameter_value — that was masking the schema bug');
  });

  it('adds canonical_key_v2 as a nullable TEXT column via additive migration', () => {
    assert.match(INSIGHTS_SQL,
      /ALTER TABLE \$\{schema\}\.insights\s+ADD COLUMN IF NOT EXISTS canonical_key_v2 TEXT;/,
      'canonical_key_v2 must be added via ALTER TABLE ... ADD COLUMN IF NOT EXISTS');
    assert.doesNotMatch(INSIGHTS_SQL,
      /ADD COLUMN IF NOT EXISTS canonical_key_v2 TEXT\s+NOT NULL/,
      'canonical_key_v2 must remain nullable for legacy rows');
  });

  it('defines a non-unique partial index for active canonical_key_v2 lookups', () => {
    assert.match(INSIGHTS_SQL,
      /CREATE INDEX IF NOT EXISTS idx_insights_canonical_v2_active\s+ON \$\{schema\}\.insights \(tenant_id, agent_id, insight_type, canonical_key_v2, created_at DESC\)\s+WHERE status = 'active' AND canonical_key_v2 IS NOT NULL;/,
      'idx_insights_canonical_v2_active must exist with the expected partial predicate');
    assert.doesNotMatch(INSIGHTS_SQL,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_canonical_v2_active/,
      'idx_insights_canonical_v2_active must not be unique');
  });
});
