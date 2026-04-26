'use strict';

// Regression lock for the ended_at pollution bug discovered on 2026-04-20:
// upsertSession used to write `ended_at = now()` on every commit, which
// collapsed backfilled sessions' ended_at to backfill time instead of
// keeping the true last-message timestamp. Fix: ended_at is derived from
// lastMessageAt (caller-supplied) and only advances when a new lastMessageAt
// is provided.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('session ended_at integration tests');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

if (DB_URL) {
describe('upsertSession ended_at behaviour', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;

  before(async () => {
    pool = new Pool({ connectionString: DB_URL });
    aquifer = createAquifer({
      db: DB_URL, schema, tenantId: 'default',
      embed: { fn: async () => [[0]], dim: 1 },
    });
    await aquifer.ensureMigrated();
  });

  after(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch {}
    await aquifer.close?.().catch(() => {});
    await pool.end().catch(() => {});
  });

  it('first commit: ended_at equals supplied lastMessageAt (not now())', async () => {
    const sid = `sess-${crypto.randomBytes(3).toString('hex')}`;
    const lastMsg = new Date('2026-03-04T12:34:56Z');
    await aquifer.commit(sid, [{ role: 'user', content: 'hi' }], {
      agentId: 'main',
      startedAt: lastMsg,
      lastMessageAt: lastMsg,
    });
    const { rows } = await pool.query(
      `SELECT started_at, ended_at, last_message_at FROM ${schema}.sessions WHERE session_id = $1`, [sid]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ended_at.toISOString(), lastMsg.toISOString(), 'ended_at must equal lastMessageAt on insert');
    assert.equal(rows[0].last_message_at.toISOString(), lastMsg.toISOString());
  });

  it('re-commit with newer lastMessageAt advances ended_at', async () => {
    const sid = `sess-${crypto.randomBytes(3).toString('hex')}`;
    const t1 = new Date('2026-03-04T12:00:00Z');
    const t2 = new Date('2026-03-04T18:00:00Z');
    await aquifer.commit(sid, [{ role: 'user', content: 'hi' }], {
      agentId: 'main', startedAt: t1, lastMessageAt: t1,
    });
    await aquifer.commit(sid, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }], {
      agentId: 'main', startedAt: t1, lastMessageAt: t2,
    });
    const { rows } = await pool.query(
      `SELECT ended_at FROM ${schema}.sessions WHERE session_id = $1`, [sid]
    );
    assert.equal(rows[0].ended_at.toISOString(), t2.toISOString(), 'ended_at must advance to new lastMessageAt');
  });

  it('re-commit without lastMessageAt does NOT overwrite ended_at with now()', async () => {
    const sid = `sess-${crypto.randomBytes(3).toString('hex')}`;
    const realEnd = new Date('2026-03-04T12:00:00Z');
    await aquifer.commit(sid, [{ role: 'user', content: 'hi' }], {
      agentId: 'main', startedAt: realEnd, lastMessageAt: realEnd,
    });
    // Second commit omits lastMessageAt — this is the bug scenario that
    // used to stamp ended_at = now() and collapse historical sessions.
    await aquifer.commit(sid, [{ role: 'user', content: 'hi' }], {
      agentId: 'main',
    });
    const { rows } = await pool.query(
      `SELECT ended_at FROM ${schema}.sessions WHERE session_id = $1`, [sid]
    );
    assert.equal(rows[0].ended_at.toISOString(), realEnd.toISOString(),
      'ended_at must be preserved when caller omits lastMessageAt');
  });
});
}
