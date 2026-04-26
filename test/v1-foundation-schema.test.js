'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAquifer } = require('../core/aquifer');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '007-v1-foundation.sql'),
  'utf8',
);
const FINALIZATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '008-session-finalizations.sql'),
  'utf8',
);
const ASSERTION_PLANE_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '009-v1-assertion-plane.sql'),
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

describe('schema/007-v1-foundation.sql', () => {
  it('creates the v1 curated-memory foundation tables additively', () => {
    for (const table of ['scopes', 'versions', 'memory_records', 'evidence_refs', 'feedback', 'compaction_runs']) {
      assert.ok(
        SQL.includes(`CREATE TABLE IF NOT EXISTS \${schema}.${table}`),
        `missing additive CREATE TABLE for ${table}`);
    }
  });

  it('uses schema placeholders and does not hardcode a schema', () => {
    assert.ok(SQL.includes('${schema}.memory_records'));
    assert.ok(SQL.includes('${schema}.scopes'));
    assert.doesNotMatch(SQL, /\baquifer\.memory_records\b/);
  });

  it('locks lifecycle and visibility invariants in DDL', () => {
    for (const status of ['active', 'stale', 'superseded', 'revoked', 'tombstoned', 'quarantined', 'archived']) {
      assert.ok(SQL.includes(`'${status}'`), `missing lifecycle status ${status}`);
    }
    assert.match(SQL, /status = 'active'\s+OR \(visible_in_bootstrap = false AND visible_in_recall = false\)/,
      'non-active rows must not remain visible');
    assert.match(SQL, /idx_memory_records_active_canonical/,
      'active canonical partial unique index is required');
  });

  it('keeps the foundation lightweight: no HNSW and no v1 structured facts table yet', () => {
    assert.doesNotMatch(SQL, /\bUSING hnsw\b/i);
    assert.doesNotMatch(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.facts\b/);
    assert.doesNotMatch(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.raw_events\b/);
    assert.doesNotMatch(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.evidence_items\b/);
  });

  it('adds deterministic compaction run ledger without making it a serving source', () => {
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.compaction_runs/);
    assert.match(SQL, /idx_compaction_runs_dedupe/);
    assert.match(SQL, /input_hash/);
    assert.match(SQL, /policy_version/);
  });
});

describe('migration plan includes 007-v1-foundation', () => {
  it('migrate() runs 007-v1-foundation.sql with substituted schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1test' });
    await aq.migrate();
    const hit = pool.queries.find(q =>
      q.sql.includes('"v1test".memory_records') &&
      q.sql.includes('CREATE TABLE IF NOT EXISTS "v1test".memory_records'));
    assert.ok(hit, 'expected 007-v1-foundation DDL to run');
  });

  it('listPendingMigrations reports 007-v1-foundation on a fresh schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1pending' });
    const plan = await aq.listPendingMigrations();
    assert.ok(plan.required.includes('007-v1-foundation'));
    assert.ok(plan.pending.includes('007-v1-foundation'));
  });
});

describe('schema/008-session-finalizations.sql', () => {
  it('creates the finalization ledger additively with lifecycle statuses', () => {
    assert.ok(FINALIZATION_SQL.includes('CREATE TABLE IF NOT EXISTS ${schema}.session_finalizations'));
    for (const status of ['pending', 'processing', 'finalized', 'failed', 'skipped', 'declined', 'deferred']) {
      assert.ok(FINALIZATION_SQL.includes(`'${status}'`), `missing finalization status ${status}`);
    }
    for (const mode of ['handoff', 'session_end', 'session_start_recovery', 'afterburn', 'manual']) {
      assert.ok(FINALIZATION_SQL.includes(`'${mode}'`), `missing finalization mode ${mode}`);
    }
    assert.match(FINALIZATION_SQL, /idx_session_finalizations_identity/);
    assert.match(FINALIZATION_SQL, /DB is source of truth/);
  });

  it('migrate() runs 008-session-finalizations.sql with substituted schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1final' });
    await aq.migrate();
    const hit = pool.queries.find(q =>
      q.sql.includes('"v1final".session_finalizations') &&
      q.sql.includes('CREATE TABLE IF NOT EXISTS "v1final".session_finalizations'));
    assert.ok(hit, 'expected 008-session-finalizations DDL to run');
  });

  it('listPendingMigrations reports 008-session-finalizations on a fresh schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1pendingfinal' });
    const plan = await aq.listPendingMigrations();
    assert.ok(plan.required.includes('008-session-finalizations'));
    assert.ok(plan.pending.includes('008-session-finalizations'));
  });
});

