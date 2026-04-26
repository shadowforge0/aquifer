'use strict';

// P3-b — aq.bundles.* integration tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('bundles integration tests');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

async function seedSession(pool, schema, sessionId, agentId = 'main') {
  const { rows } = await pool.query(
    `INSERT INTO ${schema}.sessions (tenant_id, session_id, agent_id, source)
     VALUES ('default', $1, $2, 'test')
     RETURNING id`,
    [sessionId, agentId],
  );
  return rows[0].id;
}

if (DB_URL) {
describe('aq.bundles capability', () => {
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

  it('export returns AQ_NOT_FOUND for unknown session', async () => {
    const r = await aquifer.bundles.export({ sessionId: 'ghost' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_NOT_FOUND');
  });

  it('export packages narratives + timeline + decisions for a session', async () => {
    await seedSession(pool, schema, 'sess-exp');
    await aquifer.narratives.upsertSnapshot({
      agentId: 'main', sourceSessionId: 'sess-exp',
      scope: 'agent', scopeKey: 'main',
      text: 'the story so far',
    });
    await aquifer.timeline.append({
      agentId: 'main', sessionId: 'sess-exp',
      occurredAt: '2026-04-19T09:00:00Z',
      source: 'test', category: 'focus', text: 'shipping',
    });
    await aquifer.decisions.append({
      agentId: 'main', sessionId: 'sess-exp',
      payload: { decision: 'use envelope', status: 'committed' },
    });

    const r = await aquifer.bundles.export({ sessionId: 'sess-exp' });
    assert.equal(r.ok, true);
    assert.equal(r.data.bundle.bundleVersion, 1);
    assert.equal(r.data.bundle.session.session_id, 'sess-exp');
    assert.equal(r.data.bundle.narratives.length, 1);
    assert.equal(r.data.bundle.timeline.length, 1);
    assert.equal(r.data.bundle.decisions.length, 1);
    assert.ok(r.data.bundle.stamps.length >= 1);
  });

  function cloneBundleForNewSession(bundle, newSessionId) {
    const cloned = JSON.parse(JSON.stringify(bundle));
    cloned.session.session_id = newSessionId;
    // Operators importing into a fresh session rewrite idempotency_keys
    // (not strip) so collisions with the source tenant are avoided but the
    // imported rows stay individually dedup-able for future replays.
    // Narratives also need scope_key rewritten because the partial unique
    // index enforces one active row per (tenant,agent,scope,key).
    for (const bucket of ['narratives', 'timeline', 'handoffs', 'states', 'decisions', 'artifacts']) {
      if (cloned[bucket]) {
        cloned[bucket] = cloned[bucket].map(r => {
          const copy = { ...r };
          copy.idempotency_key = `${newSessionId}:${r.idempotency_key || crypto.randomUUID()}`;
          if ('source_session_id' in copy) copy.source_session_id = newSessionId;
          return copy;
        });
      }
    }
    if (cloned.narratives) {
      cloned.narratives = cloned.narratives.map(n => ({
        ...n, scope_key: `${n.scope_key}:${newSessionId}`,
      }));
    }
    return cloned;
  }

  it('import dry-run reports wouldCreate without touching DB', async () => {
    const exp = await aquifer.bundles.export({ sessionId: 'sess-exp' });
    const bundle = cloneBundleForNewSession(exp.data.bundle, 'sess-import-dry');
    const r = await aquifer.bundles.import({ bundle, mode: 'dry-run' });
    assert.equal(r.ok, true);
    assert.equal(r.data.mode, 'dry-run');
    assert.equal(r.data.wouldCreate.session, 1);
    assert.equal(r.data.wouldCreate.narratives, 1);
    assert.equal(r.data.wouldCreate.timeline, 1);
    assert.equal(r.data.wouldCreate.decisions, 1);

    // Verify nothing actually landed.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.sessions WHERE session_id = 'sess-import-dry'`,
    );
    assert.equal(rows[0].n, 0);
  });

  it('import apply creates new session + children', async () => {
    const exp = await aquifer.bundles.export({ sessionId: 'sess-exp' });
    const bundle = cloneBundleForNewSession(exp.data.bundle, 'sess-import-apply');
    const r = await aquifer.bundles.import({ bundle, mode: 'apply' });
    assert.equal(r.ok, true);
    assert.equal(r.data.mode, 'apply');
    assert.equal(r.data.created.session, 1);
    assert.equal(r.data.created.narratives, 1);
    assert.equal(r.data.created.decisions, 1);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schema}.decisions WHERE source_session_id = 'sess-import-apply'`,
    );
    assert.equal(rows[0].n, 1);
  });

  it('import with conflictPolicy=fail aborts on collision', async () => {
    const exp = await aquifer.bundles.export({ sessionId: 'sess-import-apply' });
    // Same bundle, same idempotency_keys → will collide.
    const r = await aquifer.bundles.import({
      bundle: exp.data.bundle, mode: 'apply', conflictPolicy: 'fail',
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_IMPORT_CONFLICT');
  });

  it('import with conflictPolicy=skip reports conflicts without error', async () => {
    const exp = await aquifer.bundles.export({ sessionId: 'sess-import-apply' });
    const r = await aquifer.bundles.import({
      bundle: exp.data.bundle, mode: 'apply', conflictPolicy: 'skip',
    });
    assert.equal(r.ok, true);
    assert.ok(r.data.conflicts.length >= 1);
    assert.equal(r.data.created.decisions, 0);
  });

  it('diff detects added / removed / modified across bundles', async () => {
    const expA = await aquifer.bundles.export({ sessionId: 'sess-exp' });
    const left = expA.data.bundle;
    // Right = same bundle but one extra timeline event + one narrative modified text.
    const right = JSON.parse(JSON.stringify(left));
    right.timeline.push({
      idempotency_key: 'evt-added',
      occurred_at: '2026-04-19T10:00:00Z',
      source: 'test', category: 'todo', text: 'new one',
      metadata: {},
    });
    if (right.narratives[0]) right.narratives[0].text = 'the story changed';

    const r = aquifer.bundles.diff({ left, right });
    assert.equal(r.ok, true);
    const adds = r.data.changes.filter(c => c.change === 'added');
    const mods = r.data.changes.filter(c => c.change === 'modified');
    assert.ok(adds.some(c => c.entity === 'timeline' && c.key === 'evt-added'));
    assert.ok(mods.some(c => c.entity === 'narrative'));
  });

  it('export respects include filter', async () => {
    const r = await aquifer.bundles.export({
      sessionId: 'sess-exp', include: ['timeline'],
    });
    assert.equal(r.ok, true);
    assert.ok(r.data.bundle.timeline);
    assert.equal(r.data.bundle.narratives, undefined);
    assert.equal(r.data.bundle.decisions, undefined);
  });
});
}
