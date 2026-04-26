'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAquifer } = require('../core/aquifer');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '011-v1-compaction-claim.sql'),
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

describe('schema/011-v1-compaction-claim.sql', () => {
  it('adds claim fields and applying lifecycle status to compaction_runs', () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS worker_id TEXT/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS apply_token TEXT/);
    assert.match(SQL, /compaction_runs_status_check/);
    assert.match(SQL, /'applying'/);
    assert.match(SQL, /compaction_runs_applying_claim_check/);
    assert.match(SQL, /status <> 'applying'/);
    assert.match(SQL, /claimed_at IS NOT NULL/);
    assert.match(SQL, /btrim\(worker_id\) <> ''/);
    assert.match(SQL, /btrim\(apply_token\) <> ''/);
  });

  it('limits each tenant/cadence/window/policy to one concurrent applying worker', () => {
    assert.match(SQL, /idx_compaction_runs_one_live_apply/);
    assert.match(SQL, /tenant_id, cadence, period_start, period_end, policy_version/);
    assert.match(SQL, /WHERE status = 'applying'/);
  });

  it('migrate() runs 011-v1-compaction-claim.sql with substituted schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1claim' });
    await aq.migrate();
    const hit = pool.queries.find(q =>
      q.sql.includes('"v1claim".compaction_runs') &&
      q.sql.includes('idx_compaction_runs_one_live_apply'));
    assert.ok(hit, 'expected 011-v1-compaction-claim DDL to run');
  });

  it('listPendingMigrations reports 011-v1-compaction-claim when apply_token is missing', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1claimpending' });
    const plan = await aq.listPendingMigrations();
    assert.ok(plan.required.includes('011-v1-compaction-claim'));
    assert.ok(plan.pending.includes('011-v1-compaction-claim'));
  });
});
