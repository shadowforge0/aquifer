'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const storage = require('../core/storage');

function makePool(capturedQueries, rows = []) {
  return {
    query: async (sql, params) => {
      capturedQueries.push({ sql, params });
      return { rows };
    },
  };
}

describe('storage.searchSummaryEmbeddings', () => {
  it('builds the canonical pgvector cosine query with tenant filter', async () => {
    const captured = [];
    const result = await storage.searchSummaryEmbeddings(makePool(captured), {
      schema: 'aquifer',
      tenantId: 'default',
      queryVec: [0.1, 0.2, 0.3],
    });
    assert.equal(captured.length, 1);
    const { sql, params } = captured[0];
    assert.ok(sql.includes('ss.embedding <=> $'), 'must use pgvector cosine operator');
    assert.ok(/"aquifer"\.session_summaries/.test(sql), 'must qualify table with schema');
    assert.ok(sql.includes('ORDER BY distance ASC'), 'must order by distance ASC');
    assert.equal(params[0], 'default', 'tenant_id is first param');
    assert.equal(params[1], '[0.1,0.2,0.3]', 'vector is serialized as pgvector literal');
    assert.deepEqual(result, { rows: [] });
  });

  it('normalises agentId singular into agentIds array filter', async () => {
    const captured = [];
    await storage.searchSummaryEmbeddings(makePool(captured), {
      schema: 'aq',
      tenantId: 't',
      queryVec: [0.1],
      agentId: 'main',
    });
    const { sql, params } = captured[0];
    assert.ok(/s\.agent_id\s*=\s*ANY\(\$\d+\)/.test(sql), 'agentId should become ANY() filter');
    assert.ok(params.some(p => Array.isArray(p) && p.includes('main')), 'agent passed as array');
  });

  it('passes agentIds, source, dateFrom, dateTo, limit, candidateSessionIds correctly', async () => {
    const captured = [];
    await storage.searchSummaryEmbeddings(makePool(captured), {
      schema: 'aq',
      tenantId: 't',
      queryVec: [0.1],
      agentIds: ['main', 'cc'],
      source: 'gateway',
      dateFrom: '2026-04-01',
      dateTo: '2026-04-19',
      limit: 7,
      candidateSessionIds: ['s1', 's2'],
    });
    const { sql, params } = captured[0];
    assert.ok(sql.includes('s.source = $'), 'must filter by source');
    assert.ok(sql.includes('s.started_at::date >= $'), 'must filter by dateFrom');
    assert.ok(sql.includes('s.started_at::date <= $'), 'must filter by dateTo');
    assert.ok(/s\.session_id\s*=\s*ANY\(\$\d+\)/.test(sql), 'must filter by candidateSessionIds');
    assert.ok(params.includes('gateway'));
    assert.ok(params.includes('2026-04-01'));
    assert.ok(params.includes('2026-04-19'));
    assert.ok(params.includes(7), 'limit appears in params');
    assert.ok(params.some(p => Array.isArray(p) && p.includes('s1') && p.includes('s2')),
      'candidate session ids passed as array');
  });

  it('returns rows in {rows:[]} envelope to match searchTurnEmbeddings shape', async () => {
    const captured = [];
    const fakeRows = [{ session_id: 'a', distance: 0.1 }, { session_id: 'b', distance: 0.2 }];
    const result = await storage.searchSummaryEmbeddings(
      makePool(captured, fakeRows),
      { schema: 'aq', tenantId: 't', queryVec: [0.5], limit: 5 }
    );
    assert.deepEqual(result, { rows: fakeRows });
  });

  it('skips rows where embedding IS NULL', async () => {
    const captured = [];
    await storage.searchSummaryEmbeddings(makePool(captured), {
      schema: 'aq', tenantId: 't', queryVec: [0.1], limit: 3,
    });
    assert.ok(captured[0].sql.includes('ss.embedding IS NOT NULL'),
      'must guard against NULL embeddings');
  });

  it('excludes obvious placeholder summaries from public summary-vector recall SQL', async () => {
    const captured = [];
    await storage.searchSummaryEmbeddings(makePool(captured), {
      schema: 'aq',
      tenantId: 't',
      queryVec: [0.1],
      limit: 3,
    });
    const sql = captured[0].sql;

    assert.match(sql, /summary_text/);
    assert.match(sql, /空測試會話/);
    assert.match(sql, /測試會話無實質內容/);
    assert.match(sql, /placeholder/);
    assert.match(sql, /x 字元填充/);
  });
});
