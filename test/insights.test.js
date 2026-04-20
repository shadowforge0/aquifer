'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createInsights, defaultCanonicalKey, normalizeCanonicalClaim, normalizeBody, normalizeEntitySet } = require('../core/insights');

// Mock pool recording queries and replying with programmable rows.
function makePool(replies = []) {
  const queries = [];
  let i = 0;
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const reply = replies[i++] || { rows: [], rowCount: 0 };
      return reply;
    },
  };
}

describe('insights.commitInsight auto-generated idempotency key', () => {
  const baseInput = {
    agentId: 'main', type: 'pattern', title: 't', body: 'body-x',
    sourceSessionIds: ['s2', 's1'],
    evidenceWindow: { from: '2026-04-01T00:00:00Z', to: '2026-04-19T00:00:00Z' },
  };
  const stubRow = {
    id: 42, tenant_id: 'default', agent_id: 'main', insight_type: 'pattern',
    title: 't', body: 'b', importance: 0.5, status: 'active',
    idempotency_key: 'stub', metadata: {}, created_at: '2026-04-01', updated_at: '2026-04-01',
    source_session_ids: [], evidence_window: '[2026-04-01,2026-04-19)',
  };

  async function capturedKey(input) {
    const pool = makePool([{ rowCount: 1, rows: [stubRow] }]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    await api.commitInsight(input);
    return pool.queries[0].params[0];
  }

  it('identical inputs produce identical auto keys across separate calls', async () => {
    const k1 = await capturedKey(baseInput);
    const k2 = await capturedKey(baseInput);
    assert.equal(k1, k2);
    assert.match(k1, /^[0-9a-f]{64}$/);
  });

  it('session id order does not affect the auto key (sorted internally)', async () => {
    const k1 = await capturedKey(baseInput);
    const k2 = await capturedKey({ ...baseInput, sourceSessionIds: ['s1', 's2'] });
    assert.equal(k1, k2);
  });

  it('mutating body produces a distinct auto key (legitimate revision)', async () => {
    const k1 = await capturedKey(baseInput);
    const k2 = await capturedKey({ ...baseInput, body: 'body-y' });
    assert.notEqual(k1, k2);
  });

  it('extending the evidence window produces a distinct auto key', async () => {
    const k1 = await capturedKey(baseInput);
    const k2 = await capturedKey({
      ...baseInput,
      evidenceWindow: { from: '2026-04-01T00:00:00Z', to: '2026-04-25T00:00:00Z' },
    });
    assert.notEqual(k1, k2);
  });
});

describe('insights.commitInsight input validation', () => {
  function api(pool) {
    return createInsights({
      pool: pool || makePool(),
      schema: '"aq"',
      defaultTenantId: 'default',
    });
  }

  it('requires agentId', async () => {
    const r = await api().commitInsight({ type: 'pattern', title: 't', body: 'b' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
    assert.match(r.error.message, /agentId/);
  });

  it('rejects unknown type', async () => {
    const r = await api().commitInsight({
      agentId: 'main', type: 'random', title: 't', body: 'b',
      sourceSessionIds: ['s1'], evidenceWindow: { from: '2026-04-01', to: '2026-04-19' },
    });
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
    assert.match(r.error.message, /type/);
  });

  it('rejects empty title / body', async () => {
    const base = {
      agentId: 'main', type: 'pattern',
      sourceSessionIds: ['s1'], evidenceWindow: { from: '2026-04-01', to: '2026-04-19' },
    };
    const r1 = await api().commitInsight({ ...base, title: ' ', body: 'b' });
    assert.match(r1.error.message, /title/);
    const r2 = await api().commitInsight({ ...base, title: 't', body: '' });
    assert.match(r2.error.message, /body/);
  });

  it('requires non-empty sourceSessionIds', async () => {
    const r = await api().commitInsight({
      agentId: 'main', type: 'pattern', title: 't', body: 'b',
      sourceSessionIds: [],
      evidenceWindow: { from: '2026-04-01', to: '2026-04-19' },
    });
    assert.match(r.error.message, /sourceSessionIds/);
  });

  it('requires evidenceWindow.from and .to', async () => {
    const r = await api().commitInsight({
      agentId: 'main', type: 'pattern', title: 't', body: 'b',
      sourceSessionIds: ['s1'], evidenceWindow: { from: '2026-04-01' },
    });
    assert.match(r.error.message, /evidenceWindow/);
  });

  it('rejects importance out of [0,1]', async () => {
    const r = await api().commitInsight({
      agentId: 'main', type: 'pattern', title: 't', body: 'b',
      sourceSessionIds: ['s1'], evidenceWindow: { from: '2026-04-01', to: '2026-04-19' },
      importance: 1.5,
    });
    assert.match(r.error.message, /importance/);
  });
});

describe('insights.commitInsight happy path (mocked pool)', () => {
  it('idempotent replay returns duplicate=true from existing row', async () => {
    const existing = {
      id: 42, tenant_id: 'default', agent_id: 'main', insight_type: 'pattern',
      title: 't', body: 'b', importance: 0.8, status: 'active',
      idempotency_key: 'fixed', metadata: {}, created_at: '2026-04-01', updated_at: '2026-04-01',
      source_session_ids: ['s1'], evidence_window: '[2026-04-01,2026-04-19)',
    };
    const pool = makePool([{ rowCount: 1, rows: [existing] }]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.commitInsight({
      agentId: 'main', type: 'pattern', title: 't', body: 'b',
      sourceSessionIds: ['s1'], evidenceWindow: { from: '2026-04-01', to: '2026-04-19' },
      idempotencyKey: 'fixed',
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.duplicate, true);
    assert.equal(r.data.insight.id, 42);
  });

  it('first write: preflight miss → INSERT, returns mapped row', async () => {
    const inserted = {
      id: 100, tenant_id: 'default', agent_id: 'main', insight_type: 'preference',
      title: 'title', body: 'body', importance: 0.5, status: 'active',
      idempotency_key: 'k', metadata: {}, created_at: 'now', updated_at: 'now',
      source_session_ids: ['s1', 's2'], evidence_window: '[2026-04-01,2026-04-19)',
    };
    const pool = makePool([
      { rowCount: 0, rows: [] },  // idempotency preflight miss
      { rowCount: 0, rows: [] },  // canonical_key_v2 preflight miss
      { rowCount: 1, rows: [inserted] },  // INSERT
    ]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.commitInsight({
      agentId: 'main', type: 'preference', title: 'title', body: 'body',
      sourceSessionIds: ['s1', 's2'],
      evidenceWindow: { from: '2026-04-01', to: '2026-04-19' },
      idempotencyKey: 'k',
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.duplicate, false);
    assert.equal(r.data.insight.id, 100);
    // Verify INSERT SQL was sent with tstzrange cast.
    assert.match(pool.queries[2].sql, /tstzrange/);
  });

  it('embedFn failure is non-fatal — insight still writes without embedding', async () => {
    const pool = makePool([
      { rowCount: 0, rows: [] },  // idempotency miss
      { rowCount: 0, rows: [] },  // canonical miss
      { rowCount: 1, rows: [{ id: 1, title: 't', body: 'b', source_session_ids: [], metadata: {} }] },
    ]);
    const embedFn = async () => { throw new Error('embed provider down'); };
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default', embedFn });
    const r = await api.commitInsight({
      agentId: 'main', type: 'pattern', title: 't', body: 'b',
      sourceSessionIds: ['s1'], evidenceWindow: { from: '2026-04-01', to: '2026-04-19' },
    });
    assert.equal(r.ok, true);
    // embedding param in INSERT should be null
    const insertParams = pool.queries[2].params;
    assert.equal(insertParams[7], null, 'embedding param should be null on embed failure');
  });
});

describe('insights.commitInsight canonical preflight (Phase 2 C1)', () => {
  const baseInput = {
    agentId: 'main', type: 'preference',
    title: '偏好散文不用 bullet', body: 'mk prefers prose format over bullet lists',
    canonicalClaim: 'mk prefers prose format over bullet lists',
    entities: ['formatting'],
    sourceSessionIds: ['s1'],
    evidenceWindow: { from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z' },
  };

  it('Rule 4 stale replay: older window returns existing active as duplicate', async () => {
    const activeRow = {
      id: 7, tenant_id: 'default', agent_id: 'main', insight_type: 'preference',
      title: 'prior', body: 'prior body',
      source_session_ids: ['s1'], evidence_window: '[2026-03-01 00:00:00+00,2026-03-31 00:00:00+00)',
      status: 'active', idempotency_key: 'old', canonical_key_v2: 'ckey', metadata: {},
      created_at: '2026-03-15', updated_at: '2026-03-15', importance: 0.5, superseded_by: null,
    };
    const pool = makePool([
      { rowCount: 0, rows: [] },           // idempotency miss
      { rowCount: 1, rows: [activeRow] },  // canonical hit, active
    ]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.commitInsight({
      ...baseInput,
      evidenceWindow: { from: '2026-03-01T00:00:00Z', to: '2026-03-15T00:00:00Z' }, // older than active
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.duplicate, true, 'stale replay should return existing as duplicate');
    assert.equal(r.data.insight.id, 7);
    assert.equal(pool.queries.length, 2, 'should not INSERT on stale replay');
  });

  it('Rule 2/3 revision: newer window inserts and supersedes prior active', async () => {
    const activeRow = {
      id: 7, tenant_id: 'default', agent_id: 'main', insight_type: 'preference',
      title: 'prior', body: 'prior body',
      source_session_ids: ['s1'], evidence_window: '[2026-03-01 00:00:00+00,2026-03-31 00:00:00+00)',
      status: 'active', idempotency_key: 'old', canonical_key_v2: 'ckey', metadata: {},
      created_at: '2026-03-15', updated_at: '2026-03-15', importance: 0.5, superseded_by: null,
    };
    const newRow = {
      id: 8, tenant_id: 'default', agent_id: 'main', insight_type: 'preference',
      title: baseInput.title, body: 'mk prefers prose format over bullet lists; also no headers',
      source_session_ids: ['s1', 's2'], evidence_window: '[2026-03-01 00:00:00+00,2026-04-30 00:00:00+00)',
      status: 'active', idempotency_key: 'newrev', canonical_key_v2: 'ckey', metadata: {},
      created_at: '2026-04-19', updated_at: '2026-04-19', importance: 0.7, superseded_by: null,
    };
    const pool = makePool([
      { rowCount: 0, rows: [] },           // idempotency miss
      { rowCount: 1, rows: [activeRow] },  // canonical hit
      { rowCount: 1, rows: [newRow] },     // INSERT
      { rowCount: 1, rows: [{ id: 7, status: 'superseded' }] },  // UPDATE supersede
    ]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.commitInsight({
      ...baseInput,
      body: 'mk prefers prose format over bullet lists; also no headers',
      sourceSessionIds: ['s1', 's2'],
      evidenceWindow: { from: '2026-03-01T00:00:00Z', to: '2026-04-30T00:00:00Z' }, // extended
      importance: 0.7,
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.duplicate, false);
    assert.equal(r.data.insight.id, 8, 'returns the newly-inserted revision');
    assert.equal(pool.queries.length, 4, 'idempotency + canonical preflight + INSERT + supersede');
    assert.match(pool.queries[3].sql, /status = 'superseded'/, 'supersede UPDATE runs');
    assert.deepEqual(pool.queries[3].params, [7, 8]);
  });

  it('no existing canonical → inserts fresh with canonical_key_v2 populated', async () => {
    const newRow = {
      id: 1, tenant_id: 'default', agent_id: 'main', insight_type: 'preference',
      title: baseInput.title, body: baseInput.body,
      source_session_ids: ['s1'], evidence_window: '[2026-03-01 00:00:00+00,2026-03-31 00:00:00+00)',
      status: 'active', idempotency_key: 'k', canonical_key_v2: 'ck', metadata: {},
      created_at: 'now', updated_at: 'now', importance: 0.5, superseded_by: null,
    };
    const pool = makePool([
      { rowCount: 0, rows: [] }, // idempotency miss
      { rowCount: 0, rows: [] }, // canonical miss
      { rowCount: 1, rows: [newRow] }, // INSERT
    ]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.commitInsight(baseInput);
    assert.equal(r.ok, true);
    assert.equal(r.data.duplicate, false);
    // canonical_key_v2 is param $11 in the INSERT
    assert.ok(pool.queries[2].params[10], 'canonical_key_v2 INSERT param should be non-empty');
    // no supersede UPDATE issued
    assert.equal(pool.queries.length, 3);
  });

  it('title fallback when canonicalClaim is absent: metadata.dedupQuality = "title_fallback"', async () => {
    const newRow = {
      id: 1, tenant_id: 'default', agent_id: 'main', insight_type: 'preference',
      title: 't', body: 'b',
      source_session_ids: ['s1'], evidence_window: '[2026-03-01 00:00:00+00,2026-03-31 00:00:00+00)',
      status: 'active', idempotency_key: 'k', canonical_key_v2: 'ck',
      metadata: { dedupQuality: 'title_fallback' },
      created_at: 'now', updated_at: 'now', importance: 0.5, superseded_by: null,
    };
    const pool = makePool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [newRow] },
    ]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.commitInsight({
      agentId: 'main', type: 'preference', title: 't', body: 'b',
      sourceSessionIds: ['s1'],
      evidenceWindow: { from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z' },
    });
    assert.equal(r.ok, true);
    // metadata param is $12 (index 11 in INSERT params)
    const metaParam = JSON.parse(pool.queries[2].params[11]);
    assert.equal(metaParam.dedupQuality, 'title_fallback');
  });

  it('different entities produce different canonical_key_v2 (no cross-dedup)', async () => {
    // Two separate commits, both see empty preflight → both INSERT.
    const newRow = (id) => ({
      id, tenant_id: 'default', agent_id: 'main', insight_type: 'preference',
      title: 't', body: 'b', source_session_ids: ['s1'],
      evidence_window: '[2026-03-01 00:00:00+00,2026-03-31 00:00:00+00)',
      status: 'active', idempotency_key: `k${id}`, canonical_key_v2: `ck${id}`,
      metadata: {}, created_at: 'now', updated_at: 'now', importance: 0.5, superseded_by: null,
    });
    const pool = makePool([
      { rowCount: 0, rows: [] }, { rowCount: 0, rows: [] }, { rowCount: 1, rows: [newRow(1)] },
      { rowCount: 0, rows: [] }, { rowCount: 0, rows: [] }, { rowCount: 1, rows: [newRow(2)] },
    ]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r1 = await api.commitInsight({
      ...baseInput, canonicalClaim: 'x', entities: ['Claude Code'],
    });
    const r2 = await api.commitInsight({
      ...baseInput, canonicalClaim: 'x', entities: ['OpenCode'],
    });
    assert.equal(r1.ok, true); assert.equal(r2.ok, true);
    // Each got its own INSERT (no dedup).
    const canonA = pool.queries[2].params[10];
    const canonB = pool.queries[5].params[10];
    assert.notEqual(canonA, canonB, 'different entities → different canonical_key_v2');
  });
});

describe('insights.recallInsights', () => {
  it('requires agentId', async () => {
    const pool = makePool();
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.recallInsights('q', {});
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });

  it('empty query blends importance × recency linear decay', async () => {
    const rows = [
      { id: 1, importance: 0.9, created_at: 'now', source_session_ids: [], metadata: {}, _score: 0.9 },
      { id: 2, importance: 0.5, created_at: 'yesterday', source_session_ids: [], metadata: {}, _score: 0.5 },
    ];
    const pool = makePool([{ rowCount: 2, rows }]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.recallInsights('', { agentId: 'main', limit: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.data.rows.length, 2);
    const { sql, params } = pool.queries[0];
    assert.match(sql, /importance \+/);
    assert.match(sql, /GREATEST\(0, 1\.0 -/);
    assert.match(sql, /ORDER BY _score DESC/);
    // recencyWindow (default 90) must appear as a param.
    assert.ok(params.includes(90), 'default recencyWindow=90 passed as param');
  });

  it('empty query honours createAquifer config.insights.recencyWindowDays override', async () => {
    const pool = makePool([{ rowCount: 0, rows: [] }]);
    const api = createInsights({
      pool, schema: '"aq"', defaultTenantId: 'default', recencyWindowDays: 30,
    });
    await api.recallInsights('', { agentId: 'main' });
    assert.ok(pool.queries[0].params.includes(30), 'custom recencyWindow=30 passed as param');
  });

  it('returns AQ_DEPENDENCY when query given but no embedFn configured', async () => {
    const pool = makePool();
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });  // no embedFn
    const r = await api.recallInsights('find my preferences', { agentId: 'main' });
    assert.equal(r.error.code, 'AQ_DEPENDENCY');
  });

  it('semantic query: sends vector param + weight params', async () => {
    const pool = makePool([{ rowCount: 1, rows: [{ id: 1, source_session_ids: [], metadata: {}, _score: 0.8, _semantic_score: 0.9 }] }]);
    const embedFn = async () => [[0.1, 0.2, 0.3]];
    const api = createInsights({
      pool, schema: '"aq"', defaultTenantId: 'default', embedFn,
      recallWeights: { semantic: 0.7, importance: 0.2, recency: 0.1 },
    });
    const r = await api.recallInsights('find patterns', { agentId: 'main' });
    assert.equal(r.ok, true);
    assert.equal(r.data.rows[0].score, 0.8);
    const { sql, params } = pool.queries[0];
    assert.match(sql, /embedding <=>/);
    assert.ok(params.some(p => typeof p === 'string' && p.startsWith('[')), 'vector literal passed');
    assert.ok(params.includes(0.7));  // semantic weight
    assert.ok(params.includes(0.2));  // importance weight
    assert.ok(params.includes(0.1));  // recency weight
  });

  it('filters by type when specified', async () => {
    const pool = makePool([{ rowCount: 0, rows: [] }]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    await api.recallInsights('', { agentId: 'main', type: 'preference' });
    assert.ok(pool.queries[0].params.includes('preference'));
  });

  it('rejects unknown type', async () => {
    const pool = makePool();
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.recallInsights('', { agentId: 'main', type: 'lol' });
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
  });
});

describe('insights.markStale and supersede', () => {
  it('markStale returns AQ_NOT_FOUND when no row updated', async () => {
    const pool = makePool([{ rowCount: 0, rows: [] }]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.markStale(99);
    assert.equal(r.error.code, 'AQ_NOT_FOUND');
  });

  it('supersede verifies tenant/agent + sets new pointer', async () => {
    const pool = makePool([
      // Tenant/agent validation query — both rows same tenant/agent.
      { rowCount: 2, rows: [
        { id: 1, tenant_id: 'default', agent_id: 'main' },
        { id: 5, tenant_id: 'default', agent_id: 'main' },
      ] },
      // Actual UPDATE.
      { rowCount: 1, rows: [{ id: 1, status: 'superseded', superseded_by: 5 }] },
    ]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.supersede(1, 5);
    assert.equal(r.ok, true);
    assert.equal(r.data.supersededBy, 5);
  });

  it('supersede rejects self-cycle', async () => {
    const api = createInsights({ pool: makePool(), schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.supersede(1, 1);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
    assert.match(r.error.message, /self-supersede/);
  });

  it('supersede rejects cross-tenant', async () => {
    const pool = makePool([
      { rowCount: 2, rows: [
        { id: 1, tenant_id: 'a', agent_id: 'main' },
        { id: 5, tenant_id: 'b', agent_id: 'main' },
      ] },
    ]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.supersede(1, 5);
    assert.equal(r.error.code, 'AQ_CONFLICT');
    assert.match(r.error.message, /crosses tenant/);
  });
});

describe('insights.normalizeCanonicalClaim', () => {
  it('collapses multiple whitespace to single space', () => {
    assert.equal(normalizeCanonicalClaim('a   b    c'), 'a b c');
  });

  it('strips leading/trailing punctuation', () => {
    assert.equal(normalizeCanonicalClaim('!!hello??'), 'hello');
    assert.equal(normalizeCanonicalClaim('[hello]'), 'hello');
    assert.equal(normalizeCanonicalClaim('(hello)'), 'hello');
  });

  it('converts to lowercase', () => {
    assert.equal(normalizeCanonicalClaim('HELLO'), 'hello');
    assert.equal(normalizeCanonicalClaim('HeLLo WoRLd'), 'hello world');
  });

  it('normalizes Unicode NFKC (fullwidth to halfwidth)', () => {
    assert.equal(normalizeCanonicalClaim(('ｃｏｄｅ')), 'code');
    assert.equal(normalizeCanonicalClaim('認證'), '認證');
  });

  it('returns empty string for null/undefined/non-string', () => {
    assert.equal(normalizeCanonicalClaim(null), '');
    assert.equal(normalizeCanonicalClaim(undefined), '');
    assert.equal(normalizeCanonicalClaim(123), '');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normalizeCanonicalClaim(''), '');
  });

  it('example: "  MK prefers Checking context. " → "mk prefers checking context"', () => {
    assert.equal(normalizeCanonicalClaim('  MK prefers Checking context. '), 'mk prefers checking context');
  });

  it('example: "認證 中介層 設計！" → "認證 中介層 設計"', () => {
    assert.equal(normalizeCanonicalClaim('認證 中介層 設計！'), '認證 中介層 設計');
  });
});

describe('insights.normalizeBody', () => {
  it('shares the same normalization logic as normalizeCanonicalClaim', () => {
    assert.equal(normalizeBody('  MK prefers Checking context. '), 'mk prefers checking context');
    assert.equal(normalizeBody('認證 中介層 設計！'), '認證 中介層 設計');
    assert.equal(normalizeBody(null), '');
  });
});

describe('insights.normalizeEntitySet', () => {
  it('order does not affect result', () => {
    assert.equal(normalizeEntitySet(['a', 'b']), normalizeEntitySet(['b', 'a']));
  });

  it('deduplicates entries', () => {
    assert.equal(normalizeEntitySet(['a', 'a', 'b']), 'a|b');
  });

  it('returns empty string for empty array', () => {
    assert.equal(normalizeEntitySet([]), '');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(normalizeEntitySet(null), '');
    assert.equal(normalizeEntitySet(undefined), '');
  });

  it('normalizes case (lowercases via normalizeEntityName)', () => {
    assert.equal(normalizeEntitySet(['Claude Code', 'claude code']), 'claude code');
  });

  it('example: ["Claude Code", "claude code", ""] → "claude code"', () => {
    assert.equal(normalizeEntitySet(['Claude Code', 'claude code', '']), 'claude code');
  });

  it('example: ["OpenCode", "Claude Code"] → "claude code|opencode"', () => {
    assert.equal(normalizeEntitySet(['OpenCode', 'Claude Code']), 'claude code|opencode');
  });
});

describe('insights.defaultCanonicalKey', () => {
  it('identical canonicalClaim after normalize produces same key', () => {
    const a = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'preference',
      canonicalClaim: 'MK prefers X', entities: ['a'],
    });
    const b = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'preference',
      canonicalClaim: 'mk prefers x!', entities: ['a'],
    });
    assert.equal(a, b);
  });

  it('different canonicalClaim produces different key', () => {
    const a = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'preference',
      canonicalClaim: 'likes coffee', entities: [],
    });
    const b = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'preference',
      canonicalClaim: 'likes tea', entities: [],
    });
    assert.notEqual(a, b);
  });

  it('entities order does not affect key', () => {
    const a = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'pattern',
      canonicalClaim: 'x', entities: ['a', 'b'],
    });
    const b = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'pattern',
      canonicalClaim: 'x', entities: ['b', 'a'],
    });
    assert.equal(a, b);
  });

  it('empty vs non-empty entities produces different key', () => {
    const a = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'pattern',
      canonicalClaim: 'x', entities: [],
    });
    const b = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'pattern',
      canonicalClaim: 'x', entities: ['a'],
    });
    assert.notEqual(a, b);
  });

  it('different type produces different key', () => {
    const a = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'preference',
      canonicalClaim: 'x', entities: [],
    });
    const b = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'pattern',
      canonicalClaim: 'x', entities: [],
    });
    assert.notEqual(a, b);
  });

  it('different agentId produces different key', () => {
    const a = defaultCanonicalKey({
      tenantId: 't', agentId: 'agent1', type: 'preference',
      canonicalClaim: 'x', entities: [],
    });
    const b = defaultCanonicalKey({
      tenantId: 't', agentId: 'agent2', type: 'preference',
      canonicalClaim: 'x', entities: [],
    });
    assert.notEqual(a, b);
  });

  it('different tenantId produces different key', () => {
    const a = defaultCanonicalKey({
      tenantId: 'tenant1', agentId: 'main', type: 'preference',
      canonicalClaim: 'x', entities: [],
    });
    const b = defaultCanonicalKey({
      tenantId: 'tenant2', agentId: 'main', type: 'preference',
      canonicalClaim: 'x', entities: [],
    });
    assert.notEqual(a, b);
  });

  it('returns 64-character hex (sha256)', () => {
    const key = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'preference',
      canonicalClaim: 'x', entities: [],
    });
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it('empty canonicalClaim uses empty string as hash input (does not throw)', () => {
    const key = defaultCanonicalKey({
      tenantId: 't', agentId: 'main', type: 'preference',
      canonicalClaim: '', entities: [],
    });
    assert.equal(key.length, 64);
  });
});

