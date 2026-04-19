'use strict';

// P3-a — aq.consolidation.* integration tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping consolidation integration tests.');
  process.exit(0);
}

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

describe('aq.consolidation capability', () => {
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

  it('claimNext returns null when nothing pending', async () => {
    const r = await aquifer.consolidation.claimNext({ workerId: 'w1' });
    assert.equal(r.ok, true);
    assert.equal(r.data.session, null);
    assert.equal(r.data.claimedPhase, null);
  });

  it('claimNext picks first pending phase and marks it claimed', async () => {
    await seedSession(pool, schema, 'sess-1');
    const r = await aquifer.consolidation.claimNext({ workerId: 'w1' });
    assert.equal(r.ok, true);
    assert.equal(r.data.session.sessionId, 'sess-1');
    assert.equal(r.data.claimedPhase, 'summary_extract');
    assert.ok(r.data.claimToken);
    assert.equal(r.data.session.phases.summary_extract.status, 'claimed');
    assert.equal(r.data.session.phases.summary_extract.attempts, 1);
  });

  it('second claim on same session skips already-claimed phase', async () => {
    // Sess-1 summary_extract is already claimed; claimNext should move to next phase.
    const r = await aquifer.consolidation.claimNext({ workerId: 'w2' });
    assert.equal(r.ok, true);
    assert.equal(r.data.claimedPhase, 'entity_extract');
  });

  it('transitionPhase claimed → running respects claimToken', async () => {
    await seedSession(pool, schema, 'sess-2');
    const claim = await aquifer.consolidation.claimNext({
      workerId: 'wA', phases: ['summary_extract'],
    });
    const token = claim.data.claimToken;
    const good = await aquifer.consolidation.transitionPhase({
      sessionId: 'sess-2', phase: 'summary_extract',
      fromStatus: 'claimed', toStatus: 'running', claimToken: token,
    });
    assert.equal(good.ok, true);
    assert.equal(good.data.state.status, 'running');

    // Wrong token should fail.
    const bad = await aquifer.consolidation.transitionPhase({
      sessionId: 'sess-2', phase: 'summary_extract',
      fromStatus: 'running', toStatus: 'succeeded', claimToken: 'wrong-token',
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'AQ_PHASE_CLAIM_CONFLICT');
  });

  it('rejects invalid transition running → claimed without stale', async () => {
    // sess-2 summary_extract is running; caller tries direct → succeeded (ok),
    // then terminal → claimed requires forceReplay.
    const { data: stateR } = await aquifer.consolidation.getState({ sessionId: 'sess-2' });
    const token = stateR.phases.summary_extract.claimToken;
    await aquifer.consolidation.transitionPhase({
      sessionId: 'sess-2', phase: 'summary_extract',
      fromStatus: 'running', toStatus: 'succeeded', claimToken: token,
    });
    const bad = await aquifer.consolidation.transitionPhase({
      sessionId: 'sess-2', phase: 'summary_extract',
      fromStatus: 'succeeded', toStatus: 'claimed',
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'AQ_PHASE_TRANSITION_INVALID');
  });

  it('forceReplay allows terminal → claimed', async () => {
    const r = await aquifer.consolidation.transitionPhase({
      sessionId: 'sess-2', phase: 'summary_extract',
      fromStatus: 'succeeded', toStatus: 'claimed',
      forceReplay: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.state.status, 'claimed');
  });

  it('failed phase can be reclaimed by next worker', async () => {
    await seedSession(pool, schema, 'sess-3');
    const claim = await aquifer.consolidation.claimNext({
      workerId: 'wA', phases: ['summary_extract'],
    });
    const tok = claim.data.claimToken;
    await aquifer.consolidation.transitionPhase({
      sessionId: 'sess-3', phase: 'summary_extract',
      fromStatus: 'claimed', toStatus: 'failed', claimToken: tok,
      error: { code: 'AQ_DEPENDENCY', message: 'llm timeout' },
    });
    const reclaim = await aquifer.consolidation.claimNext({
      workerId: 'wB', phases: ['summary_extract'],
    });
    assert.equal(reclaim.ok, true);
    assert.equal(reclaim.data.session.sessionId, 'sess-3');
    assert.equal(reclaim.data.session.phases.summary_extract.attempts, 2);
  });

  it('getState returns full phases map including defaults', async () => {
    const r = await aquifer.consolidation.getState({ sessionId: 'sess-1' });
    assert.equal(r.ok, true);
    for (const p of ['summary_extract', 'narrative_refresh', 'artifact_dispatch']) {
      assert.ok(r.data.phases[p]);
    }
  });

  it('outputRef merges cleanly across transitions', async () => {
    await seedSession(pool, schema, 'sess-4');
    const claim = await aquifer.consolidation.claimNext({
      workerId: 'wA', phases: ['summary_extract'],
    });
    const tok = claim.data.claimToken;
    await aquifer.consolidation.transitionPhase({
      sessionId: 'sess-4', phase: 'summary_extract',
      fromStatus: 'claimed', toStatus: 'running', claimToken: tok,
      outputRef: { summarySessionRowId: 42 },
    });
    await aquifer.consolidation.transitionPhase({
      sessionId: 'sess-4', phase: 'summary_extract',
      fromStatus: 'running', toStatus: 'succeeded', claimToken: tok,
      outputRef: { factIds: [1, 2, 3] },
    });
    const final = await aquifer.consolidation.getState({ sessionId: 'sess-4' });
    assert.equal(final.data.phases.summary_extract.outputRef.summarySessionRowId, 42);
    assert.deepEqual(final.data.phases.summary_extract.outputRef.factIds, [1, 2, 3]);
  });

  it('getState returns AQ_NOT_FOUND for unknown session', async () => {
    const r = await aquifer.consolidation.getState({ sessionId: 'ghost' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_NOT_FOUND');
  });
});