describe('schema/009-v1-assertion-plane.sql', () => {
  it('creates a new fact_assertions_v1 plane instead of repurposing legacy 004 facts', () => {
    assert.match(ASSERTION_PLANE_SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.fact_assertions_v1/);
    assert.match(ASSERTION_PLANE_SQL, /does not reuse legacy 004-facts rows/);
    assert.doesNotMatch(ASSERTION_PLANE_SQL, /ALTER TABLE \$\{schema\}\.facts\b/);
    assert.doesNotMatch(ASSERTION_PLANE_SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.facts\b/);
  });

  it('adds structured assertion fields required by the v1 contract', () => {
    for (const field of [
      'subject_entity_id',
      'predicate',
      'object_kind',
      'object_entity_id',
      'object_value_json',
      'qualifiers_json',
      'observed_at',
      'stale_after',
      'authority',
      'status',
      'assertion_hash',
    ]) {
      assert.match(ASSERTION_PLANE_SQL, new RegExp(`\\b${field}\\b`), `missing ${field}`);
    }
    for (const status of ['candidate', 'active', 'stale', 'superseded', 'revoked', 'tombstoned', 'quarantined', 'archived']) {
      assert.match(ASSERTION_PLANE_SQL, new RegExp(`'${status}'`), `missing assertion status ${status}`);
    }
  });

  it('adds tenant-safe scope guards and memory-record linkage fields additively', () => {
    assert.match(ASSERTION_PLANE_SQL, /CREATE OR REPLACE FUNCTION \$\{schema\}\.scope_parent_tenant_guard/);
    assert.match(ASSERTION_PLANE_SQL, /CREATE TRIGGER trg_scopes_parent_tenant_guard/);
    assert.match(ASSERTION_PLANE_SQL, /idx_scopes_tenant_row/);
    assert.match(ASSERTION_PLANE_SQL, /fact_assertions_v1_scope_tenant_fk/);
    assert.match(ASSERTION_PLANE_SQL, /memory_records_scope_tenant_fk/);
    assert.match(ASSERTION_PLANE_SQL, /ADD COLUMN IF NOT EXISTS backing_fact_id BIGINT/);
    assert.match(ASSERTION_PLANE_SQL, /ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ/);
    assert.match(ASSERTION_PLANE_SQL, /ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ/);
    assert.match(ASSERTION_PLANE_SQL, /ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ/);
    assert.match(ASSERTION_PLANE_SQL, /memory_records_backing_fact_tenant_fk/);
  });

  it('extends compaction_runs with source and output coverage fields', () => {
    assert.match(ASSERTION_PLANE_SQL, /ALTER TABLE \$\{schema\}\.compaction_runs/);
    assert.match(ASSERTION_PLANE_SQL, /ADD COLUMN IF NOT EXISTS source_coverage JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(ASSERTION_PLANE_SQL, /ADD COLUMN IF NOT EXISTS output_coverage JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  });

  it('migrate() runs 009-v1-assertion-plane.sql with substituted schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1assert' });
    await aq.migrate();
    const hit = pool.queries.find(q =>
      q.sql.includes('"v1assert".fact_assertions_v1') &&
      q.sql.includes('CREATE TABLE IF NOT EXISTS "v1assert".fact_assertions_v1'));
    assert.ok(hit, 'expected 009-v1-assertion-plane DDL to run');
  });

  it('listPendingMigrations reports 009-v1-assertion-plane on a fresh schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1pendingassert' });
    const plan = await aq.listPendingMigrations();
    assert.ok(plan.required.includes('009-v1-assertion-plane'));
    assert.ok(plan.pending.includes('009-v1-assertion-plane'));
  });
});
