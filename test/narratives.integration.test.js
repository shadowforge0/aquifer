'use strict';

// P2-2a — aq.narratives.* integration tests against real Postgres.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('narratives integration tests');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

if (DB_URL) {
describe('aq.narratives capability', () => {
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

  it('rejects input without agentId or text', async () => {
    const r1 = await aquifer.narratives.upsertSnapshot({ text: 'x' });
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'AQ_INVALID_INPUT');

    const r2 = await aquifer.narratives.upsertSnapshot({ agentId: 'main' });
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'AQ_INVALID_INPUT');
  });

  it('upsertSnapshot creates first active narrative', async () => {
    const r = await aquifer.narratives.upsertSnapshot({
      agentId: 'main',
      text: 'first snapshot',
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.narrative.status, 'active');
    assert.equal(r.data.narrative.text, 'first snapshot');
    assert.equal(r.data.supersededNarrativeId, null);
  });

  it('upsertSnapshot supersedes prior active and links chain', async () => {
    const first = await aquifer.narratives.getLatest({ agentId: 'main' });
    assert.ok(first.data.narrative);
    const firstId = first.data.narrative.id;

    const r = await aquifer.narratives.upsertSnapshot({
      agentId: 'main',
      text: 'second snapshot',
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.supersededNarrativeId, firstId);

    const { rows } = await pool.query(
      `SELECT id, status, superseded_by_narrative_id
         FROM ${schema}.narratives WHERE id = $1`,
      [firstId],
    );
    assert.equal(rows[0].status, 'superseded');
    assert.equal(Number(rows[0].superseded_by_narrative_id), r.data.narrative.id);
  });

  it('upsertSnapshot with same idempotencyKey is a no-op returning prior row', async () => {
    const key = `idem-${crypto.randomBytes(4).toString('hex')}`;
    const r1 = await aquifer.narratives.upsertSnapshot({
      agentId: 'main', text: 'idem 1', idempotencyKey: key,
    });
    const r2 = await aquifer.narratives.upsertSnapshot({
      agentId: 'main', text: 'idem 2 (ignored)', idempotencyKey: key,
    });
    assert.equal(r1.data.narrative.id, r2.data.narrative.id);
    assert.equal(r2.data.supersededNarrativeId, null);
    assert.equal(r2.data.narrative.text, 'idem 1');
  });

  it('getLatest returns null when no active exists for scope', async () => {
    const r = await aquifer.narratives.getLatest({
      agentId: 'main', scope: 'project', scopeKey: 'nope',
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.narrative, null);
  });

  it('listHistory returns rows ordered by effective_at desc', async () => {
    // Reset for a clean scope.
    await pool.query(`DELETE FROM ${schema}.narratives WHERE scope_key = 'history-test'`);
    for (const t of ['n-1', 'n-2', 'n-3']) {
      await aquifer.narratives.upsertSnapshot({
        agentId: 'main', scopeKey: 'history-test', text: t,
      });
    }
    const r = await aquifer.narratives.listHistory({
      agentId: 'main', scopeKey: 'history-test',
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.rows.length, 3);
    assert.equal(r.data.rows[0].text, 'n-3');
    assert.equal(r.data.rows[2].text, 'n-1');
  });

  it('scope isolation — same scopeKey different scope produces independent actives', async () => {
    await aquifer.narratives.upsertSnapshot({
      agentId: 'main', scope: 'workspace', scopeKey: 'iso', text: 'ws',
    });
    await aquifer.narratives.upsertSnapshot({
      agentId: 'main', scope: 'project', scopeKey: 'iso', text: 'proj',
    });
    const ws = await aquifer.narratives.getLatest({
      agentId: 'main', scope: 'workspace', scopeKey: 'iso',
    });
    const proj = await aquifer.narratives.getLatest({
      agentId: 'main', scope: 'project', scopeKey: 'iso',
    });
    assert.equal(ws.data.narrative.text, 'ws');
    assert.equal(proj.data.narrative.text, 'proj');
  });
});
}
