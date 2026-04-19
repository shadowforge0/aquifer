'use strict';

// P1 foundation — completion schema migration + AqError/AqResult envelope.
//
// This test is the harness scaffold for later P2 capability suites
// (narratives, consumer_profiles, consolidation phases). It proves three
// things end-to-end against a real Postgres:
//
//   1. migrate() materialises 004-completion.sql (narratives,
//      consumer_profiles tables, sessions.consolidation_phases column,
//      set_updated_at() trigger function).
//   2. narratives active-scope UNIQUE index enforces at-most-one active
//      snapshot per (tenant, agent, scope, scope_key).
//   3. consumer_profiles composite PK + (consumer_id, version, profile_hash)
//      UNIQUE constraint reject duplicate hash within the same version.
//
// AqError/AqResult envelope is covered by test/errors.test.js (pure unit).
//
// Running: AQUIFER_TEST_DB_URL="postgresql://..." node --test test/completion.integration.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping completion integration tests.');
  process.exit(0);
}

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

describe('P1 completion schema', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;

  before(async () => {
    pool = new Pool({ connectionString: DB_URL });
    aquifer = createAquifer({
      db: DB_URL,
      schema,
      tenantId: 'default',
      embed: { fn: async () => [[0]], dim: 1 },
    });
    await aquifer.migrate();
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await aquifer.close();
    await pool.end();
  });

  it('creates narratives table with active-scope unique index', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'narratives'
      ORDER BY ordinal_position
    `, [schema]);
    const cols = rows.map(r => r.column_name);
    for (const c of ['id', 'tenant_id', 'scope', 'scope_key', 'text', 'status',
                     'based_on_fact_ids', 'superseded_by_narrative_id',
                     'effective_at', 'created_at', 'updated_at']) {
      assert.ok(cols.includes(c), `narratives missing column ${c}`);
    }

    const { rows: idxRows } = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = $1 AND tablename = 'narratives'
    `, [schema]);
    const idxNames = idxRows.map(r => r.indexname);
    assert.ok(idxNames.some(n => n === 'idx_narratives_active_scope'),
      'active-scope unique index missing');
  });

  it('creates consumer_profiles with composite PK + hash uniqueness', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'consumer_profiles'
      ORDER BY ordinal_position
    `, [schema]);
    const cols = rows.map(r => r.column_name);
    for (const c of ['tenant_id', 'consumer_id', 'version', 'profile_hash',
                     'profile_json', 'loaded_at', 'deprecated_at']) {
      assert.ok(cols.includes(c), `consumer_profiles missing column ${c}`);
    }

    await pool.query(`
      INSERT INTO ${schema}.consumer_profiles
        (tenant_id, consumer_id, version, profile_hash, profile_json)
      VALUES ('default', 'miranda', 1, 'hash-a', '{}'::jsonb)
    `);
    // Same (consumer_id, version) with different hash must violate unique.
    await assert.rejects(
      () => pool.query(`
        INSERT INTO ${schema}.consumer_profiles
          (tenant_id, consumer_id, version, profile_hash, profile_json)
        VALUES ('default', 'miranda', 1, 'hash-b', '{}'::jsonb)
      `),
      /duplicate key value/,
    );
  });

  it('adds sessions.consolidation_phases JSONB column', async () => {
    const { rows } = await pool.query(`
      SELECT data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'sessions'
        AND column_name = 'consolidation_phases'
    `, [schema]);
    assert.equal(rows.length, 1, 'consolidation_phases column not added');
    assert.equal(rows[0].data_type, 'jsonb');
  });

  it('narratives active-scope unique enforces single active per (tenant,agent,scope,scope_key)', async () => {
    await pool.query(`
      INSERT INTO ${schema}.narratives
        (tenant_id, agent_id, consumer_profile_id, consumer_profile_version,
         consumer_schema_hash, scope, scope_key, text, status)
      VALUES ('default', 'main', 'miranda', 1, 'h1',
              'agent', 'main', 'first active', 'active')
    `);
    // Another 'active' with same scope key must collide.
    await assert.rejects(
      () => pool.query(`
        INSERT INTO ${schema}.narratives
          (tenant_id, agent_id, consumer_profile_id, consumer_profile_version,
           consumer_schema_hash, scope, scope_key, text, status)
        VALUES ('default', 'main', 'miranda', 1, 'h2',
                'agent', 'main', 'second active', 'active')
      `),
      /duplicate key value/,
    );
    // Same key with 'superseded' is fine (partial index WHERE active).
    await pool.query(`
      INSERT INTO ${schema}.narratives
        (tenant_id, agent_id, consumer_profile_id, consumer_profile_version,
         consumer_schema_hash, scope, scope_key, text, status)
      VALUES ('default', 'main', 'miranda', 1, 'h3',
              'agent', 'main', 'archived one', 'superseded')
    `);
  });

  it('set_updated_at trigger bumps updated_at on row modification', async () => {
    const { rows: insertedRows } = await pool.query(`
      INSERT INTO ${schema}.consumer_profiles
        (tenant_id, consumer_id, version, profile_hash, profile_json)
      VALUES ('default', 'trigger-test', 1, 'th1', '{}'::jsonb)
      RETURNING updated_at
    `);
    const originalUpdatedAt = insertedRows[0].updated_at;
    await new Promise(r => setTimeout(r, 10));
    const { rows: bumpedRows } = await pool.query(`
      UPDATE ${schema}.consumer_profiles
      SET profile_json = '{"bumped":true}'::jsonb
      WHERE consumer_id = 'trigger-test' AND version = 1
      RETURNING updated_at
    `);
    assert.ok(bumpedRows[0].updated_at > originalUpdatedAt,
      'updated_at did not advance on UPDATE');
  });
});
