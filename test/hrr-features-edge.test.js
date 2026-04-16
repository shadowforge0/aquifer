'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { hybridRank } = require('../core/hybrid-rank');
const { resolveEntities, getSessionsByEntityIntersection, normalizeEntityName } = require('../core/entity');
const storage = require('../core/storage');
const { createAquifer } = require('../core/aquifer');

// ---------------------------------------------------------------------------
// hybrid-rank.js — Trust multiplier edge cases
// ---------------------------------------------------------------------------

describe('hybrid-rank.js — Trust multiplier edge cases', () => {
  it('trust_score undefined → multiplier 1.0 (same as default)', () => {
    const now = new Date().toISOString();
    const withField = [{ session_id: 'a', started_at: now, trust_score: undefined }];
    const withoutField = [{ session_id: 'b', started_at: now }];
    const [rWith] = hybridRank(withField, [], [], { limit: 1 });
    const [rWithout] = hybridRank(withoutField, [], [], { limit: 1 });
    assert.equal(rWith._trustScore, 0.5);
    assert.equal(rWith._trustMultiplier, 1.0);
    assert.equal(rWithout._trustScore, 0.5);
    assert.equal(rWithout._trustMultiplier, 1.0);
  });

  it('trust_score null → multiplier 1.0 (nullish coalescing)', () => {
    const now = new Date().toISOString();
    const fts = [{ session_id: 's1', started_at: now, trust_score: null }];
    const [r] = hybridRank(fts, [], [], { limit: 1 });
    assert.equal(r._trustScore, 0.5);
    assert.equal(r._trustMultiplier, 1.0);
  });

  it('trust_score extremely close to 0 boundary (0.001) → barely suppresses', () => {
    const now = new Date().toISOString();
    const nearZero = [{ session_id: 'a', started_at: now, trust_score: 0.001 }];
    const [r] = hybridRank(nearZero, [], [], { limit: 1 });
    assert.ok(r._trustMultiplier > 0.5);
    assert.ok(r._trustMultiplier < 0.502);
  });

  it('trust_score extremely close to 1 boundary (0.999) → barely below ceiling', () => {
    const now = new Date().toISOString();
    const nearOne = [{ session_id: 'a', started_at: now, trust_score: 0.999 }];
    const [r] = hybridRank(nearOne, [], [], { limit: 1 });
    assert.ok(r._trustMultiplier < 1.5);
    assert.ok(r._trustMultiplier > 1.498);
  });

  it('two identical sessions, high-trust ranks first', () => {
    const now = new Date().toISOString();
    const fts = [
      { session_id: 'high', started_at: now, trust_score: 1.0 },
      { session_id: 'low', started_at: now, trust_score: 0.0 },
      { session_id: 'mid', started_at: now, trust_score: 0.5 },
    ];
    const result = hybridRank(fts, [], [], { limit: 3 });
    assert.equal(result[0].session_id, 'high');
    assert.equal(result[1].session_id, 'mid');
    assert.equal(result[2].session_id, 'low');
  });

  it('high base score + trust=1.0 → clamped at 1.0 (saturation)', () => {
    const now = new Date().toISOString();
    const fts = [{
      session_id: 's1',
      started_at: now,
      trust_score: 1.0,
      access_count: 1000,
      last_accessed_at: now,
    }];
    const [r] = hybridRank(fts, [], [], {
      limit: 1,
      weights: { rrf: 0.65, timeDecay: 0.25, access: 0.10 },
    });
    assert.ok(r._score <= 1.0);
    assert.equal(r._trustMultiplier, 1.5);
  });

  it('trust=0 suppresses score even with high base signals', () => {
    const now = new Date().toISOString();
    const highBase = [{ session_id: 's1', started_at: now, access_count: 1000, last_accessed_at: now }];
    const suppressed = [{ session_id: 's2', started_at: now, trust_score: 0, access_count: 1000, last_accessed_at: now }];
    const [rHigh] = hybridRank(highBase, [], [], { limit: 1 });
    const [rSup] = hybridRank(suppressed, [], [], { limit: 1 });
    assert.ok(rSup._score < rHigh._score);
    assert.equal(rSup._trustMultiplier, 0.5);
  });
});

// ---------------------------------------------------------------------------
// hybrid-rank.js — Open-loop edge cases
// ---------------------------------------------------------------------------

