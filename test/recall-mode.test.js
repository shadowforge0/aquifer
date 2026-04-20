'use strict';

/**
 * Tests for explicit recall mode option: 'fts', 'hybrid', 'vector'.
 *
 * Uses a stub pool and mocked storage/entity/hybrid-rank dependencies so no
 * real database connection is required.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Module loader with dependency injection (same pattern as edge-cases.test.js)
// ---------------------------------------------------------------------------

function loadAquiferWithMocks(mocks) {
  const filePath = path.join(ROOT, 'core', 'aquifer.js');
  const source = fs.readFileSync(filePath, 'utf8');

  const mod = new Module(filePath, module);
  mod.filename = filePath;
  mod.paths = Module._nodeModulePaths(path.dirname(filePath));

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    mod._compile(source, filePath);
    return mod.exports;
  } finally {
    Module._load = originalLoad;
  }
}

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

function makePool(rows = []) {
  return {
    query: async () => ({ rows }),
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => {},
    }),
  };
}

// Minimal storage stub — only the functions recall() calls
function makeStorageMock({ ftsRows = [], turnRows = [], embRows = [] } = {}) {
  return {
    searchSessions: async () => ftsRows,
    searchTurnEmbeddings: async () => ({ rows: turnRows }),
    searchSummaryEmbeddings: async () => ({ rows: embRows }),
    // Other storage functions used by non-recall paths (not needed for these tests)
    upsertSession: async () => ({ id: 1, sessionId: 'test', isNew: true }),
    upsertSummary: async () => {},
    upsertTurnEmbeddings: async () => {},
    markStatus: async () => {},
    getSession: async () => null,
    recordAccess: async () => {},
    recordFeedback: async () => {},
    extractUserTurns: () => [],
  };
}

// Minimal entity mock
function makeEntityMock() {
  return {
    resolveEntities: async () => [],
    searchEntities: async () => [],
    getSessionsByEntityIntersection: async () => [],
    normalizeEntityName: (n) => n.toLowerCase(),
    upsertEntity: async () => ({ id: 1 }),
    upsertEntityMention: async () => {},
    upsertEntitySession: async () => {},
    upsertEntityRelations: async () => {},
    parseEntityOutput: () => [],
  };
}

// hybridRank mock that just returns fts results ranked trivially
function makeHybridRankMock() {
  return {
    hybridRank: (fts, emb, turn, opts) => {
      const all = [...fts, ...emb, ...turn];
      // deduplicate by session_id
      const seen = new Set();
      const deduped = [];
      for (const r of all) {
        const id = r.session_id || String(r.id);
        if (!seen.has(id)) {
          seen.add(id);
          deduped.push({ ...r, _score: 0.9, _rrf: 0.9, _timeDecay: 1, _access: 0, _entityScore: 0, _trustScore: 0.5, _trustMultiplier: 1, _openLoopBoost: 0 });
        }
      }
      return deduped.slice(0, opts.limit || 5);
    },
  };
}

// Summarize pipeline mock
function makeSummarizeMock() {
  return { summarize: async () => ({ summaryText: 'stub', structuredSummary: null }) };
}

function makeExtractEntitiesMock() {
  return { extractEntities: async () => [] };
}

// Build a createAquifer with fully injected mocks
function makeAquifer({ embedFn = null, ftsRows = [], turnRows = [], embRows = [], storageOverrides = {} } = {}) {
  // embeddingSearchSummaries is a closure inside aquifer.js that calls pool.query directly.
  // We return embRows from pool.query for summary vector search.
  const pool = {
    ...makePool([]),
    query: async (sql, _params) => {
      // Return embRows for any vector similarity query (identified by <=> operator)
      if (typeof sql === 'string' && sql.includes('<=>')) {
        return { rows: embRows };
      }
      // entity_sessions queries
      if (typeof sql === 'string' && sql.includes('entity_sessions')) {
        return { rows: [] };
      }
      // migrate DDL: just succeed
      return { rows: [] };
    },
  };

  const storageMock = { ...makeStorageMock({ ftsRows, turnRows, embRows }), ...storageOverrides };
  const entityMock = makeEntityMock();
  const hrMock = makeHybridRankMock();

  const { createAquifer } = loadAquiferWithMocks({
    pg: { Pool: class MockPool { constructor() { Object.assign(this, pool); } end() {} } },
    './storage': storageMock,
    './entity': entityMock,
    './hybrid-rank': hrMock,
    '../pipeline/summarize': makeSummarizeMock(),
    '../pipeline/extract-entities': makeExtractEntitiesMock(),
  });

  const config = {
    db: pool,
    schema: 'aquifer',
  };

  if (embedFn) {
    config.embed = { fn: embedFn };
  }

  const aq = createAquifer(config);
  // Pre-mark as migrated so recall() doesn't try to run DDL
  aq._migrated = true;
  // Expose internal migrated flag via the ensureMigrated bypass
  // We patch by calling migrate with a no-op pool (migration already succeeded)
  return { aq, storageMock };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmbedFn(vec = [0.1, 0.2, 0.3]) {
  return async (texts) => texts.map(_t => vec);
}

// Run recall and pre-warm migration state (migrate is idempotent with stub pool)
async function recallWithMigration(aq, query, opts) {
  // Trigger migration first so ensureMigrated doesn't block on real DDL
  try { await aq.migrate(); } catch { /* ignore */ }
  return aq.recall(query, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recall mode validation', () => {
  it('throws for invalid mode value', async () => {
    const { aq } = makeAquifer({ embedFn: makeEmbedFn() });
    await assert.rejects(
      () => recallWithMigration(aq, 'hello', { mode: 'bogus' }),
      /Invalid recall mode/
    );
  });

  it('throws for numeric mode value', async () => {
    const { aq } = makeAquifer({ embedFn: makeEmbedFn() });
    await assert.rejects(
      () => recallWithMigration(aq, 'hello', { mode: 42 }),
      /Invalid recall mode/
    );
  });
});

