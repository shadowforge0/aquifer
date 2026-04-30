'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionCheckpoints } = require('../core/session-checkpoints');

function makePool() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (String(sql).includes('FROM "aq".checkpoint_runs c')) {
        return {
          rows: [{
            id: 21,
            checkpoint_key: 'scope-window-1',
            status: 'finalized',
            scope_id: 7,
            scope_kind: 'project',
            scope_key: 'project:aquifer',
            from_finalization_id_exclusive: 10,
            to_finalization_id_inclusive: 14,
            checkpoint_text: 'Checkpoint captured Aquifer release state.',
            checkpoint_payload: {
              triggerKind: 'boundary',
              topicKey: 'release',
              structuredSummary: {
                decisions: [{ decision: 'Checkpoint stays process material.' }],
              },
            },
            metadata: {},
            finalized_at: '2026-04-29T00:00:00.000Z',
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

describe('session checkpoint service', () => {
  it('lists finalized checkpoint runs for handoff by active scope path', async () => {
    const pool = makePool();
    const checkpoints = createSessionCheckpoints({
      pool,
      schema: 'aq',
      defaultTenantId: 'default',
    });

    const rows = await checkpoints.listForHandoff({
      activeScopePath: ['global', 'workspace:/home/mingko', 'project:aquifer'],
      limit: 4,
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].scopeKey, 'project:aquifer');
    assert.equal(rows[0].fromFinalizationIdExclusive, 10);
    assert.equal(rows[0].toFinalizationIdInclusive, 14);
    assert.equal(rows[0].summaryText, 'Checkpoint captured Aquifer release state.');
    assert.equal(rows[0].triggerKind, 'boundary');
    assert.equal(rows[0].structuredSummary.decisions[0].decision, 'Checkpoint stays process material.');
    assert.deepEqual(pool.queries[0].params, [
      'default',
      'finalized',
      ['global', 'workspace:/home/mingko', 'project:aquifer'],
      4,
    ]);
    assert.match(pool.queries[0].sql, /JOIN "aq"\.scopes/);
  });
});