describe('hybrid-rank.js — Open-loop edge cases', () => {
  it('empty openLoopSet → no boost for anyone', () => {
    const now = new Date().toISOString();
    const fts = [
      { session_id: 'a', started_at: now },
      { session_id: 'b', started_at: now },
    ];
    const result = hybridRank(fts, [], [], {
      limit: 2,
      openLoopSet: new Set(),
    });
    assert.ok(result.every(r => r._openLoopBoost === 0));
  });

  it('openLoopSet contains ALL sessions → relative order unchanged', () => {
    const fts = [
      { session_id: 'a', started_at: new Date(Date.now() - 1).toISOString() },
      { session_id: 'b', started_at: new Date(Date.now() - 2).toISOString() },
      { session_id: 'c', started_at: new Date(Date.now() - 3).toISOString() },
    ];
    const allSet = new Set(['a', 'b', 'c']);
    const result = hybridRank(fts, [], [], { limit: 3, openLoopSet: allSet });
    assert.ok(result[0]._openLoopBoost > 0);
    assert.ok(result[1]._openLoopBoost > 0);
    assert.ok(result[2]._openLoopBoost > 0);
    const boosts = result.map(r => r._openLoopBoost);
    assert.equal(boosts[0], boosts[1]);
    assert.equal(boosts[1], boosts[2]);
  });

  it('openLoop weight=0 → no effect even with openLoopSet', () => {
    const now = new Date().toISOString();
    const fts = [{ session_id: 'a', started_at: now }];
    const [r] = hybridRank(fts, [], [], {
      limit: 1,
      openLoopSet: new Set(['a']),
      weights: { openLoop: 0 },
    });
    assert.equal(r._openLoopBoost, 0);
  });

  it('openLoopSet with session not in any result → ignored silently', () => {
    const now = new Date().toISOString();
    const fts = [{ session_id: 'a', started_at: now }];
    const result = hybridRank(fts, [], [], {
      limit: 1,
      openLoopSet: new Set(['not-in-list']),
    });
    assert.equal(result[0]._openLoopBoost, 0);
  });
});

// ---------------------------------------------------------------------------
// hybrid-rank.js — Combined signal edge cases
// ---------------------------------------------------------------------------

describe('hybrid-rank.js — Combined signals', () => {
  it('trust=0 + open-loop + entity boost → trust suppression dominates', () => {
    const now = new Date().toISOString();
    const fts = [
      { session_id: 'a', started_at: now, trust_score: 0.0 },
    ];
    const result = hybridRank(fts, [], [], {
      limit: 1,
      openLoopSet: new Set(['a']),
      entityScoreBySession: new Map([['a', 1.0]]),
    });
    assert.equal(result[0]._trustMultiplier, 0.5);
    assert.equal(result[0]._openLoopBoost, 0.08);
    assert.ok(result[0]._score < 1.0);
  });

  it('trust=1 + no open-loop + no entity → trust alone elevates', () => {
    const now = new Date().toISOString();
    const fts = [{ session_id: 'a', started_at: now, trust_score: 1.0 }];
    const neutral = [{ session_id: 'b', started_at: now, trust_score: 0.5 }];
    const [rTrust] = hybridRank(fts, [], [], { limit: 1 });
    const [rNeutral] = hybridRank(neutral, [], [], { limit: 1 });
    assert.ok(rTrust._score > rNeutral._score);
    assert.equal(rTrust._trustMultiplier, 1.5);
  });

  it('trust=0 + trust=1 in same batch → high-trust wins', () => {
    const now = new Date().toISOString();
    const fts = [
      { session_id: 'low', started_at: now, trust_score: 0.0 },
      { session_id: 'high', started_at: now, trust_score: 1.0 },
    ];
    const result = hybridRank(fts, [], [], { limit: 2 });
    assert.equal(result[0].session_id, 'high');
    assert.ok(result[0]._trustMultiplier > result[1]._trustMultiplier);
  });
});

// ---------------------------------------------------------------------------
// entity.js — resolveEntities edge cases
// ---------------------------------------------------------------------------

