'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recallMemoryRecords } = require('../core/memory-recall');
const { assessCandidate } = require('../core/memory-promotion');
const { createAquifer } = require('../index');

describe('v1 feedback semantics', () => {
  it('feedback can change ranking score without mutating memory truth fields', () => {
    const records = [
      {
        id: 'a',
        memoryType: 'decision',
        canonicalKey: 'decision:a',
        status: 'active',
        visibleInRecall: true,
        authority: 'verified_summary',
        validFrom: '2026-04-01T00:00:00Z',
        summary: 'Use curated memory for recall.',
      },
      {
        id: 'b',
        memoryType: 'decision',
        canonicalKey: 'decision:b',
        status: 'active',
        visibleInRecall: true,
        authority: 'verified_summary',
        validFrom: '2026-04-01T00:00:00Z',
        summary: 'Use curated memory for recall with fallback wording.',
      },
    ];
    const before = JSON.parse(JSON.stringify(records));

    const results = recallMemoryRecords(records, 'curated memory recall', {
      feedbackEvents: [
        { targetId: 'b', feedbackType: 'helpful' },
        { targetId: 'a', feedbackType: 'irrelevant' },
      ],
    });

    assert.equal(results[0].id, 'b');
    assert.deepEqual(records, before, 'feedback ranking must not mutate memory records');
    assert.equal(records[0].authority, 'verified_summary');
    assert.equal(records[0].validFrom, '2026-04-01T00:00:00Z');
  });

  it('feedback cannot promote unsupported or lower-authority conflict candidates', () => {
    const conflictingCandidate = {
      memoryType: 'fact',
      canonicalKey: 'fact:project:aquifer:storage',
      summary: 'Raw transcript should become the source of truth.',
      authority: 'raw_transcript',
      evidenceRefs: [{ sourceKind: 'session', sourceRef: 'session-1' }],
      feedbackEvents: Array.from({ length: 5 }, () => ({ feedbackType: 'helpful' })),
    };

    const result = assessCandidate(conflictingCandidate);
    assert.equal(result.action, 'quarantine');
    assert.notEqual(result.action, 'promote');
  });

  it('public memoryFeedback writes v1 feedback without touching legacy session trust', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (String(sql).startsWith('INSERT INTO "aq".feedback')) {
          return {
            rows: [{
              target_kind: params[1],
              target_id: params[2],
              feedback_type: params[3],
              note: params[7],
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return {
          query: async (sql, params) => {
            queries.push({ sql, params });
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    };
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
    });

    const result = await aq.memoryFeedback('42', {
      feedbackType: 'incorrect',
      agentId: 'main',
      note: 'Wrong project scope.',
    });

    assert.equal(result.target_kind, 'memory_record');
    assert.equal(result.target_id, '42');
    assert.equal(result.feedback_type, 'incorrect');
    assert.equal(result.note, 'Wrong project scope.');
    assert.equal(queries.some(query => String(query.sql).includes('session_summaries')), false);
    assert.equal(queries.some(query => String(query.sql).includes('sessions')), false);
  });
});
