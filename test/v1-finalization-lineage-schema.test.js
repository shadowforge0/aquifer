'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAquifer } = require('../core/aquifer');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '010-v1-finalization-review.sql'),
  'utf8',
);

function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: typeof sql === 'string' ? sql : '(non-string)', params: params || [] });
      if (typeof sql === 'string' && sql.includes('pg_tables')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
}

describe('schema/010-v1-finalization-review.sql', () => {
  it('adds human review, SessionStart, lineage, and candidate ledger fields', () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS human_review_text TEXT/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS session_start_text TEXT/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS created_by_finalization_id BIGINT/);
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.finalization_candidates/);
    assert.match(SQL, /Per-finalization candidate ledger/);
  });

  it('defines incorrect as a non-serving lifecycle state', () => {
    assert.match(SQL, /memory_records_status_check/);
    assert.match(SQL, /fact_assertions_v1_status_check/);
    assert.match(SQL, /'incorrect'/);
  });

  it('migrate() runs 010-v1-finalization-review.sql with substituted schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1review' });
    await aq.migrate();
    const hit = pool.queries.find(q =>
      q.sql.includes('"v1review".finalization_candidates') &&
      q.sql.includes('CREATE TABLE IF NOT EXISTS "v1review".finalization_candidates'));
    assert.ok(hit, 'expected 010-v1-finalization-review DDL to run');
  });

  it('listPendingMigrations reports 010-v1-finalization-review on a fresh schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1reviewpending' });
    const plan = await aq.listPendingMigrations();
    assert.ok(plan.required.includes('010-v1-finalization-review'));
    assert.ok(plan.pending.includes('010-v1-finalization-review'));
  });
});
