'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAquifer } = require('../core/aquifer');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '013-v1-compaction-lineage.sql'),
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

describe('schema/013-v1-compaction-lineage.sql', () => {
  it('adds promoted-row lineage back to compaction_runs', () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS created_by_compaction_run_id BIGINT/);
    assert.match(SQL, /idx_memory_records_created_by_compaction_run/);
    assert.match(SQL, /idx_fact_assertions_created_by_compaction_run/);
    assert.match(SQL, /idx_evidence_refs_created_by_compaction_run/);
    assert.match(SQL, /REFERENCES \$\{schema\}\.compaction_runs \(tenant_id, id\)/);
  });

  it('creates an idempotent compaction candidate ledger', () => {
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.compaction_candidates/);
    assert.match(SQL, /candidate_hash\s+TEXT\s+NOT NULL/);
    assert.match(SQL, /source_memory_ids\s+BIGINT\[\]/);
    assert.match(SQL, /source_canonical_keys JSONB/);
    assert.match(SQL, /jsonb_array_length\(source_canonical_keys\) = cardinality\(source_memory_ids\)/);
    assert.match(SQL, /idx_compaction_candidates_position/);
    assert.match(SQL, /idx_compaction_candidates_hash/);
    assert.match(SQL, /idx_compaction_candidates_fact/);
    assert.match(SQL, /idx_compaction_candidates_sources/);
    assert.match(SQL, /compaction_candidates_memory_fk/);
    assert.match(SQL, /compaction_candidates_fact_fk/);
  });

  it('migrate() runs 013-v1-compaction-lineage.sql with substituted schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1lineage' });
    await aq.migrate();
    const hit = pool.queries.find(q =>
      q.sql.includes('"v1lineage".compaction_candidates') &&
      q.sql.includes('idx_compaction_candidates_position'));
    assert.ok(hit, 'expected 013-v1-compaction-lineage DDL to run');
  });

  it('listPendingMigrations reports 013-v1-compaction-lineage when candidate ledger is missing', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1lineagepending' });
    const plan = await aq.listPendingMigrations();
    assert.ok(plan.required.includes('013-v1-compaction-lineage'));
    assert.ok(plan.pending.includes('013-v1-compaction-lineage'));
  });
});