describe('recall mode: hybrid (default)', () => {
  it('throws without embed provider when no mode is specified', async () => {
    const { aq } = makeAquifer(); // no embedFn
    await assert.rejects(
      () => recallWithMigration(aq, 'hello'),
      /requires config\.embed\.fn/
    );
  });

  it('throws without embed provider when mode is hybrid', async () => {
    const { aq } = makeAquifer(); // no embedFn
    await assert.rejects(
      () => recallWithMigration(aq, 'hello', { mode: 'hybrid' }),
      /requires config\.embed\.fn/
    );
  });

  it('succeeds with embed provider in hybrid mode', async () => {
    const ftsRows = [{ session_id: 's1', agent_id: 'agent', source: 'api', started_at: new Date().toISOString(), summary_text: 'hello world', structured_summary: null }];
    const { aq } = makeAquifer({ embedFn: makeEmbedFn(), ftsRows });
    const results = await recallWithMigration(aq, 'hello', { mode: 'hybrid' });
    assert.ok(Array.isArray(results));
  });
});

describe('recall mode: fts', () => {
  it('works WITHOUT an embed provider', async () => {
    const ftsRows = [
      { session_id: 's1', agent_id: 'agent', source: 'api', started_at: new Date().toISOString(), summary_text: 'hello world', structured_summary: null },
    ];
    const { aq } = makeAquifer({ ftsRows }); // no embedFn
    const results = await recallWithMigration(aq, 'hello', { mode: 'fts' });
    assert.ok(Array.isArray(results));
    // Should return the FTS row
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, 's1');
  });

  it('returns empty array when no FTS matches', async () => {
    const { aq } = makeAquifer(); // no embedFn, no fts rows
    const results = await recallWithMigration(aq, 'hello', { mode: 'fts' });
    assert.deepEqual(results, []);
  });

  it('does NOT call embed function even if one is configured', async () => {
    let embedCalled = false;
    const embedFn = async (texts) => { embedCalled = true; return texts.map(() => [0.1]); };
    const ftsRows = [{ session_id: 's1', agent_id: 'agent', source: 'api', started_at: new Date().toISOString(), summary_text: 'fts hit', structured_summary: null }];
    const { aq } = makeAquifer({ embedFn, ftsRows });
    await recallWithMigration(aq, 'hello', { mode: 'fts' });
    assert.equal(embedCalled, false, 'embed function must NOT be called in fts mode');
  });
});