describe('entity.js — resolveEntities edge cases', () => {
  it('empty names array → returns []', async () => {
    let queried = false;
    const mockPool = { async query() { queried = true; return { rows: [] }; } };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: [],
    });
    assert.deepEqual(result, []);
    assert.equal(queried, false);
  });

  it('null names → returns [] without querying', async () => {
    let queried = false;
    const mockPool = { async query() { queried = true; return { rows: [] }; } };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: null,
    });
    assert.deepEqual(result, []);
    assert.equal(queried, false);
  });

  it('single name resolves → returns one result with all fields', async () => {
    const mockPool = {
      async query() {
        return {
          rows: [{ id: 42, name: 'PostgreSQL', normalized_name: 'postgresql' }],
        };
      },
    };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: ['PostgreSQL'],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].entityId, 42);
    assert.equal(result[0].name, 'PostgreSQL');
    assert.equal(result[0].normalizedName, 'postgresql');
    assert.equal(result[0].inputName, 'PostgreSQL');
  });

  it('single name no match → returns []', async () => {
    const mockPool = { async query() { return { rows: [] }; } };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: ['UnknownEntity'],
    });
    assert.deepEqual(result, []);
  });

  it('case-variant duplicates (Pg, pg, PG) → deduped, one query', async () => {
    let queryCount = 0;
    const mockPool = {
        async query(_sql, _params) {
        queryCount++;
        return { rows: [{ id: 1, name: 'Pg', normalized_name: 'pg' }] };
      },
    };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: ['Pg', 'pg', 'PG'],
    });
    assert.equal(result.length, 1);
    assert.equal(queryCount, 1);
  });

  it('two different names resolve to same entityId → deduped by entityId', async () => {
    const mockPool = {
      async query(sql, params) {
        const name = params[1];
        if (name === 'postgres' || name === 'pg') {
          return { rows: [{ id: 42, name: 'PostgreSQL', normalized_name: 'postgres' }] };
        }
        return { rows: [] };
      },
    };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: ['postgres', 'pg'],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].entityId, 42);
  });

  it('whitespace/punctuation-only name → skipped (normalizeEntityName returns empty)', async () => {
    let queried = false;
    const mockPool = {
      async query() {
        queried = true;
        return { rows: [] };
      },
    };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: ['   ', '---', '()'],
    });
    assert.deepEqual(result, []);
    assert.equal(queried, false);
  });

  it('fullwidth unicode input → normalized before query', async () => {
    let params = null;
    const mockPool = {
      async query(sql, p) {
        params = p;
        return { rows: [] };
      },
    };
    await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: [' postgres'],
    });
    assert.equal(params[1], 'postgres');
    assert.equal(normalizeEntityName('　postgres　'), 'postgres');
  });
});

// ---------------------------------------------------------------------------
// entity.js — getSessionsByEntityIntersection edge cases
// ---------------------------------------------------------------------------

describe('entity.js — getSessionsByEntityIntersection edge cases', () => {
  it('empty entityIds → returns [] without querying', async () => {
    let queried = false;
    const mockPool = { async query() { queried = true; return { rows: [] }; } };
    const result = await getSessionsByEntityIntersection(mockPool, {
      schema: 'aq', entityIds: [], tenantId: 'x',
    });
    assert.deepEqual(result, []);
    assert.equal(queried, false);
  });

  it('null entityIds → returns [] without querying', async () => {
    let queried = false;
    const mockPool = { async query() { queried = true; return { rows: [] }; } };
    const result = await getSessionsByEntityIntersection(mockPool, {
      schema: 'aq', entityIds: null, tenantId: 'x',
    });
    assert.deepEqual(result, []);
    assert.equal(queried, false);
  });

  it('limit > 500 → clamped to 500', async () => {
    let capturedLimit = null;
    const mockPool = {
      async query(sql, params) {
        capturedLimit = params[params.length - 1];
        return { rows: [] };
      },
    };
    await getSessionsByEntityIntersection(mockPool, {
      schema: 'aq', entityIds: [1], tenantId: 'x', limit: 1000,
    });
    assert.equal(capturedLimit, 500);
  });

  it('limit < 1 → clamped to 1', async () => {
    let capturedLimit = null;
    const mockPool = {
      async query(sql, params) {
        capturedLimit = params[params.length - 1];
        return { rows: [] };
      },
    };
    await getSessionsByEntityIntersection(mockPool, {
      schema: 'aq', entityIds: [1], tenantId: 'x', limit: 0,
    });
    assert.equal(capturedLimit, 1);
    await getSessionsByEntityIntersection(mockPool, {
      schema: 'aq', entityIds: [1], tenantId: 'x', limit: -99,
    });
    assert.equal(capturedLimit, 1);
  });

  it('limit = 0 → clamped to 1', async () => {
    let capturedLimit = null;
    const mockPool = {
      async query(sql, params) {
        capturedLimit = params[params.length - 1];
        return { rows: [] };
      },
    };
    await getSessionsByEntityIntersection(mockPool, {
      schema: 'aq', entityIds: [1], tenantId: 'x', limit: 0,
    });
    assert.equal(capturedLimit, 1);
  });
});

