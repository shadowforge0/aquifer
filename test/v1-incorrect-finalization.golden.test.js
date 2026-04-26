'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildMemoryBootstrap } = require('../core/memory-bootstrap');
const { recallMemoryRecords } = require('../core/memory-recall');

function record(overrides) {
  return {
    id: overrides.id,
    memoryType: overrides.memoryType || 'decision',
    canonicalKey: overrides.canonicalKey || `decision:global:${overrides.id}`,
    scopeKey: 'global',
    scope_inheritance_mode: 'defaultable',
    status: 'active',
    visibleInBootstrap: true,
    visibleInRecall: true,
    summary: overrides.summary,
    acceptedAt: overrides.acceptedAt || '2026-04-26T00:00:00Z',
    ...overrides,
  };
}

describe('v1 incorrect memory lifecycle', () => {
  it('does not serve incorrect, superseded, or quarantined finalization output through recall/bootstrap', () => {
    const rows = [
      record({
        id: 1,
        summary: 'handoff finalization review is the user-facing output',
      }),
      record({
        id: 2,
        status: 'incorrect',
        summary: 'raw JSON handoff report is acceptable context',
      }),
      record({
        id: 3,
        status: 'superseded',
        summary: 'old payload-only handoff writes are current',
      }),
      record({
        id: 4,
        status: 'quarantined',
        summary: 'tool transcript snippets are runtime memory',
      }),
    ];

    const recalled = recallMemoryRecords(rows, 'handoff', { includeAll: true });
    assert.deepEqual(recalled.map(row => row.id), [1]);
    assert.equal(recalled[0].summary, 'handoff finalization review is the user-facing output');

    const bootstrap = buildMemoryBootstrap(rows, { format: 'text' });
    assert.match(bootstrap.text, /handoff finalization review is the user-facing output/);
    assert.doesNotMatch(bootstrap.text, /raw JSON handoff/);
    assert.doesNotMatch(bootstrap.text, /payload-only handoff/);
    assert.doesNotMatch(bootstrap.text, /tool transcript/);
  });
});
