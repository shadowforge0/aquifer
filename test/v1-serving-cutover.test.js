'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquifer, MCP_TOOL_MANIFEST } = require('../index');

function makePool() {
  const queries = [];
  const memoryRow = {
    id: 1,
    memory_type: 'decision',
    canonical_key: 'decision:project:aquifer:serving',
    scope_key: 'project:aquifer',
    scope_kind: 'project',
    scope_inheritance_mode: 'defaultable',
    status: 'active',
    visible_in_recall: true,
    visible_in_bootstrap: true,
    title: 'Use curated memory serving',
    summary: 'Use curated memory as the recall source.',
    authority: 'verified_summary',
    accepted_at: '2026-04-26T00:00:00Z',
    lexical_rank: 1,
  };
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (String(sql).includes('FROM "aq".memory_records')) return { rows: [memoryRow], rowCount: 1 };
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
    async end() {},
  };
}

describe('v1 serving mode controls', () => {
  it('top-level recall can use curated memory without embedding or legacy fallback', async () => {
    const pool = makePool();
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated' },
    });

    const results = await aq.recall('curated memory', { limit: 3 });
    assert.equal(results.length, 1);
    assert.equal(results[0].canonical_key, 'decision:project:aquifer:serving');
    assert.ok(pool.queries.some(q => String(q.sql).includes('FROM "aq".memory_records')));
    assert.equal(pool.queries.some(q => String(q.sql).includes('turn_embeddings')), false);
    assert.equal(pool.queries.some(q => String(q.sql).includes('session_summaries')), false);
  });

  it('evidenceRecall remains explicit legacy/evidence path', async () => {
    const aq = createAquifer({
      db: makePool(),
      schema: 'aq',
      migrations: { mode: 'off' },
    });

    await assert.rejects(
      () => aq.evidenceRecall('legacy evidence'),
      /requires config\.embed\.fn/,
    );
  });

  it('bootstrap can use curated memory and does not read legacy sessions', async () => {
    const pool = makePool();
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated' },
    });

    const result = await aq.bootstrap({
      activeScopePath: ['global', 'project:aquifer'],
      format: 'text',
    });

    assert.match(result.text, /memory-bootstrap/);
    assert.match(result.text, /Use curated memory as the recall source/);
    assert.equal(pool.queries.some(q => String(q.sql).includes('FROM "aq".sessions')), false);
  });

  it('MCP manifest separates memory recall from explicit evidence recall', () => {
    const names = MCP_TOOL_MANIFEST.map(tool => tool.name);
    assert.ok(names.includes('session_recall'));
    assert.ok(names.includes('evidence_recall'));
    const evidence = MCP_TOOL_MANIFEST.find(tool => tool.name === 'evidence_recall');
    assert.match(evidence.description, /legacy\/evidence/);
  });
});
