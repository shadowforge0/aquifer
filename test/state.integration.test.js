'use strict';

// P2-2b — aq.state.* integration tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping state integration tests.');
  process.exit(0);
}

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

describe('aq.state capability', () => {
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

  it('rejects write without agentId or payload', async () => {
    const r = await aquifer.state.write({ agentId: 'main' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('first write creates latest row', async () => {
    const r = await aquifer.state.write({
      agentId: 'main',
      payload: {
        goal: 'ship 1.3.0',
        active_work: ['P2-2b'],
        blockers: [],
        affect: { mood: 'focused', energy: 'high' },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.isLatest, true);
    assert.equal(r.data.supersedesStateId, null);
    assert.equal(r.data.payload.goal, 'ship 1.3.0');
  });

  it('second write supersedes first, only one latest remains', async () => {
    const before = await aquifer.state.getLatest({ agentId: 'main' });
    const beforeId = before.data.stateId;

    const r = await aquifer.state.write({
      agentId: 'main',
      payload: { goal: 'ship 1.4.0', active_work: [], blockers: [], affect: {} },
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.supersedesStateId, beforeId);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.session_states
        WHERE agent_id = 'main' AND is_latest = true`,
    );
    assert.equal(rows[0].n, 1, 'more than one latest');
  });

  it('idempotencyKey replay returns existing row unchanged', async () => {
    const key = `state-${crypto.randomBytes(4).toString('hex')}`;
    const r1 = await aquifer.state.write({
      agentId: 'idem', payload: { goal: 'v1' }, idempotencyKey: key,
    });
    const r2 = await aquifer.state.write({
      agentId: 'idem', payload: { goal: 'v2 (ignored)' }, idempotencyKey: key,
    });
    assert.equal(r1.data.stateId, r2.data.stateId);
    assert.equal(r2.data.payload.goal, 'v1');
  });

  it('getLatest returns null when no state exists for scope', async () => {
    const r = await aquifer.state.getLatest({
      agentId: 'nothing', scopeKey: 'nope',
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.state, null);
    assert.equal(r.data.stateId, null);
  });

  it('scope_key isolates state per agent', async () => {
    await aquifer.state.write({
      agentId: 'iso', scopeKey: 'tab-a', payload: { goal: 'A' },
    });
    await aquifer.state.write({
      agentId: 'iso', scopeKey: 'tab-b', payload: { goal: 'B' },
    });
    const a = await aquifer.state.getLatest({ agentId: 'iso', scopeKey: 'tab-a' });
    const b = await aquifer.state.getLatest({ agentId: 'iso', scopeKey: 'tab-b' });
    assert.equal(a.data.state.goal, 'A');
    assert.equal(b.data.state.goal, 'B');
  });
});
