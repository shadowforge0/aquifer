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
  //   - empty unsized `vector` column (dim can't be inferred)   → 22023 invalid_parameter_value
  //   - pgvector < 0.5.0 without HNSW support                    → 0A000 feature_not_supported
  //   - maintenance_work_mem too low / memory pressure           → 53200 out_of_memory
  //   - build internal limit exceeded                            → 54000 program_limit_exceeded
  //
  // Permission / connection errors intentionally NOT caught — those should
  // fail migrate() loudly so the operator fixes their environment.
  const REQUIRED_CODES = [
    'invalid_parameter_value',
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
});
