'use strict';

// P2-2c — aq.decisions.* integration tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('decisions integration tests');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

if (DB_URL) {
describe('aq.decisions capability', () => {
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

  it('rejects append without required fields', async () => {
    const r = await aquifer.decisions.append({ agentId: 'main', sessionId: 's' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('rejects invalid status', async () => {
    const r = await aquifer.decisions.append({
      agentId: 'main', sessionId: 's',
      payload: { decision: 'x', status: 'maybe' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('rejects payload without decision text', async () => {
    const r = await aquifer.decisions.append({
      agentId: 'main', sessionId: 's',
      payload: { reason: 'just because' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('append stores decision and returns envelope', async () => {
    const r = await aquifer.decisions.append({
      agentId: 'main', sessionId: 'sess-1',
      payload: {
        decision: 'use Aquifer envelope',
        reason: 'strict error model',
        status: 'committed',
      },
    });
    assert.equal(r.ok, true);
    assert.ok(Number.isInteger(r.data.decisionId));
    assert.equal(r.data.payload.decision, 'use Aquifer envelope');
  });

  it('idempotencyKey replay returns existing decisionId', async () => {
    const key = `dec-${crypto.randomBytes(4).toString('hex')}`;
    const r1 = await aquifer.decisions.append({
      agentId: 'main', sessionId: 's', idempotencyKey: key,
      payload: { decision: 'first', status: 'committed' },
    });
    const r2 = await aquifer.decisions.append({
      agentId: 'main', sessionId: 's', idempotencyKey: key,
      payload: { decision: 'second (ignored)', status: 'committed' },
    });
    assert.equal(r1.data.decisionId, r2.data.decisionId);
    assert.equal(r2.data.payload.decision, 'first');
  });

  it('list filters by status', async () => {
    await aquifer.decisions.append({
      agentId: 'filter', sessionId: 's1',
      payload: { decision: 'a', status: 'proposed' },
    });
    await aquifer.decisions.append({
      agentId: 'filter', sessionId: 's2',
      payload: { decision: 'b', status: 'committed' },
    });
    const r = await aquifer.decisions.list({
      agentId: 'filter', statuses: ['committed'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.rows.length, 1);
    assert.equal(r.data.rows[0].status, 'committed');
  });

  it('list filters by sessionId', async () => {
    const r = await aquifer.decisions.list({ agentId: 'filter', sessionId: 's1' });
    assert.equal(r.ok, true);
    assert.equal(r.data.rows.length, 1);
    assert.equal(r.data.rows[0].sessionId, 's1');
  });

  it('list orders by decided_at desc', async () => {
    const r = await aquifer.decisions.list({ agentId: 'filter' });
    assert.equal(r.ok, true);
    const times = r.data.rows.map(x => new Date(x.decidedAt).getTime());
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1] >= times[i], 'not desc');
    }
  });
});
}
