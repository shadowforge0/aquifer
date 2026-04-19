'use strict';

// P2-2a — aq.timeline.* integration tests against real Postgres.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping timeline integration tests.');
  process.exit(0);
}

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

describe('aq.timeline capability', () => {
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

  it('rejects append without required fields', async () => {
    const r = await aquifer.timeline.append({
      agentId: 'main', source: 'cli', category: 'focus',
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('append stores event and returns envelope', async () => {
    const r = await aquifer.timeline.append({
      agentId: 'main',
      occurredAt: '2026-04-19T09:00:00Z',
      source: 'cli',
      category: 'focus',
      text: 'pushed v1.2.1',
    });
    assert.equal(r.ok, true);
    assert.ok(Number.isInteger(r.data.eventId));
    assert.equal(r.data.event.category, 'focus');
    assert.equal(r.data.event.text, 'pushed v1.2.1');
  });

  it('duplicate idempotencyKey returns existing row without error', async () => {
    const key = `evt-${crypto.randomBytes(4).toString('hex')}`;
    const r1 = await aquifer.timeline.append({
      agentId: 'main',
      occurredAt: '2026-04-19T10:00:00Z',
      source: 'cli', category: 'mood', text: 'chill',
      idempotencyKey: key,
    });
    const r2 = await aquifer.timeline.append({
      agentId: 'main',
      occurredAt: '2026-04-19T10:00:00Z',
      source: 'cli', category: 'mood', text: 'chill (dup)',
      idempotencyKey: key,
    });
    assert.equal(r1.data.eventId, r2.data.eventId);
    assert.equal(r2.data.event.text, 'chill');
  });

  it('list filters by category', async () => {
    await aquifer.timeline.append({
      agentId: 'listagent', occurredAt: '2026-04-19T11:00:00Z',
      source: 'cli', category: 'todo', text: 'do thing 1',
    });
    await aquifer.timeline.append({
      agentId: 'listagent', occurredAt: '2026-04-19T12:00:00Z',
      source: 'cli', category: 'focus', text: 'shipping',
    });
    const r = await aquifer.timeline.list({
      agentId: 'listagent', categories: ['todo'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.rows.length, 1);
    assert.equal(r.data.rows[0].category, 'todo');
  });

  it('list filters by since/until range', async () => {
    const r = await aquifer.timeline.list({
      agentId: 'listagent',
      since: '2026-04-19T11:30:00Z',
      until: '2026-04-19T12:30:00Z',
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.rows.length, 1);
    assert.equal(r.data.rows[0].category, 'focus');
  });

  it('list orders by occurred_at desc', async () => {
    const r = await aquifer.timeline.list({ agentId: 'listagent' });
    assert.equal(r.ok, true);
    const times = r.data.rows.map(x => new Date(x.occurredAt).getTime());
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1] >= times[i], 'not desc');
    }
  });
});