describe('createInsights dedup', () => {
  const baseInput = {
    agentId: 'main',
    type: 'pattern',
    title: 'Pattern title',
    body: 'Body text',
    sourceSessionIds: ['s1'],
    evidenceWindow: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
  };

  function withConsoleStub(method, fn) {
    const original = console[method];
    const calls = [];
    console[method] = (...args) => { calls.push(args); };
    return Promise.resolve()
      .then(() => fn(calls))
      .finally(() => {
        console[method] = original;
      });
  }

  function makeInsertedRow(metadata = {}, id = 10) {
    return {
      id,
      tenant_id: 'default',
      agent_id: 'main',
      insight_type: 'pattern',
      title: 'Pattern title',
      body: 'Body text',
      source_session_ids: ['s1'],
      evidence_window: '[2026-01-01 00:00:00+00,2026-01-02 00:00:00+00)',
      importance: 0.5,
      status: 'active',
      idempotency_key: 'k',
      canonical_key_v2: 'ck',
      metadata,
      created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      superseded_by: null,
    };
  }

  function makeCandidateRow(overrides = {}) {
    return {
      id: 42,
      tenant_id: 'default',
      agent_id: 'main',
      insight_type: 'pattern',
      title: 'Candidate title',
      body: 'Candidate body text that should be normalized for metadata.',
      source_session_ids: ['s0'],
      evidence_window: '[2026-01-01 00:00:00+00,2020-01-01 00:00:00+00)',
      importance: 0.7,
      status: 'active',
      idempotency_key: 'old',
      canonical_key_v2: 'old-ck',
      metadata: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      superseded_by: null,
      cos_sim: 0.92,
      ...overrides,
    };
  }

  function makeDedupPool(replies = []) {
    return makePool([{ rowCount: 1, rows: [{ n: 0 }] }, ...replies]);
  }

  it('mode=off default behaviour unchanged', async () => {
    const pool = makePool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [makeInsertedRow()] },
    ]);
    const api = createInsights({ pool, schema: '"aq"', defaultTenantId: 'default' });
    const r = await api.commitInsight(baseInput);
    assert.equal(r.ok, true);
    assert.equal(pool.queries.some(q => /<=>/.test(q.sql)), false);
    assert.equal(api._internal.dedup.mode, 'off');
  });

  it('mode=shadow at init + no embedFn', async () => {
    await withConsoleStub('warn', async (warns) => {
      createInsights({ pool: makeDedupPool(), schema: '"aq"', defaultTenantId: 'default', dedup: { mode: 'shadow' } });
      assert.ok(warns.some(args => String(args[0]).includes('embedFn unavailable')));
    });
  });

  it('mode=enforce + valid config + embedFn', async () => {
    await withConsoleStub('log', async (logs) => {
      createInsights({
        pool: makeDedupPool(),
        schema: '"aq"',
        defaultTenantId: 'default',
        dedup: { mode: 'enforce' },
        embedFn: async () => [[0.1, 0.2]],
      });
      assert.ok(logs.some(args => String(args[0]).includes('mode=enforce threshold=0.88')));
    });
  });

  it('cosineThreshold=2.5', async () => {
    await withConsoleStub('warn', async (warns) => {
      const api = createInsights({
        pool: makeDedupPool(), schema: '"aq"', defaultTenantId: 'default', embedFn: async () => [[0.1]],
        dedup: { mode: 'enforce', cosineThreshold: 2.5 },
      });
      assert.equal(api._internal.dedup.cosineThreshold, 1);
      assert.ok(warns.some(args => String(args[0]).includes('cosineThreshold 2.5')));
    });
  });

  it('cosineThreshold=NaN', async () => {
    await withConsoleStub('warn', async (warns) => {
      const api = createInsights({
        pool: makeDedupPool(), schema: '"aq"', defaultTenantId: 'default', embedFn: async () => [[0.1]],
        dedup: { mode: 'enforce', cosineThreshold: NaN },
      });
      assert.equal(api._internal.dedup.cosineThreshold, 0.88);
      assert.ok(warns.some(args => String(args[0]).includes('invalid cosineThreshold')));
    });
  });

  it('closeBandFrom=0.95 threshold=0.88', async () => {
    await withConsoleStub('warn', async (warns) => {
      const api = createInsights({
        pool: makeDedupPool(), schema: '"aq"', defaultTenantId: 'default', embedFn: async () => [[0.1]],
        dedup: { mode: 'enforce', cosineThreshold: 0.88, closeBandFrom: 0.95 },
      });
      assert.equal(api._internal.dedup.closeBandFrom, 0.85);
      assert.ok(warns.some(args => String(args[0]).includes('closeBandFrom 0.95')));
    });
  });

  it("mode='Shadow '", async () => {
    const api = createInsights({
      pool: makeDedupPool(), schema: '"aq"', defaultTenantId: 'default', embedFn: async () => [[0.1]],
      dedup: { mode: 'Shadow ' },
    });
    assert.equal(api._internal.dedup.mode, 'shadow');
  });

  it("mode='explode'", async () => {
    await withConsoleStub('warn', async (warns) => {
      const api = createInsights({
        pool: makeDedupPool(), schema: '"aq"', defaultTenantId: 'default', embedFn: async () => [[0.1]],
        dedup: { mode: 'explode' },
      });
      assert.equal(api._internal.dedup.mode, 'off');
      assert.ok(warns.some(args => String(args[0]).includes('invalid mode')));
    });
  });

  it('dedup=true shorthand', () => {
    const api = createInsights({
      pool: makeDedupPool(), schema: '"aq"', defaultTenantId: 'default', embedFn: async () => [[0.1]], dedup: true,
    });
    assert.deepEqual(api._internal.dedup, { mode: 'enforce', cosineThreshold: 0.88, closeBandFrom: 0.85 });
  });

  it('dedup=false shorthand', () => {
    const api = createInsights({ pool: makePool(), schema: '"aq"', defaultTenantId: 'default', dedup: false });
    assert.deepEqual(api._internal.dedup, { mode: 'off', cosineThreshold: 0.88, closeBandFrom: 0.85 });
  });

  it('env AQUIFER_INSIGHTS_DEDUP_MODE=off + code mode=enforce', () => {
    const prev = process.env.AQUIFER_INSIGHTS_DEDUP_MODE;
    process.env.AQUIFER_INSIGHTS_DEDUP_MODE = 'off';
    try {
      const api = createInsights({
        pool: makeDedupPool(), schema: '"aq"', defaultTenantId: 'default', embedFn: async () => [[0.1]],
        dedup: { mode: 'enforce' },
      });
      assert.equal(api._internal.dedup.mode, 'off');
    } finally {
      if (prev === undefined) delete process.env.AQUIFER_INSIGHTS_DEDUP_MODE;
      else process.env.AQUIFER_INSIGHTS_DEDUP_MODE = prev;
    }
  });

  it('enforce match cos=0.92', async () => {
    const inserted = makeInsertedRow({ dedupVia: 'semantic', dedupCandidate: { id: 42, cosine: 0.92 } }, 99);
    const pool = makeDedupPool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [makeCandidateRow({ evidence_window: '[2019-01-01 00:00:00+00,2020-01-01 00:00:00+00)' })] },
      { rowCount: 1, rows: [inserted] },
      { rowCount: 1, rows: [{ id: 42, status: 'superseded', superseded_by: 99 }] },
    ]);
    const api = createInsights({
      pool, schema: '"aq"', defaultTenantId: 'default', dedup: { mode: 'enforce' }, embedFn: async () => [[0.1, 0.2]],
    });
    const r = await api.commitInsight(baseInput);
    assert.equal(r.ok, true);
    assert.equal(r.data.duplicate, false);
    assert.equal(r.data.insight.metadata.dedupVia, 'semantic');
    assert.deepEqual(r.data.insight.metadata.dedupCandidate, { id: 42, cosine: 0.92 });
    assert.ok(pool.queries.some(q => /ORDER BY embedding <=>/.test(q.sql)));
    assert.ok(pool.queries.some(q => /UPDATE .*status = 'superseded'/.test(q.sql)));
  });

  it('enforce stale replay', async () => {
    const candidate = makeCandidateRow({ evidence_window: '[2029-01-01 00:00:00+00,2030-01-01 00:00:00+00)' });
    const pool = makeDedupPool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [candidate] },
    ]);
    const api = createInsights({
      pool, schema: '"aq"', defaultTenantId: 'default', dedup: { mode: 'enforce' }, embedFn: async () => [[0.1, 0.2]],
    });
    const r = await api.commitInsight(baseInput);
    assert.equal(r.ok, true);
    assert.equal(r.data.duplicate, true);
    assert.equal(r.data.insight.id, 42);
    assert.equal(pool.queries.some(q => /^INSERT INTO/.test(q.sql)), false);
  });

  it('shadow match cos=0.92', async () => {
    const inserted = makeInsertedRow({
      shadowMatch: {
        candidateId: 42,
        cosine: 0.92,
        threshold: 0.88,
        candidateTitle: 'Candidate title',
        candidateBody: 'candidate body text that should be normalized for metadata.',
        wouldSupersede: true,
        ranAt: '2026-01-03T00:00:00.000Z',
      },
    }, 77);
    const pool = makeDedupPool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [makeCandidateRow()] },
      { rowCount: 1, rows: [inserted] },
    ]);
    const originalToISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = function toISOString() { return '2026-01-03T00:00:00.000Z'; };
    try {
      const api = createInsights({
        pool, schema: '"aq"', defaultTenantId: 'default', dedup: { mode: 'shadow' }, embedFn: async () => [[0.1, 0.2]],
      });
      const r = await api.commitInsight(baseInput);
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);
      assert.ok(r.data.insight.metadata.shadowMatch);
      assert.equal(r.data.insight.metadata.dedupVia, undefined);
      assert.equal(pool.queries.filter(q => /status = 'superseded'/.test(q.sql)).length, 0);
    } finally {
      Date.prototype.toISOString = originalToISOString;
    }
  });

  it('shadow + stale semantic candidate: still INSERTs, flags staleReplay', async () => {
    // Regression for Phase 4 deliver BLOCKER: shadow mode used to share
    // the canonical stale-replay early-return, which silently dropped
    // the incoming insight and left no audit trail. Shadow must always
    // insert and always write shadowMatch metadata.
    const inserted = makeInsertedRow({
      shadowMatch: {
        candidateId: 42,
        cosine: 0.92,
        threshold: 0.88,
        candidateTitle: 'Candidate title',
        candidateBody: 'candidate body text that should be normalized for metadata.',
        wouldSupersede: false,
        staleReplay: true,
        ranAt: '2026-01-03T00:00:00.000Z',
      },
    }, 78);
    const pool = makeDedupPool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [makeCandidateRow({ evidence_window: '[2029-01-01 00:00:00+00,2030-01-01 00:00:00+00)' })] },
      { rowCount: 1, rows: [inserted] },
    ]);
    const originalToISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = function toISOString() { return '2026-01-03T00:00:00.000Z'; };
    try {
      const api = createInsights({
        pool, schema: '"aq"', defaultTenantId: 'default', dedup: { mode: 'shadow' }, embedFn: async () => [[0.1, 0.2]],
      });
      const r = await api.commitInsight(baseInput);
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);
      assert.ok(r.data.insight.metadata.shadowMatch);
      assert.equal(r.data.insight.metadata.shadowMatch.wouldSupersede, false);
      assert.equal(r.data.insight.metadata.shadowMatch.staleReplay, true);
      assert.equal(r.data.insight.metadata.dedupVia, undefined);
      // INSERT fired; no supersede UPDATE.
      assert.ok(pool.queries.some(q => /^INSERT INTO/.test(q.sql)));
      assert.equal(pool.queries.filter(q => /status = 'superseded'/.test(q.sql)).length, 0);
    } finally {
      Date.prototype.toISOString = originalToISOString;
    }
  });

  it('resolveDedupConfig rejects null threshold as numeric 0', async () => {
    // Regression: Number(null) === 0 used to silently lower enforce
    // threshold to zero and merge everything non-negative.
    await withConsoleStub('warn', async (warns) => {
      const api = createInsights({
        pool: makeDedupPool(), schema: '"aq"', defaultTenantId: 'default', embedFn: async () => [[0.1]],
        dedup: { mode: 'enforce', cosineThreshold: null },
      });
      assert.equal(api._internal.dedup.cosineThreshold, 0.88);
      assert.ok(warns.some(args => String(args[0]).includes('invalid cosineThreshold')));
    });
  });

  it('close band 0.86', async () => {
    const longBody = 'Body   with    extra spacing '.repeat(20);
    const inserted = makeInsertedRow({
      dedupNear: {
        candidateId: 42,
        cosine: 0.86,
        threshold: 0.88,
        closeBandFrom: 0.85,
        candidateTitle: 'Candidate title',
        candidateBody: normalizeBody(longBody).slice(0, 200),
      },
    }, 55);
    const pool = makeDedupPool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [makeCandidateRow({ cos_sim: 0.86, body: longBody })] },
      { rowCount: 1, rows: [inserted] },
    ]);
    const api = createInsights({
      pool,
      schema: '"aq"',
      defaultTenantId: 'default',
      dedup: { mode: 'enforce', cosineThreshold: 0.88, closeBandFrom: 0.85 },
      embedFn: async () => [[0.1, 0.2]],
    });
    const r = await api.commitInsight(baseInput);
    assert.equal(r.ok, true);
    assert.ok(r.data.insight.metadata.dedupNear);
    assert.equal(r.data.insight.metadata.dedupVia, undefined);
    assert.equal(pool.queries.filter(q => /status = 'superseded'/.test(q.sql)).length, 0);
    assert.equal(r.data.insight.metadata.dedupNear.candidateBody.length <= 200, true);
  });

  it('embed throw', async () => {
    const inserted = makeInsertedRow({ dedupSkipped: 'embed_failed' }, 66);
    const pool = makeDedupPool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [inserted] },
    ]);
    const api = createInsights({
      pool, schema: '"aq"', defaultTenantId: 'default', dedup: { mode: 'enforce' }, embedFn: async () => { throw new Error('fail'); },
    });
    const r = await api.commitInsight(baseInput);
    assert.equal(r.ok, true);
    assert.equal(r.data.insight.metadata.dedupSkipped, 'embed_failed');
    assert.equal(pool.queries.some(q => /embedding <=>/.test(q.sql)), false);
    assert.equal(pool.queries.filter(q => /status = 'superseded'/.test(q.sql)).length, 0);
  });

  it('no candidate', async () => {
    const inserted = makeInsertedRow({}, 88);
    const pool = makeDedupPool([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [inserted] },
    ]);
    const api = createInsights({
      pool, schema: '"aq"', defaultTenantId: 'default', dedup: { mode: 'enforce' }, embedFn: async () => [[0.1, 0.2]],
    });
    const r = await api.commitInsight(baseInput);
    assert.equal(r.ok, true);
    assert.equal(r.data.insight.metadata.dedupSkipped, undefined);
    assert.equal(r.data.insight.metadata.dedupVia, undefined);
    assert.ok(pool.queries.some(q => /embedding <=>/.test(q.sql)));
  });
});