// ---------------------------------------------------------------------------
// storage.js — recordFeedback edge cases
// ---------------------------------------------------------------------------

describe('storage.js — recordFeedback edge cases', () => {
  it('verdict=helpful → trust increases by 0.05', async () => {
    let updatedTrust = null;
    const mockPool = {
      async connect() {
        return {
          async query(sql, params) {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ trust_score: 0.5 }] };
            }
            if (sql.includes('UPDATE')) {
              updatedTrust = params[0];
            }
            return { rows: [] };
          },
          async release() {},
        };
      },
    };
    await storage.recordFeedback(mockPool, {
      schema: 'aq', tenantId: 'x', sessionRowId: 1,
      sessionId: 's1', agentId: 'a', verdict: 'helpful',
    });
    assert.equal(updatedTrust, 0.55);
  });

  it('verdict=unhelpful → trust decreases by 0.10', async () => {
    let updatedTrust = null;
    const mockPool = {
      async connect() {
        return {
          async query(sql, params) {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ trust_score: 0.8 }] };
            }
            if (sql.includes('UPDATE')) {
              updatedTrust = params[0];
            }
            return { rows: [] };
          },
          async release() {},
        };
      },
    };
    await storage.recordFeedback(mockPool, {
      schema: 'aq', tenantId: 'x', sessionRowId: 1,
      sessionId: 's1', agentId: 'a', verdict: 'unhelpful',
    });
    assert.ok(Math.abs(updatedTrust - 0.7) < 0.0001);
  });

  it('trust at 0 + unhelpful → stays 0, applied_delta = 0', async () => {
    let recordedTrustAfter = null;
    const mockPool = {
      async connect() {
        return {
          async query(sql, params) {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ trust_score: '0.00' }] };
            }
            if (sql.includes('INSERT INTO')) {
              recordedTrustAfter = params[7];
            }
            return { rows: [] };
          },
          async release() {},
        };
      },
    };
    const result = await storage.recordFeedback(mockPool, {
      schema: 'aq', tenantId: 'x', sessionRowId: 1,
      sessionId: 's1', agentId: 'a', verdict: 'unhelpful',
    });
    assert.equal(result.trustBefore, 0);
    assert.equal(result.trustAfter, 0);
    assert.equal(recordedTrustAfter, 0);
  });

  it('trust at 1 + helpful → stays 1', async () => {
    let updatedTrust = null;
    const mockPool = {
      async connect() {
        return {
          async query(sql, params) {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ trust_score: '1.00' }] };
            }
            if (sql.includes('UPDATE')) {
              updatedTrust = params[0];
            }
            return { rows: [] };
          },
          async release() {},
        };
      },
    };
    const result = await storage.recordFeedback(mockPool, {
      schema: 'aq', tenantId: 'x', sessionRowId: 1,
      sessionId: 's1', agentId: 'a', verdict: 'helpful',
    });
    assert.equal(result.trustBefore, 1);
    assert.equal(result.trustAfter, 1);
    assert.equal(updatedTrust, 1);
  });

  it('no summary row (FOR UPDATE returns empty) → throws Session not enriched', async () => {
    const mockPool = {
      async connect() {
        return {
          async query(sql) {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [] };
            }
            return { rows: [] };
          },
          async release() {},
        };
      },
    };
    await assert.rejects(
      () => storage.recordFeedback(mockPool, {
        schema: 'aq', tenantId: 'x', sessionRowId: 999,
        sessionId: 's1', agentId: 'a', verdict: 'helpful',
      }),
      /Session not enriched/
    );
  });

  it('trust at 0 + helpful → increases to 0.05 (no floor)', async () => {
    let updatedTrust = null;
    const mockPool = {
      async connect() {
        return {
          async query(sql, params) {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ trust_score: '0.00' }] };
            }
            if (sql.includes('UPDATE')) {
              updatedTrust = params[0];
            }
            return { rows: [] };
          },
          async release() {},
        };
      },
    };
    const result = await storage.recordFeedback(mockPool, {
      schema: 'aq', tenantId: 'x', sessionRowId: 1,
      sessionId: 's1', agentId: 'a', verdict: 'helpful',
    });
    assert.equal(result.trustAfter, 0.05);
    assert.equal(updatedTrust, 0.05);
  });

  it('trust at 0.04 + unhelpful → floors at 0', async () => {
    const mockPool = {
      async connect() {
        return {
          async query(sql, _params) {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ trust_score: 0.04 }] };
            }
            return { rows: [] };
          },
          async release() {},
        };
      },
    };
    const result = await storage.recordFeedback(mockPool, {
      schema: 'aq', tenantId: 'x', sessionRowId: 1,
      sessionId: 's1', agentId: 'a', verdict: 'unhelpful',
    });
    assert.equal(result.trustAfter, 0);
  });
});

