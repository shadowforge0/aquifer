'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquifer } = require('../index');
const { rankHybridMemoryRows } = require('../core/memory-recall');

function semanticMemoryRow(overrides = {}) {
  return {
    id: 42,
    memory_id: 42,
    memory_type: 'decision',
    canonical_key: 'decision:project:aquifer:local-starter',
    scope_key: 'project:aquifer',
    scope_kind: 'project',
    scope_inheritance_mode: 'defaultable',
    status: 'active',
    visible_in_recall: true,
    title: 'Local starter onboarding lane',
    summary: 'PostgreSQL remains the full feature backend while local starter lowers setup friction.',
    accepted_at: '2026-04-30T00:00:00Z',
    recall_score: 1.91,
    semantic_score: 0.91,
    signal_priority: 3,
    ...overrides,
  };
}

function makePool() {
  const queries = [];
  const lexicalDistractor = semanticMemoryRow({
    id: 7,
    memory_id: 7,
    canonical_key: 'decision:project:aquifer:datastore-distractor',
    title: 'Real datastore provisioning checklist',
    summary: 'A lexical distractor for datastore provisioning words.',
    recall_score: 1.2,
  });
  const semanticTarget = semanticMemoryRow();
  return {
    queries,
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes('m.embedding <=>')) {
        return { rows: [semanticTarget], rowCount: 1 };
      }
      if (text.includes('session_summaries') || text.includes('evidence_items')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM "aq".memory_records')) {
        return { rows: [lexicalDistractor], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
    },
    async end() {},
  };
}

