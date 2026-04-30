'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAquifer } = require('../core/aquifer');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '018-v1-finalization-candidate-envelope.sql'),
  'utf8',
);

function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: typeof sql === 'string' ? sql : '(non-string)', params: params || [] });
      if (typeof sql === 'string' && (sql.includes('pg_tables') || sql.includes('information_schema.columns') || sql.includes('pg_indexes'))) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
}

describe('schema/018-v1-finalization-candidate-envelope.sql', () => {
  it('adds a first-class non-serving candidate envelope to session finalizations', () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS candidate_envelope JSONB/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS candidate_envelope_hash TEXT/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS candidate_envelope_version TEXT/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS coverage JSONB/);
    assert.match(SQL, /producer material, not serving truth/);
  });

  it('adds stable candidate hashes without replacing the position ledger', () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS candidate_hash TEXT/);
    assert.match(SQL, /idx_finalization_candidates_hash/);
    assert.match(SQL, /candidate_index/);
  });

  it('migrate() runs 018-v1-finalization-candidate-envelope.sql with substituted schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1envelope' });
    await aq.migrate();
    const hit = pool.queries.find(q =>
      q.sql.includes('"v1envelope".session_finalizations') &&
      q.sql.includes('candidate_envelope'));
    assert.ok(hit, 'expected 018-v1-finalization-candidate-envelope DDL to run');
  });

  it('listPendingMigrations reports 018-v1-finalization-candidate-envelope on a fresh schema', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'v1envelopepending' });
    const plan = await aq.listPendingMigrations();
    assert.ok(plan.required.includes('018-v1-finalization-candidate-envelope'));
    assert.ok(plan.pending.includes('018-v1-finalization-candidate-envelope'));
  });
});
