'use strict';

// P2-2b — aq.handoff.* integration tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping handoff integration tests.');
  process.exit(0);
}

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

describe('aq.handoff capability', () => {
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

  it('rejects write without required fields', async () => {
    const r = await aquifer.handoff.write({ agentId: 'main', sessionId: 's1' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('rejects invalid status', async () => {
    const r = await aquifer.handoff.write({
      agentId: 'main', sessionId: 's1',
      payload: { status: 'wip' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('write + getLatest retrieves most recent handoff', async () => {
    await aquifer.handoff.write({
      agentId: 'main', sessionId: 'sess-x',
      payload: {
        status: 'in_progress',
        last_step: 'ship P2-2a',
        next: 'do P2-2b',
        blockers: [], decided: ['use envelope'], open_loops: ['facts diagnosis'],
      },
    });
    const r = await aquifer.handoff.getLatest({
      agentId: 'main', sessionId: 'sess-x',
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.handoff.last_step, 'ship P2-2a');
    assert.deepEqual(r.data.handoff.decided, ['use envelope']);
  });

  it('append-only — every write creates a new row', async () => {
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.session_handoffs WHERE agent_id = 'multi'`,
    );
    for (const step of ['a', 'b', 'c']) {
      await aquifer.handoff.write({
        agentId: 'multi', sessionId: 'sess',
        payload: { status: 'in_progress', last_step: step },
      });
    }
    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.session_handoffs WHERE agent_id = 'multi'`,
    );
    assert.equal(after.rows[0].n - before.rows[0].n, 3);
  });

  it('idempotencyKey replay returns same handoffId', async () => {
    const key = `ho-${crypto.randomBytes(4).toString('hex')}`;
    const r1 = await aquifer.handoff.write({
      agentId: 'idem', sessionId: 's', idempotencyKey: key,
      payload: { status: 'completed', last_step: 'first' },
    });
    const r2 = await aquifer.handoff.write({
      agentId: 'idem', sessionId: 's', idempotencyKey: key,
      payload: { status: 'completed', last_step: 'second' },
    });
    assert.equal(r1.data.handoffId, r2.data.handoffId);
    assert.equal(r2.data.payload.last_step, 'first');
  });

  it('getLatest returns null when no handoff exists', async () => {
    const r = await aquifer.handoff.getLatest({ agentId: 'ghost' });
    assert.equal(r.ok, true);
    assert.equal(r.data.handoff, null);
    assert.equal(r.data.handoffId, null);
  });
});