describe('v1 curated semantic recall', () => {
  it('fuses lexical and vector hits for the same current-memory row', () => {
    const lexical = semanticMemoryRow({
      id: 42,
      canonical_key: 'decision:project:aquifer:fused-row',
      title: 'Hybrid contract lexical hit',
      recall_score: 0.72,
      lexical_rank: 0.72,
      signal_priority: 3,
    });
    const semantic = semanticMemoryRow({
      id: 42,
      canonical_key: 'decision:project:aquifer:fused-row',
      title: 'Hybrid contract semantic hit',
      recall_score: 0.93,
      semantic_score: 0.93,
      signal_priority: 1,
    });

    const rows = rankHybridMemoryRows([lexical], [semantic], { limit: 5 });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].canonical_key, 'decision:project:aquifer:fused-row');
    assert.equal(rows[0].match_signal, 'memory_row_hybrid');
    assert.deepEqual(rows[0]._matchSignals.sort(), ['lexical', 'semantic']);
    assert.equal(rows[0].signal_priority, undefined);
  });

  it('prefers a paraphrased semantic current-memory hit over a lexical distractor', async () => {
    const pool = makePool();
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      embed: { fn: async () => [[1, 0, 0]] },
      memory: { servingMode: 'curated', activeScopePath: ['global', 'project:aquifer'] },
    });

    const rows = await aq.recall('Can I kick the tires before provisioning the real datastore?', {
      activeScopeKey: 'project:aquifer',
      activeScopePath: ['global', 'project:aquifer'],
      limit: 3,
    });

    assert.equal(rows.length, 2);
    assert.equal(rows[0].canonicalKey, 'decision:project:aquifer:local-starter');
    assert.equal(rows[0].memoryId, '42');
    assert.ok(pool.queries.some(query => /m\.embedding\s*<=>/.test(query.sql)));
    assert.equal(pool.queries.some(query => query.sql.includes('session_summaries')), false);
    assert.equal(pool.queries.some(query => query.sql.includes('evidence_items')), false);
    assert.equal(pool.queries.some(query => query.sql.includes('turn_embeddings')), false);
  });

  it('supports vector mode inside curated current memory without falling back to lexical archive search', async () => {
    const pool = makePool();
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      embed: { fn: async () => [[1, 0, 0]] },
      memory: { servingMode: 'curated', activeScopeKey: 'project:aquifer' },
    });

    const rows = await aq.recall('try it before the real database', {
      activeScopeKey: 'project:aquifer',
      mode: 'vector',
      limit: 3,
    });

    assert.deepEqual(rows.map(row => row.canonicalKey), ['decision:project:aquifer:local-starter']);
    assert.equal(rows[0].feedbackTarget.kind, 'memory_feedback');
    assert.equal(rows[0].sessionId, undefined);
    assert.equal(pool.queries.some(query => query.sql.includes('session_summaries')), false);
    assert.equal(pool.queries.some(query => query.sql.includes('evidence_items')), false);
    assert.equal(pool.queries.some(query => query.sql.includes('turn_embeddings')), false);
  });

  it('does not substitute unrelated historical session summaries for current memory when no active row matches', async () => {
    const pool = {
      queries: [],
      async query(sql, params = []) {
        const text = String(sql);
        this.queries.push({ sql: text, params });
        if (text.includes('m.embedding <=>')) return { rows: [], rowCount: 0 };
        if (text.includes('session_summaries ss')) return { rows: [], rowCount: 0 };
        if (text.includes('evidence_items')) return { rows: [], rowCount: 0 };
        if (text.includes('FROM "aq".memory_records')) return { rows: [], rowCount: 0 };
        if (text.includes('turn_embeddings')) {
          return {
            rows: [{
              session_id: 'historical-only-001',
              summary_text: 'Unrelated historical summary should never become current truth.',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
      },
      async end() {},
    };
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      embed: { fn: async () => [[1, 0, 0]] },
      memory: { servingMode: 'curated', activeScopeKey: 'project:aquifer' },
    });

    const rows = await aq.recall('historical-only query', {
      activeScopeKey: 'project:aquifer',
      mode: 'hybrid',
      limit: 3,
    });

    assert.deepEqual(rows, []);
    assert.equal(pool.queries.some(query => query.sql.includes('session_summaries')), false);
    assert.equal(pool.queries.some(query => query.sql.includes('evidence_items')), false);
    assert.equal(pool.queries.some(query => query.sql.includes('turn_embeddings')), false);
  });

  it('does not use a higher-scored linked-summary fallback as current-memory corpus', async () => {
    const semanticTarget = semanticMemoryRow({
      canonical_key: 'conclusion:project:aquifer:query-contract',
      memory_type: 'conclusion',
      title: 'Current-memory recall should rank row hits first',
      summary: 'Direct per-memory embedding should outrank coarse same-session fallback hits.',
      recall_score: 0.94,
    });
    const coarseConstraint = semanticMemoryRow({
      id: 77,
      memory_id: 77,
      canonical_key: 'constraint:project:aquifer:query-contract',
      memory_type: 'constraint',
      title: 'Keep compatibility constraints visible',
      summary: 'A coarse linked-summary-only fallback from the same session.',
      recall_score: 9.8,
      linked_summary_score: 0.98,
      signal_priority: 1,
    });
    const pool = {
      queries: [],
      async query(sql, params = []) {
        const text = String(sql);
        this.queries.push({ sql: text, params });
        if (text.includes('m.embedding <=>')) return { rows: [semanticTarget], rowCount: 1 };
        if (text.includes('session_summaries ss')) return { rows: [coarseConstraint], rowCount: 1 };
        if (text.includes('evidence_items')) return { rows: [], rowCount: 0 };
        if (text.includes('FROM "aq".memory_records')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
      },
      async end() {},
    };
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      embed: { fn: async () => [[1, 0, 0]] },
      memory: { servingMode: 'curated', activeScopeKey: 'project:aquifer' },
    });

    const rows = await aq.recall('What was the current-memory query contract fix?', {
      activeScopeKey: 'project:aquifer',
      mode: 'hybrid',
      limit: 3,
    });

    assert.equal(pool.queries.some(query => query.sql.includes('session_summaries')), false);
    assert.equal(pool.queries.some(query => query.sql.includes('evidence_items')), false);
    assert.equal(pool.queries.some(query => /m\.embedding\s*<=>/.test(query.sql)), true);
    assert.deepEqual(
      rows.map(row => row.canonicalKey),
      ['conclusion:project:aquifer:query-contract'],
    );
  });
});
