'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAquifer } = require('../core/aquifer');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '014-v1-checkpoint-runs.sql'),
  'utf8',
);

function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: typeof sql === 'string' ? sql : '(non-string)', params: params || [] });
      if (typeof sql === 'string' && sql.includes('pg_tables')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('information_schema.columns')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
}

describe('schema/014-v1-checkpoint-runs.sql', () => {
  it('adds checkpoint ledger tables without creating a serving truth table', () => {
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.checkpoint_runs/);
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.checkpoint_run_sources/);
    assert.match(SQL, /ALTER TABLE \$\{schema\}\.session_finalizations[\s\S]*ADD COLUMN IF NOT EXISTS scope_id BIGINT/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS scope_snapshot JSONB/);
    assert.match(SQL, /Rolling checkpoint audit ledger/);
    assert.doesNotMatch(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.current_memory\b/);
  });

  it('keeps checkpoint rows scope-bound, idempotent, and tenant-safe', () => {
    assert.match(SQL, /idx_checkpoint_runs_identity/);
    assert.match(SQL, /ON \$\{schema\}\.checkpoint_runs \(tenant_id, scope_id, checkpoint_key\)/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS from_finalization_id_exclusive BIGINT/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS to_finalization_id_inclusive BIGINT/);
    assert.match(SQL, /idx_checkpoint_runs_scope_range/);
    assert.match(SQL, /idx_checkpoint_runs_scope_finalization_range/);
    assert.match(SQL, /checkpoint_runs_finalization_range_order_check/);
    assert.match(SQL, /checkpoint_runs_scope_fk/);
    assert.match(SQL, /checkpoint_run_sources_run_fk/);
    assert.match(SQL, /checkpoint_run_sources_finalization_fk/);
    assert.match(SQL, /checkpoint_run_sources_scope_fk/);
    assert.match(SQL, /ON DELETE RESTRICT/);
  });

  it('extends scope kinds for repo and task envelope slots', () => {
    assert.match(SQL, /DROP CONSTRAINT IF EXISTS scopes_scope_kind_check/);
    assert.match(SQL, /'repo'/);
    assert.match(SQL, /'task'/);
  });

  it('migrate() runs 014-v1-checkpoint-runs.sql with substituted schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1checkpoint' });
    await aq.migrate();
    const hit = pool.queries.find(q =>
      q.sql.includes('"v1checkpoint".checkpoint_runs') &&
      q.sql.includes('CREATE TABLE IF NOT EXISTS "v1checkpoint".checkpoint_runs'));
    assert.ok(hit, 'expected 014-v1-checkpoint-runs DDL to run');
  });

  it('listPendingMigrations reports 014-v1-checkpoint-runs on a fresh schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1checkpointpending' });
    const plan = await aq.listPendingMigrations();
    assert.ok(plan.required.includes('014-v1-checkpoint-runs'));
    assert.ok(plan.pending.includes('014-v1-checkpoint-runs'));
  });
});
