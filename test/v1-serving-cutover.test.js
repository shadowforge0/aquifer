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
    assert.equal(results[0].canonicalKey, 'decision:project:aquifer:serving');
    assert.equal(results[0].structuredSummary.title, 'Use curated memory serving');
    assert.equal(results[0].feedbackTarget.kind, 'memory_feedback');
    assert.ok(pool.queries.some(q => String(q.sql).includes('FROM "aq".memory_records')));
    assert.equal(pool.queries.some(q => String(q.sql).includes('turn_embeddings')), false);
    assert.equal(pool.queries.some(q => String(q.sql).includes('session_summaries')), false);
  });

  it('curated recall applies active scope before returning memory rows', async () => {
    const pool = makePool();
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: {
        servingMode: 'curated',
        activeScopeKey: 'project:aquifer',
        activeScopePath: ['global', 'project:aquifer'],
      },
    });

    await aq.recall('curated memory', { limit: 3 });

    const query = pool.queries.find(q => String(q.sql).includes('FROM "aq".memory_records'));
    assert.match(query.sql, /s\.scope_key = ANY/);
    assert.deepEqual(query.params, ['default', 'curated memory', ['global', 'project:aquifer'], 12]);
  });

  it('curated recall uses the same configured FTS parser as historical recall', async () => {
    const pool = makePool();
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      ftsConfig: 'zhcfg',
      memory: { servingMode: 'curated' },
    });

    await aq.recall('目前', { mode: 'fts', limit: 3 });

    const query = pool.queries.find(q => String(q.sql).includes('FROM "aq".memory_records'));
    assert.match(query.sql, /plainto_tsquery\('zhcfg'/);
    assert.doesNotMatch(query.sql, /plainto_tsquery\('simple'/);
  });

  it('curated recall rejects legacy-only filters instead of silently ignoring them', async () => {
    const aq = createAquifer({
      db: makePool(),
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated' },
    });

    await assert.rejects(
      () => aq.recall('curated memory', { source: 'codex' }),
      /does not support legacy filters: source/,
    );
  });

  it('curated vector recall requires an embedder instead of silently falling back', async () => {
    const aq = createAquifer({
      db: makePool(),
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated' },
    });

    await assert.rejects(
      () => aq.recall('curated memory', { mode: 'vector' }),
      /mode=vector requires config\.embed\.fn or EMBED_PROVIDER env/,
    );
  });

  it('evidenceRecall remains explicit legacy/evidence path', async () => {
    const aq = createAquifer({
      db: makePool(),
      schema: 'aq',
      migrations: { mode: 'off' },
    });

    await assert.rejects(
      () => aq.evidenceRecall('legacy evidence'),
      /requires an audit boundary filter/,
    );
  });

  it('evidenceRecall allows broad debug only when explicitly requested', async () => {
    const aq = createAquifer({
      db: makePool(),
      schema: 'aq',
      migrations: { mode: 'off' },
    });

    await assert.rejects(
      () => aq.evidenceRecall('legacy evidence', { allowUnsafeDebug: true }),
      /requires config\.embed\.fn/,
    );
  });

  it('exposes explicit current-memory and historical recall surfaces without collapsing them into one path', async () => {
    const pool = {
      queries: [],
      async query(sql, params = []) {
        const text = String(sql);
        this.queries.push({ sql: text, params });
        if (text.includes('FROM "aq".memory_records')) {
          return {
            rows: [{
              id: 1,
              memory_type: 'decision',
              canonical_key: 'decision:project:aquifer:surface-separation',
              scope_key: 'project:aquifer',
              scope_kind: 'project',
              scope_inheritance_mode: 'defaultable',
              status: 'active',
              visible_in_recall: true,
              title: 'Current memory stays on memory rows',
              summary: 'Current memory uses curated rows only.',
              accepted_at: '2026-04-30T00:00:00Z',
              recall_score: 1.3,
              lexical_rank: 1,
            }],
            rowCount: 1,
          };
        }
        if (text.includes('FROM "aq".turn_embeddings')) {
          return {
            rows: [{
              id: 91,
              session_id: 'historical-001',
              summary_text: 'Historical hybrid should stay on the legacy session plane.',
              content: 'Historical hybrid should stay on the legacy session plane.',
              score: 0.91,
            }],
            rowCount: 1,
          };
        }
        if (text.includes('FROM "aq".session_summaries') || text.includes('session_summaries ss')) {
          return {
            rows: [{
              id: 91,
              session_id: 'historical-001',
              title: 'Historical summary',
              summary_text: 'Historical hybrid should stay on the legacy session plane.',
              structured_summary: {
                title: 'Historical summary',
                overview: 'Historical hybrid should stay on the legacy session plane.',
                topics: [],
                decisions: [],
                open_loops: [],
              },
              trust_score: 0.9,
              score: 1.1,
              started_at: '2026-04-29T00:00:00Z',
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
      memory: {
        servingMode: 'curated',
        activeScopeKey: 'project:aquifer',
        activeScopePath: ['global', 'project:aquifer'],
      },
    });

    const current = await aq.memoryRecall('current memory surface', {
      activeScopePath: ['global', 'project:aquifer'],
      mode: 'fts',
      limit: 3,
    });
    const afterCurrentQueries = pool.queries.length;
    const historical = await aq.historicalRecall('historical hybrid surface', {
      mode: 'hybrid',
      limit: 3,
    });

    assert.equal(current.length, 1);
    assert.equal(current[0].canonicalKey, 'decision:project:aquifer:surface-separation');
    assert.equal(current[0].feedbackTarget.kind, 'memory_feedback');
    assert.equal(current[0].sessionId, undefined);
    assert.equal(
      pool.queries.slice(0, afterCurrentQueries).some(q => String(q.sql).includes('turn_embeddings')),
      false,
    );
    assert.equal(
      pool.queries.slice(0, afterCurrentQueries).some(q => String(q.sql).includes('session_summaries')),
      false,
    );
    assert.equal(
      pool.queries.slice(0, afterCurrentQueries).some(q => String(q.sql).includes('evidence_items')),
      false,
    );

    assert.equal(historical.length, 1);
    assert.equal(historical[0].sessionId, 'historical-001');
    assert.equal(historical[0].feedbackTarget?.kind, undefined);
    assert.equal(
      pool.queries.slice(afterCurrentQueries).some(q => String(q.sql).includes('turn_embeddings')),
      true,
    );
    assert.equal(
      pool.queries.slice(afterCurrentQueries).some(q => String(q.sql).includes('FROM "aq".memory_records')),
      false,
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

  it('curated bootstrap rejects legacy-only filters instead of silently ignoring them', async () => {
    const aq = createAquifer({
      db: makePool(),
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated' },
    });

    await assert.rejects(
      () => aq.bootstrap({ agentId: 'main' }),
      /curated session_bootstrap does not support legacy filters: agentId/,
    );
  });

  it('MCP manifest separates memory recall from explicit evidence recall', () => {
    const names = MCP_TOOL_MANIFEST.map(tool => tool.name);
    assert.ok(names.includes('session_recall'));
    assert.ok(names.includes('evidence_recall'));
    assert.ok(names.includes('memory_feedback'));
    const evidence = MCP_TOOL_MANIFEST.find(tool => tool.name === 'evidence_recall');
    assert.match(evidence.description, /legacy\/evidence/);
    const sessionFeedback = MCP_TOOL_MANIFEST.find(tool => tool.name === 'session_feedback');
    assert.ok(!sessionFeedback.inputSchema.properties.memoryId);
  });

  it('stats expose serving mode and current-memory record coverage', async () => {
    const pool = {
      async query(sql) {
        const text = String(sql);
        if (text.includes('FROM "aq".sessions') && text.includes('GROUP BY processing_status')) {
          return { rows: [{ processing_status: 'succeeded', count: 2 }] };
        }
        if (text.includes('FROM "aq".session_summaries')) {
          return { rows: [{ count: 2 }] };
        }
        if (text.includes('FROM "aq".turn_embeddings')) {
          return { rows: [{ count: 4 }] };
        }
        if (text.includes('MIN(started_at)')) {
          return { rows: [{ earliest: '2026-04-28T00:00:00.000Z', latest: '2026-04-29T00:00:00.000Z' }] };
        }
        if (text.includes('FROM "aq".entities')) {
          return { rows: [{ count: 0 }] };
        }
        if (text.includes('FROM "aq".memory_records')) {
          return {
            rows: [{
              total: 3,
              active: 2,
              visible_in_bootstrap: 1,
              visible_in_recall: 2,
              earliest: '2026-04-28T01:00:00.000Z',
              latest: '2026-04-29T01:00:00.000Z',
            }],
          };
        }
        return { rows: [] };
      },
      async connect() {
        return { query: async () => ({ rows: [] }), release() {} };
      },
      async end() {},
    };
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated', activeScopePath: ['global', 'project:aquifer'] },
    });

    const stats = await aq.getStats();

    assert.equal(stats.serving.mode, 'curated');
    assert.deepEqual(stats.serving.activeScopePath, ['global', 'project:aquifer']);
    assert.equal(stats.memoryRecords.available, true);
    assert.equal(stats.memoryRecords.active, 2);
    assert.equal(stats.memoryRecords.visibleInRecall, 2);
    assert.equal(stats.memoryRecords.latest, '2026-04-29T01:00:00.000Z');
  });
});
