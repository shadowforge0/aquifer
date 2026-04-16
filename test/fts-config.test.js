'use strict';

/**
 * Tests for FTS search behavior: trigram (primary) + tsvector (fallback).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// storage.searchSessions — trigram + FTS fallback
// ---------------------------------------------------------------------------

describe('storage.searchSessions trigram search', () => {
  function makePool(capturedQueries) {
    return {
      query: async (sql, params) => {
        capturedQueries.push({ sql, params });
        return { rows: [] };
      },
    };
  }

  const storage = require('../core/storage');

  it('uses ILIKE for trigram matching', async () => {
    const captured = [];
    await storage.searchSessions(makePool(captured), 'hello', {
      schema: 'aquifer',
      tenantId: 'default',
    });
    assert.equal(captured.length, 1);
    assert.ok(
      captured[0].sql.includes('ILIKE'),
      `SQL should contain ILIKE for trigram search`
    );
  });

  it('includes tsvector fallback in OR clause', async () => {
    const captured = [];
    await storage.searchSessions(makePool(captured), 'hello', {
      schema: 'aquifer',
      tenantId: 'default',
    });
    assert.ok(
      captured[0].sql.includes("plainto_tsquery('simple'"),
      `SQL should include tsvector fallback`
    );
  });

  it('uses similarity() for ranking when search_text available', async () => {
    const captured = [];
    await storage.searchSessions(makePool(captured), 'hello', {
      schema: 'aquifer',
      tenantId: 'default',
    });
    assert.ok(
      captured[0].sql.includes('similarity('),
      `SQL should use similarity() for ranking`
    );
  });

  it('escapes LIKE special characters in query', async () => {
    const captured = [];
    await storage.searchSessions(makePool(captured), '100% done_ok', {
      schema: 'aquifer',
      tenantId: 'default',
    });
    // The escaped query should be in params[0] (likeQuery)
    assert.equal(captured[0].params[0], '100\\% done\\_ok');
    // The raw query should be in params[1] (for tsvector fallback)
    assert.equal(captured[0].params[1], '100% done_ok');
  });

  it('ftsConfig parameter is ignored (no longer used)', async () => {
    const captured = [];
    // Should not throw or warn even if ftsConfig is passed
    await storage.searchSessions(makePool(captured), 'hello', {
      schema: 'aquifer',
      tenantId: 'default',
      ftsConfig: 'zhcfg',
    });
    assert.equal(captured.length, 1);
    assert.ok(!captured[0].sql.includes('zhcfg'), 'zhcfg should not appear in SQL');
  });

  it('passes agentIds filter correctly', async () => {
    const captured = [];
    await storage.searchSessions(makePool(captured), 'test', {
      schema: 'aquifer',
      tenantId: 'default',
      agentIds: ['main', 'cc'],
    });
    assert.ok(
      captured[0].sql.includes('ANY('),
      `SQL should include ANY() for agentIds filter`
    );
    const hasAgentIds = captured[0].params.some(
      p => Array.isArray(p) && p.includes('main') && p.includes('cc')
    );
    assert.ok(hasAgentIds, 'agentIds should be in params as array');
  });

  it('respects limit parameter', async () => {
    const captured = [];
    await storage.searchSessions(makePool(captured), 'test', {
      schema: 'aquifer',
      tenantId: 'default',
      limit: 7,
    });
    assert.ok(captured[0].params.includes(7), 'limit 7 should be in params');
  });

  it('searchTurnEmbeddings runs HNSW nearest-neighbor in a CTE ahead of filters', async () => {
    const captured = [];
    await storage.searchTurnEmbeddings(makePool(captured), {
      schema: 'aquifer',
      tenantId: 'default',
      queryVec: new Array(1024).fill(0.1),
    });
    assert.equal(captured.length, 1);
    const sql = captured[0].sql;
    const cteMatch = sql.match(/WITH\s+nn\s+AS\s*\(([\s\S]+?)\)\s*SELECT/i);
    assert.ok(cteMatch, 'must define an `nn` CTE before the outer SELECT');
    const cteBody = cteMatch[1];
    // HNSW index only fires on `ORDER BY embedding <=> vec LIMIT N` with no
    // extra predicates at the same level. Guard that shape.
    assert.ok(/ORDER BY\s+t\.embedding\s*<=>/i.test(cteBody),
      'CTE must order by embedding distance');
    assert.ok(/LIMIT\s+\$\d+/i.test(cteBody),
      'CTE must have an explicit LIMIT for HNSW to engage');
    assert.ok(!/tenant_id/i.test(cteBody),
      'tenant/agent filters must live outside the NN CTE');
  });

  it('orders substring-hit rows ahead of similarity-only matches', async () => {
    const captured = [];
    await storage.searchSessions(makePool(captured), 'hello', {
      schema: 'aquifer',
      tenantId: 'default',
    });
    const sql = captured[0].sql;
    const orderIdx = sql.indexOf('ORDER BY');
    assert.ok(orderIdx >= 0, 'SQL must contain ORDER BY');
    const orderClause = sql.slice(orderIdx);
    // Primary sort key must be the substring-hit boolean (true-first).
    // Otherwise short CJK queries get buried by long rows with incidental trigram overlap.
    assert.ok(
      /COALESCE\(\s*ss\.search_text\s+ILIKE[^)]*\)\s+DESC/.test(orderClause),
      `ORDER BY must lead with COALESCE(search_text ILIKE ...) DESC, got: ${orderClause}`
    );
    // substring-hit must come before fts_rank in ORDER BY
    const ilikeIdx = orderClause.search(/ILIKE/);
    const rankIdx = orderClause.indexOf('fts_rank');
    assert.ok(
      ilikeIdx >= 0 && rankIdx > ilikeIdx,
      'substring-hit must be a higher-priority sort key than fts_rank'
    );
  });
});
