'use strict';

// P2-2c — aq.artifacts.* integration tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('artifacts integration tests');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

if (DB_URL) {
describe('aq.artifacts capability', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;

  before(async () => {
    pool = new Pool({ connectionString: DB_URL });
    aquifer = createAquifer({
      db: DB_URL, schema, tenantId: 'default',
      embed: { fn: async () => [[0]], dim: 1 },
    });
    await aquifer.migrate();
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await aquifer.close();
    await pool.end();
  });

  it('rejects record without required fields', async () => {
    const r = await aquifer.artifacts.record({
      agentId: 'main', producerId: 'daily-md', type: 'daily',
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('rejects invalid status', async () => {
    const r = await aquifer.artifacts.record({
      agentId: 'main', producerId: 'daily-md',
      type: 'daily', format: 'md', destination: '/tmp/x.md',
      status: 'nope',
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('record creates pending artifact', async () => {
    const r = await aquifer.artifacts.record({
      agentId: 'main', producerId: 'daily-md',
      type: 'daily', format: 'md',
      destination: '/tmp/2026-04-19.md',
    });
    assert.equal(r.ok, true);
    assert.ok(Number.isInteger(r.data.artifactId));
  });

  it('re-record with same idempotency transitions to produced', async () => {
    const key = `art-${crypto.randomBytes(4).toString('hex')}`;
    await aquifer.artifacts.record({
      agentId: 'main', producerId: 'daily-md',
      type: 'daily', format: 'md', destination: '/tmp/a.md',
      idempotencyKey: key,
    });
    await aquifer.artifacts.record({
      agentId: 'main', producerId: 'daily-md',
      type: 'daily', format: 'md', destination: '/tmp/a.md',
      idempotencyKey: key,
      status: 'produced', contentRef: 'sha256:abc',
    });
    const { rows } = await pool.query(
      `SELECT status, content_ref, produced_at
         FROM ${schema}.artifacts WHERE idempotency_key = $1`,
      [key],
    );
    assert.equal(rows[0].status, 'produced');
    assert.equal(rows[0].content_ref, 'sha256:abc');
    assert.ok(rows[0].produced_at !== null, 'produced_at not set on transition');
  });

  it('list filters by producerId + status', async () => {
    await aquifer.artifacts.record({
      agentId: 'main', producerId: 'weekly-rollup',
      type: 'weekly', format: 'md', destination: '/tmp/w1.md',
      status: 'produced',
    });
    await aquifer.artifacts.record({
      agentId: 'main', producerId: 'weekly-rollup',
      type: 'weekly', format: 'md', destination: '/tmp/w2.md',
      status: 'failed',
    });
    const r = await aquifer.artifacts.list({
      agentId: 'main', producerId: 'weekly-rollup', statuses: ['failed'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.rows.length, 1);
    assert.equal(r.data.rows[0].status, 'failed');
  });

  it('list without filters returns tenant-wide', async () => {
    const r = await aquifer.artifacts.list({});
    assert.equal(r.ok, true);
    assert.ok(r.data.rows.length >= 3);
  });
});
}
