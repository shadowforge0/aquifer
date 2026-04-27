'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recallMemoryRecords } = require('../core/memory-recall');

describe('v1 curated recall contract', () => {
  it('raw-only evidence hit returns empty because recall only sees curated memory', () => {
    const rawEvidence = [
      { evidenceId: 'e1', text: 'Use the dangerous raw-only deployment note' },
    ];
    assert.equal(rawEvidence.length, 1, 'fixture sanity check');

    const results = recallMemoryRecords([], 'dangerous raw-only deployment note');
    assert.deepEqual(results, []);
  });

  it('returns active visible curated winner and ignores rejected or hidden records', () => {
    const records = [
      {
        id: 1,
        memoryType: 'decision',
        canonicalKey: 'decision:project:a',
        status: 'candidate',
        visibleInRecall: true,
        summary: 'Use PostgreSQL for curated memory',
        acceptedAt: '2026-04-20T00:00:00Z',
      },
      {
        id: 2,
        memoryType: 'decision',
        canonicalKey: 'decision:project:a',
        status: 'active',
        visibleInRecall: true,
        summary: 'Use PostgreSQL for curated memory',
        acceptedAt: '2026-04-21T00:00:00Z',
      },
      {
        id: 3,
        memoryType: 'decision',
        canonicalKey: 'decision:project:b',
        status: 'active',
        visibleInRecall: false,
        summary: 'Use PostgreSQL for curated memory but hidden',
        acceptedAt: '2026-04-22T00:00:00Z',
      },
    ];

    const results = recallMemoryRecords(records, 'PostgreSQL curated');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 2);
    assert.equal(results[0].status, 'active');
    assert.equal(results[0].visibleInRecall, true);
  });

  it('resolves active scope path instead of leaking every matching scope row', () => {
    const records = [
      {
        id: 'global',
        memoryType: 'decision',
        canonicalKey: 'decision:serving:scope-safe',
        status: 'active',
        visibleInRecall: true,
        scopeKey: 'global',
        inheritanceMode: 'defaultable',
        summary: 'Global fallback summary',
        acceptedAt: '2026-04-20T00:00:00Z',
      },
      {
        id: 'project',
        memoryType: 'decision',
        canonicalKey: 'decision:serving:scope-safe',
        status: 'active',
        visibleInRecall: true,
        scopeKey: 'project:aquifer',
        inheritanceMode: 'defaultable',
        summary: 'Project-specific serving summary',
        acceptedAt: '2026-04-21T00:00:00Z',
      },
      {
        id: 'session-old',
        memoryType: 'decision',
        canonicalKey: 'decision:serving:scope-safe',
        status: 'active',
        visibleInRecall: true,
        scopeKey: 'session:old',
        inheritanceMode: 'non_inheritable',
        summary: 'Old session-only summary',
        acceptedAt: '2026-04-22T00:00:00Z',
      },
    ];

    const results = recallMemoryRecords(records, 'serving summary', {
      activeScopeKey: 'project:aquifer',
      activeScopePath: ['global', 'project:aquifer'],
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'project');
    assert.equal(results[0].summary, 'Project-specific serving summary');
  });

  it('throws on empty query instead of returning recent memory implicitly', () => {
    assert.throws(() => recallMemoryRecords([], ''), /non-empty string/);
  });
});