// ---------------------------------------------------------------------------
// aquifer.js — feedback edge cases
// ---------------------------------------------------------------------------

describe('aquifer.js — feedback edge cases', () => {
  it('missing verdict → throws verdict is required', async () => {
    const aq = createAquifer({ db: 'postgres://fake', entities: { enabled: true } });
    await assert.rejects(
      () => aq.feedback('sess1', {}),
      /verdict is required/
    );
    await aq.close();
  });

  it('missing sessionId (session not found) → throws Session not found', async () => {
    const mockPool = {
      async query(sql) {
        if (sql.includes('WHERE session_id')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const aq = createAquifer({ db: mockPool, entities: { enabled: true } });
    await assert.rejects(
      () => aq.feedback('nonexistent', { verdict: 'helpful' }),
      /Session not found/
    );
    await aq.close();
  });

  it('verdict=null → throws verdict is required', async () => {
    const aq = createAquifer({ db: 'postgres://fake' });
    await assert.rejects(
      () => aq.feedback('sess1', { verdict: null }),
      /verdict is required/
    );
    await aq.close();
  });

  it('verdict=undefined → throws verdict is required', async () => {
    const aq = createAquifer({ db: 'postgres://fake' });
    await assert.rejects(
      () => aq.feedback('sess1', { verdict: undefined }),
      /verdict is required/
    );
    await aq.close();
  });
});

// ---------------------------------------------------------------------------
// aquifer.js — recall with entities edge cases
// ---------------------------------------------------------------------------

describe('aquifer.js — recall with entities edge cases', () => {
  it('entities with entitiesEnabled=false → throws Entities are not enabled', async () => {
    const aq = createAquifer({
      db: 'postgres://fake',
      embed: { fn: async () => [[0.1]], dim: 1 },
    });
    await assert.rejects(
      () => aq.recall('test', { entities: ['foo'] }),
      /Entities are not enabled/
    );
    await aq.close();
  });

  it('entities: [] → ignored, normal recall behavior', async () => {
    let embedCalled = false;
    const aq = createAquifer({
      db: {
        async query() { return { rows: [] }; },
      },
      embed: {
        fn: async () => { embedCalled = true; return [[0.1]]; },
        dim: 1,
      },
      entities: { enabled: true },
    });
    const result = await aq.recall('test query', { entities: [] });
    assert.ok(embedCalled);
    assert.deepEqual(result, []);
    await aq.close();
  });

  it('entityMode without entities → ignored (not all mode)', async () => {
    let embedCalled = false;
    const aq = createAquifer({
      db: {
        async query() { return { rows: [] }; },
      },
      embed: {
        fn: async () => { embedCalled = true; return [[0.1]]; },
        dim: 1,
      },
      entities: { enabled: true },
    });
    await aq.recall('test', { entityMode: 'all' });
    assert.ok(embedCalled);
    await aq.close();
  });

  it('entities + entityMode=all but entities disabled → throws', async () => {
    const aq = createAquifer({
      db: 'postgres://fake',
      embed: { fn: async () => [[0.1]], dim: 1 },
    });
    await assert.rejects(
      () => aq.recall('test', { entities: ['foo'], entityMode: 'all' }),
      /Entities are not enabled/
    );
    await aq.close();
  });

  it('recall with explicit empty entities → no resolveEntities call (skipped by guard), searchEntities path entered', async () => {
    let resolveEntitiesAttempted = false;
      const mockPool = {
      async query(sql) {
        if (sql.includes('FOR UPDATE') && sql.includes('entity')) {
          resolveEntitiesAttempted = true;
        }
        return { rows: [] };
      },
    };
    const aq = createAquifer({
      db: mockPool,
      embed: { fn: async () => [[0.1]], dim: 1 },
      entities: { enabled: true },
    });
    await aq.recall('test', { entities: [] });
    assert.equal(resolveEntitiesAttempted, false, 'resolveEntities should not be called');
    await aq.close();
  });
});
