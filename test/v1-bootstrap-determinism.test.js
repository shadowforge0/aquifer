'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildMemoryBootstrap } = require('../core/memory-bootstrap');

function baseRecords() {
  return [
    {
      id: 3,
      memoryType: 'decision',
      canonicalKey: 'decision:project:a',
      status: 'active',
      visibleInBootstrap: true,
      authority: 'verified_summary',
      scopeKey: 'project:aquifer',
      inheritanceMode: 'defaultable',
      acceptedAt: '2026-04-20T00:00:00Z',
      summary: 'Keep raw transcript out of session_recall.',
    },
    {
      id: 1,
      memoryType: 'open_loop',
      canonicalKey: 'open_loop:project:a',
      status: 'active',
      visibleInBootstrap: true,
      authority: 'verified_summary',
      scopeKey: 'project:aquifer',
      inheritanceMode: 'additive',
      acceptedAt: '2026-04-21T00:00:00Z',
      summary: 'Add curated sidecar tests.',
    },
    {
      id: 2,
      memoryType: 'constraint',
      canonicalKey: 'constraint:user:mk',
      status: 'active',
      visibleInBootstrap: true,
      authority: 'user_explicit',
      scopeKey: 'user:mk',
      inheritanceMode: 'defaultable',
      acceptedAt: '2026-04-19T00:00:00Z',
      summary: 'Use Traditional Chinese in this workspace.',
    },
  ];
}

describe('v1 memory bootstrap determinism', () => {
  it('same snapshot and budget produces byte-identical output despite insertion order', () => {
    const opts = {
      activeScopePath: ['global', 'user:mk', 'project:aquifer'],
      activeScopeKey: 'project:aquifer',
      maxChars: 4000,
      format: 'both',
    };
    const a = buildMemoryBootstrap(baseRecords(), opts);
    const b = buildMemoryBootstrap([...baseRecords()].reverse(), opts);

    assert.equal(a.text, b.text);
    assert.deepEqual(
      a.memories.map(r => r.canonicalKey),
      b.memories.map(r => r.canonicalKey),
    );
    assert.match(a.text, /constraint: Use Traditional Chinese/);
    assert.match(a.text, /open_loop: Add curated sidecar tests/);
  });

  it('reports degraded output instead of silently dropping overflow', () => {
    const records = baseRecords().map((r, idx) => ({
      ...r,
      summary: `${r.summary} ${'x'.repeat(200 + idx)}`,
    }));
    const result = buildMemoryBootstrap(records, {
      activeScopePath: ['global', 'user:mk', 'project:aquifer'],
      activeScopeKey: 'project:aquifer',
      maxChars: 140,
      format: 'both',
    });

    assert.equal(result.meta.overflow, true);
    assert.equal(result.meta.degraded, true);
    assert.match(result.text, /degraded="true"/);
  });
});
