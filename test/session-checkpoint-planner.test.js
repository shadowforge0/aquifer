'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionCheckpoints } = require('../core/session-checkpoints');

function makePool({ finalizationCount = 3 } = {}) {
  const queries = [];
  const finalizations = Array.from({ length: finalizationCount }, (_, index) => ({
    id: 11 + index,
    tenant_id: 'default',
    session_row_id: 100 + index,
    source: 'codex',
    host: 'codex',
    agent_id: 'main',
    session_id: `session-${index + 1}`,
    transcript_hash: `hash-${index + 1}`,
    phase: 'curated_memory_v1',
    mode: 'handoff',
    status: 'finalized',
    scope_id: 7,
    scope_kind: 'project',
    scope_key: 'project:aquifer',
    scope_snapshot: { scopeKind: 'project', scopeKey: 'project:aquifer' },
    summary_text: `Finalized summary ${index + 1}`,
    structured_summary: {
      decisions: [{ decision: `Decision ${index + 1}` }],
    },
    finalized_at: `2026-04-29T00:0${index}:00.000Z`,
  }));
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      const text = String(sql);
      if (text.includes('FROM "aq".scopes')) {
        return {
          rows: [{
            id: 7,
            tenant_id: 'default',
            scope_kind: 'project',
            scope_key: 'project:aquifer',
            context_key: null,
            topic_key: null,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM "aq".checkpoint_runs') && text.includes('ORDER BY to_finalization_id_inclusive DESC')) {
        return {
          rows: [{
            id: 5,
            tenant_id: 'default',
            scope_id: 7,
            checkpoint_key: 'scope:7:finalization:0-10',
            from_finalization_id_exclusive: 0,
            to_finalization_id_inclusive: 10,
            status: 'finalized',
            checkpoint_text: 'Previous checkpoint',
            checkpoint_payload: {
              coverage: { coordinateSystem: 'checkpoint_finalization_view_v1', coveredUntilChar: 100 },
            },
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM "aq".session_finalizations')) {
        return { rows: finalizations, rowCount: finalizations.length };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

describe('session checkpoint finalization planner', () => {
  it('returns not_ready until the scope has enough uncovered finalized summaries', async () => {
    const pool = makePool({ finalizationCount: 2 });
    const checkpoints = createSessionCheckpoints({
      pool,
      schema: 'aq',
      defaultTenantId: 'default',
    });

    const plan = await checkpoints.planFromFinalizations({
      scopeKey: 'project:aquifer',
      minFinalizations: 3,
    });

    assert.equal(plan.status, 'not_ready');
    assert.equal(plan.due, false);
    assert.equal(plan.sourceFinalizationCount, 2);
    assert.equal(plan.fromFinalizationIdExclusive, 10);
    assert.equal(plan.synthesisInput, undefined);
  });

  it('builds a checkpoint synthesis prompt for the uncovered finalization range', async () => {
    const pool = makePool({ finalizationCount: 3 });
    const checkpoints = createSessionCheckpoints({
      pool,
      schema: 'aq',
      defaultTenantId: 'default',
    });

    const plan = await checkpoints.planFromFinalizations({
      scopeKey: 'project:aquifer',
      minFinalizations: 3,
      includeSynthesisPrompt: true,
    });

    assert.equal(plan.status, 'needs_agent_summary');
    assert.equal(plan.due, true);
    assert.deepEqual(plan.range, {
      fromFinalizationIdExclusive: 10,
      toFinalizationIdInclusive: 13,
    });
    assert.equal(plan.scope.scopeKey, 'project:aquifer');
    assert.equal(plan.synthesisInput.sourceOfTruth, 'finalized_session_summaries');
    assert.equal(plan.synthesisInput.storage.scopeId, 7);
    assert.equal(plan.synthesisInput.coverage.coordinateSystem, 'checkpoint_finalization_view_v1');
    assert.match(plan.synthesisPrompt, /session checkpoint proposal/);
    assert.match(plan.synthesisPrompt, /Finalized summary 1/);
    assert.match(plan.synthesisPrompt, /project:aquifer/);
  });

  it('prepares checkpoint run input from an explicit synthesis summary without applying by default', async () => {
    const pool = makePool({ finalizationCount: 3 });
    const checkpoints = createSessionCheckpoints({
      pool,
      schema: 'aq',
      defaultTenantId: 'default',
    });

    const result = await checkpoints.runProducer({
      scopeKey: 'project:aquifer',
      minFinalizations: 3,
      synthesisSummary: {
        summaryText: 'Checkpoint summary for three finalized sessions.',
        structuredSummary: {
          states: [{ state: 'Checkpoint planner keeps output behind review.' }],
        },
      },
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.run, undefined);
    assert.equal(result.runInput.scopeId, 7);
    assert.equal(result.runInput.status, 'processing');
    assert.equal(result.runInput.fromFinalizationIdExclusive, 10);
    assert.equal(result.runInput.toFinalizationIdInclusive, 13);
    assert.equal(result.runInput.checkpointPayload.promotionGate, 'operator_required');
    assert.equal(result.runInput.checkpointPayload.summaryText, 'Checkpoint summary for three finalized sessions.');
  });
});
