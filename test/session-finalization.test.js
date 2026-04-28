'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionFinalization } = require('../core/session-finalization');

function makeFinalizationPool(opts = {}) {
  const queries = [];
  const existingFinalizationStatus = opts.existingFinalizationStatus || null;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (String(sql).includes('FROM "aq".sessions') && String(sql).includes('FOR UPDATE')) {
        return {
          rows: [{
            id: 1,
            tenant_id: 'default',
            session_id: 's1',
            agent_id: 'main',
            source: 'codex',
            model: 'gpt-5.4',
            msg_count: 2,
            user_count: 1,
            assistant_count: 1,
            started_at: '2026-04-26T00:00:00Z',
            ended_at: null,
            last_message_at: '2026-04-26T00:01:00Z',
          }],
        };
      }
      if (String(sql).includes('FROM "aq".session_finalizations')) {
        return {
          rows: existingFinalizationStatus ? [{
            id: 70,
            tenant_id: 'default',
            session_row_id: 1,
            source: 'codex',
            host: 'codex',
            agent_id: 'main',
            session_id: 's1',
            transcript_hash: 'b'.repeat(64),
            phase: 'curated_memory_v1',
            mode: 'session_start_recovery',
            status: existingFinalizationStatus,
            memory_result: { promoted: 0 },
          }] : [],
          rowCount: existingFinalizationStatus ? 1 : 0,
        };
      }
      if (String(sql).includes('INSERT INTO "aq".session_finalizations')) {
        return {
          rows: [{
            id: 70,
            tenant_id: params[0],
            session_row_id: params[1],
            source: params[2],
            host: params[3],
            agent_id: params[4],
            session_id: params[5],
            transcript_hash: params[6],
            phase: params[7],
            mode: params[8],
            status: params[9],
            memory_result: params[16] ? JSON.parse(params[16]) : {},
          }],
        };
      }
      if (String(sql).includes('INSERT INTO "aq".session_summaries')) {
        return { rows: [{ session_row_id: params[0], tenant_id: params[1], agent_id: params[2], session_id: params[3], model: params[4] }] };
      }
      if (String(sql).includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      if (String(sql).includes('SELECT m.*, s.scope_kind')) return { rows: [], rowCount: 0 };
      if (String(sql).includes('SELECT f.*, s.scope_kind')) return { rows: [], rowCount: 0 };
      if (String(sql).includes('INSERT INTO "aq".scopes')) return { rows: [{ id: 11 }], rowCount: 1 };
      if (String(sql).includes('INSERT INTO "aq".fact_assertions_v1')) return { rows: [{ id: 14, assertion_hash: params[18] }], rowCount: 1 };
      if (String(sql).includes('INSERT INTO "aq".memory_records')) return { rows: [{ id: 12 }], rowCount: 1 };
      if (String(sql).includes('INSERT INTO "aq".evidence_refs')) return { rows: [{ id: 13 }], rowCount: 1 };
      if (String(sql).includes('INSERT INTO "aq".finalization_candidates')) return { rows: [{ id: 15 }], rowCount: 1 };
      if (String(sql).includes('UPDATE "aq".sessions')) return { rows: [{ id: 1, processing_status: 'succeeded' }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {
      queries.push({ sql: 'RELEASE', params: [] });
    },
  };
  return {
    queries,
    async connect() {
      queries.push({ sql: 'CONNECT', params: [] });
      return client;
    },
  };
}

describe('session finalization', () => {
  it('writes summary, promotes structured memory, and finalizes in one transaction', async () => {
    const pool = makeFinalizationPool();
    const finalization = createSessionFinalization({
      pool,
      schema: 'aq',
      recordsSchema: '"aq"',
      defaultTenantId: 'default',
    });

    const result = await finalization.finalizeSession({
      sessionId: 's1',
      agentId: 'main',
      source: 'codex',
      transcriptHash: 'b'.repeat(64),
      mode: 'handoff',
      summaryText: 'Aquifer 6B finalization landed.',
      structuredSummary: {
        facts: [{ subject: 'Aquifer', statement: 'Finalization writes through the ledger.' }],
      },
    });

    assert.equal(result.status, 'finalized');
    assert.equal(result.memoryResult.promoted, 1);
    assert.equal(result.memoryResult.candidates, 1);
    assert.match(result.humanReviewText, /已整理進 DB/);
    assert.match(result.sessionStartText, /下一段只需要帶/);
    assert.deepEqual(
      pool.queries.map(query => query.sql).filter(sql => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)),
      ['BEGIN', 'COMMIT'],
    );
    assert.ok(pool.queries.some(query => String(query.sql).includes('INSERT INTO "aq".session_summaries')));
    assert.ok(pool.queries.some(query => String(query.sql).includes('INSERT INTO "aq".fact_assertions_v1')));
    assert.ok(pool.queries.some(query => String(query.sql).includes('INSERT INTO "aq".memory_records')));
    assert.ok(pool.queries.some(query => String(query.sql).includes('INSERT INTO "aq".evidence_refs')));
    assert.ok(pool.queries.some(query => String(query.sql).includes('INSERT INTO "aq".finalization_candidates')));
  });

  it('decorates promoted finalization candidates with producer payload metadata', async () => {
    const pool = makeFinalizationPool();
    const finalization = createSessionFinalization({
      pool,
      schema: 'aq',
      recordsSchema: '"aq"',
      defaultTenantId: 'default',
    });

    const result = await finalization.finalizeSession({
      sessionId: 's1',
      agentId: 'main',
      source: 'codex',
      transcriptHash: 'b'.repeat(64),
      mode: 'handoff',
      summaryText: 'Handoff synthesis output was reviewed.',
      structuredSummary: {
        states: [{ state: 'Handoff synthesis candidates must keep producer lineage.' }],
      },
      candidatePayload: {
        kind: 'handoff_synthesis',
        synthesisKind: 'handoff_current_memory_synthesis_v1',
        promotionGate: 'core_finalization',
      },
    });

    const memoryInsert = pool.queries.find(query => String(query.sql).includes('INSERT INTO "aq".memory_records'));
    const payload = JSON.parse(memoryInsert.params[8]);
    assert.equal(result.memoryResult.promoted, 1);
    assert.equal(payload.kind, 'handoff_synthesis');
    assert.equal(payload.synthesisKind, 'handoff_current_memory_synthesis_v1');
    assert.equal(payload.promotionGate, 'core_finalization');
    assert.equal(payload.state, 'Handoff synthesis candidates must keep producer lineage.');
  });

  it('does not promote or rewrite terminal suppressed finalizations', async () => {
    const pool = makeFinalizationPool({ existingFinalizationStatus: 'declined' });
    const finalization = createSessionFinalization({
      pool,
      schema: 'aq',
      recordsSchema: '"aq"',
      defaultTenantId: 'default',
    });

    const result = await finalization.finalizeSession({
      sessionId: 's1',
      agentId: 'main',
      source: 'codex',
      transcriptHash: 'b'.repeat(64),
      mode: 'session_start_recovery',
      summaryText: 'This should not be promoted.',
      structuredSummary: {
        facts: [{ subject: 'Aquifer', statement: 'Declined recovery must stay declined.' }],
      },
    });

    assert.equal(result.status, 'suppressed');
    assert.equal(result.finalizationStatus, 'declined');
    assert.deepEqual(
      pool.queries.map(query => query.sql).filter(sql => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)),
      ['BEGIN', 'COMMIT'],
    );
    assert.equal(pool.queries.some(query => String(query.sql).includes('INSERT INTO "aq".session_summaries')), false);
    assert.equal(pool.queries.some(query => String(query.sql).includes('INSERT INTO "aq".memory_records')), false);
    assert.equal(pool.queries.some(query => String(query.sql).includes('UPDATE "aq".sessions')), false);
  });
});