describe('recall mode: vector', () => {
  it('throws without embed provider', async () => {
    const { aq } = makeAquifer(); // no embedFn
    await assert.rejects(
      () => recallWithMigration(aq, 'hello', { mode: 'vector' }),
      /requires config\.embed\.fn/
    );
  });

  it('succeeds with embed provider', async () => {
    const embRows = [{ session_id: 's2', agent_id: 'agent', source: 'api', started_at: new Date().toISOString(), summary_text: 'vector hit', structured_summary: null, distance: 0.1 }];
    const { aq } = makeAquifer({ embedFn: makeEmbedFn(), embRows });
    const results = await recallWithMigration(aq, 'hello', { mode: 'vector' });
    assert.ok(Array.isArray(results));
  });

  it('does NOT call FTS search in vector mode', async () => {
    // Verify via a fresh aquifer with tracked storage mock:
    let ftsSearchCallCount = 0;
    const storageMockTracking = makeStorageMock({ ftsRows: [] });
    storageMockTracking.searchSessions = async () => { ftsSearchCallCount++; return []; };

    const entityMock = makeEntityMock();
    const hrMock = makeHybridRankMock();

    const pool = {
      query: async (sql) => {
        if (typeof sql === 'string' && sql.includes('<=>')) return { rows: [] };
        if (typeof sql === 'string' && sql.includes('entity_sessions')) return { rows: [] };
        return { rows: [] };
      },
    };

    const { createAquifer } = loadAquiferWithMocks({
      pg: { Pool: class { constructor() { Object.assign(this, pool); } end() {} } },
      './storage': storageMockTracking,
      './entity': entityMock,
      './hybrid-rank': hrMock,
      '../pipeline/summarize': makeSummarizeMock(),
      '../pipeline/extract-entities': makeExtractEntitiesMock(),
    });

    const aqVector = createAquifer({ db: pool, embed: { fn: makeEmbedFn() } });
    try { await aqVector.migrate(); } catch {}
    await aqVector.recall('hello', { mode: 'vector' });

    assert.equal(ftsSearchCallCount, 0, 'storage.searchSessions must NOT be called in vector mode');
  });
});

describe('recall backward compatibility', () => {
  it('omitting mode behaves like hybrid — requires embed', async () => {
    const { aq } = makeAquifer(); // no embedFn
    await assert.rejects(
      () => recallWithMigration(aq, 'hello'), // no mode opt at all
      /requires config\.embed\.fn/
    );
  });

  it('result shape is consistent across modes that return data', async () => {
    const ftsRows = [{ session_id: 's3', agent_id: 'agent', source: 'api', started_at: new Date().toISOString(), summary_text: 'shape test', structured_summary: null }];
    const { aq } = makeAquifer({ ftsRows }); // fts mode, no embed
    const results = await recallWithMigration(aq, 'test', { mode: 'fts' });
    assert.equal(results.length, 1);
    const r = results[0];
    // All standard result fields must be present
    assert.ok('sessionId' in r, 'sessionId field required');
    assert.ok('agentId' in r, 'agentId field required');
    assert.ok('source' in r, 'source field required');
    assert.ok('startedAt' in r, 'startedAt field required');
    assert.ok('summaryText' in r, 'summaryText field required');
    assert.ok('score' in r, 'score field required');
    assert.ok('trustScore' in r, 'trustScore field required');
    assert.ok('_debug' in r, '_debug field required');
  });

  it('includes search path errors in debug output when recall can still return results', async () => {
    const ftsRows = [{ session_id: 's4', agent_id: 'agent', source: 'api', started_at: new Date().toISOString(), summary_text: 'fts hit', structured_summary: null }];
    const { aq } = makeAquifer({
      embedFn: makeEmbedFn(),
      ftsRows,
      storageOverrides: {
        searchTurnEmbeddings: async () => { throw new Error('turn path down'); },
      },
    });

    const results = await recallWithMigration(aq, 'hello', { mode: 'hybrid' });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]._debug.searchErrors, [{ path: 'turn-vector', message: 'turn path down' }]);
  });

  it('throws when strictSearchErrors is enabled and all search paths fail', async () => {
    const { aq } = makeAquifer({
      embedFn: async () => { throw new Error('embed down'); },
      storageOverrides: {
        searchSessions: async () => { throw new Error('fts down'); },
        searchTurnEmbeddings: async () => { throw new Error('turn down'); },
      },
    });

    await assert.rejects(
      () => recallWithMigration(aq, 'hello', { strictSearchErrors: true }),
      /embed down/
    );
  });

  it('throws aggregated path errors in strict mode when embed succeeds but searches fail', async () => {
    const { aq } = makeAquifer({
      embedFn: makeEmbedFn(),
      storageOverrides: {
        searchSessions: async () => { throw new Error('fts down'); },
        searchTurnEmbeddings: async () => { throw new Error('turn down'); },
      },
    });

    await assert.rejects(
      () => recallWithMigration(aq, 'hello', { strictSearchErrors: true }),
      /Recall search failed: fts: fts down; turn-vector: turn down/
    );
  });
});
