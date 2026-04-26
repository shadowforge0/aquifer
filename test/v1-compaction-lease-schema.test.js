'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAquifer } = require('../core/aquifer');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '012-v1-compaction-lease.sql'),
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

describe('schema/012-v1-compaction-lease.sql', () => {
  it('adds DB-time lease expiry and reclaim audit fields to compaction_runs', () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS reclaimed_at TIMESTAMPTZ/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS reclaimed_by_worker_id TEXT/);
    assert.match(SQL, /lease_expires_at = claimed_at \+ interval '600 seconds'/);
  });

  it('requires applying rows to carry a valid lease expiry', () => {
    assert.match(SQL, /compaction_runs_applying_lease_check/);
    assert.match(SQL, /status <> 'applying'/);
    assert.match(SQL, /lease_expires_at IS NOT NULL/);
    assert.match(SQL, /lease_expires_at > claimed_at/);
  });

  it('adds a reclaim-support index aligned with the claim window filters', () => {
    assert.match(SQL, /idx_compaction_runs_claim_lease/);
    assert.match(SQL, /tenant_id, cadence, period_start, period_end, policy_version, lease_expires_at/);
    assert.match(SQL, /WHERE status = 'applying'/);
  });

  it('migrate() runs 012-v1-compaction-lease.sql with substituted schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1lease' });
    await aq.migrate();
    const hit = pool.queries.find(q =>
      q.sql.includes('"v1lease".compaction_runs') &&
      q.sql.includes('idx_compaction_runs_claim_lease'));
    assert.ok(hit, 'expected 012-v1-compaction-lease DDL to run');
  });

  it('listPendingMigrations reports 012-v1-compaction-lease when lease_expires_at is missing', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1leasepending' });
    const plan = await aq.listPendingMigrations();
    assert.ok(plan.required.includes('012-v1-compaction-lease'));
    assert.ok(plan.pending.includes('012-v1-compaction-lease'));
  });
});
