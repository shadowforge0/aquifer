'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { upsertEntity, searchEntities, resolveEntities } = require('../core/entity');
const { createAquifer } = require('../core/aquifer');

// ---------------------------------------------------------------------------
// Helper: spy pool that captures sql + params
// ---------------------------------------------------------------------------

function spyPool(returnRows = []) {
  const calls = [];
  return {
    calls,
        async query(sql, params) {
      calls.push({ sql, params });
      return { rows: returnRows };
    },
  };
}

// ---------------------------------------------------------------------------
// Block 1: upsertEntity entityScope
// ---------------------------------------------------------------------------

describe('upsertEntity entityScope', () => {
  const baseOpts = { schema: 'aq', tenantId: 't', name: 'Foo', normalizedName: 'foo' };

  it('uses entityScope when provided, agentId stays at $7', async () => {
    const pool = spyPool([{ id: 1, is_new: true }]);
    await upsertEntity(pool, { ...baseOpts, agentId: 'agent-x', entityScope: 'my-scope' });
    const { params } = pool.calls[0];
    assert.equal(params[6], 'agent-x', 'agentId at $7 (index 6)');
    assert.equal(params[7], 'my-scope', 'entityScope at $8 (index 7)');
  });

  it('falls back to agentId when entityScope is absent', async () => {
    const pool = spyPool([{ id: 1, is_new: true }]);
    await upsertEntity(pool, { ...baseOpts, agentId: 'agent-x' });
    assert.equal(pool.calls[0].params[7], 'agent-x');
  });

  it('falls back to "default" when both entityScope and agentId are null', async () => {
    const pool = spyPool([{ id: 1, is_new: true }]);
    await upsertEntity(pool, { ...baseOpts, agentId: null, entityScope: null });
    assert.equal(pool.calls[0].params[7], 'default');
  });

  it('has 12 SQL params and ON CONFLICT uses entity_scope', async () => {
    const pool = spyPool([{ id: 1, is_new: true }]);
    await upsertEntity(pool, { ...baseOpts, entityScope: 's' });
    const { sql, params } = pool.calls[0];
    assert.equal(params.length, 12);
    assert.ok(sql.includes('ON CONFLICT'), 'SQL has ON CONFLICT');
    assert.ok(sql.includes('entity_scope'), 'ON CONFLICT references entity_scope');
  });

  it('createdBy shifts to params[8] after scope', async () => {
    const pool = spyPool([{ id: 1, is_new: true }]);
    await upsertEntity(pool, { ...baseOpts, entityScope: 's', createdBy: 'test-user' });
    assert.equal(pool.calls[0].params[8], 'test-user');
  });
});

// ---------------------------------------------------------------------------
// Block 2: searchEntities entityScope
// ---------------------------------------------------------------------------

describe('searchEntities entityScope', () => {
  const baseOpts = { schema: 'aq', tenantId: 't', query: 'postgres' };

  it('filters by entityScope when provided', async () => {
    const pool = spyPool([]);
    await searchEntities(pool, { ...baseOpts, entityScope: 'proj-x', agentId: 'agent-y' });
    assert.equal(pool.calls[0].params[5], 'proj-x');
  });

  it('falls back to agentId when entityScope absent', async () => {
    const pool = spyPool([]);
    await searchEntities(pool, { ...baseOpts, agentId: 'agent-y' });
    assert.equal(pool.calls[0].params[5], 'agent-y');
  });

  it('passes null when both entityScope and agentId absent', async () => {
    const pool = spyPool([]);
    await searchEntities(pool, { ...baseOpts });
    assert.equal(pool.calls[0].params[5], null);
  });

  it('SQL uses entity_scope column for filtering', async () => {
    const pool = spyPool([]);
    await searchEntities(pool, { ...baseOpts, entityScope: 'x' });
    assert.ok(pool.calls[0].sql.includes('entity_scope = $6'));
  });
});

// ---------------------------------------------------------------------------
// Block 3: resolveEntities entityScope
// ---------------------------------------------------------------------------

describe('resolveEntities entityScope', () => {
  const baseOpts = { schema: 'aq', tenantId: 't' };
  const hitRow = [{ id: 1, name: 'Pg', normalized_name: 'pg' }];

  it('filters by entityScope when provided', async () => {
    const pool = spyPool(hitRow);
    await resolveEntities(pool, { ...baseOpts, names: ['Postgres'], entityScope: 'scope-a' });
    assert.equal(pool.calls[0].params[3], 'scope-a');
  });

  it('falls back to agentId when entityScope absent', async () => {
    const pool = spyPool(hitRow);
    await resolveEntities(pool, { ...baseOpts, names: ['Postgres'], agentId: 'agent-z' });
    assert.equal(pool.calls[0].params[3], 'agent-z');
  });

  it('passes null when both absent', async () => {
    const pool = spyPool(hitRow);
    await resolveEntities(pool, { ...baseOpts, names: ['Postgres'] });
    assert.equal(pool.calls[0].params[3], null);
  });

  it('scope preserved across deduplicated names (single query)', async () => {
    const pool = spyPool(hitRow);
    await resolveEntities(pool, { ...baseOpts, names: ['PostgreSQL', 'postgresql'], entityScope: 'x' });
    assert.equal(pool.calls.length, 1, 'deduplicated to single query');
    assert.equal(pool.calls[0].params[3], 'x');
  });

  it('SQL uses entity_scope column for filtering', async () => {
    const pool = spyPool(hitRow);
    await resolveEntities(pool, { ...baseOpts, names: ['Postgres'], entityScope: 'x' });
    assert.ok(pool.calls[0].sql.includes('entity_scope = $4'));
  });
});

// ---------------------------------------------------------------------------
// Block 4: enrich stale reclaim
// ---------------------------------------------------------------------------

describe('enrich stale reclaim', () => {
  // Minimal session row for claim to succeed
  const claimRow = {
    id: 1, session_id: 'sid', agent_id: 'a', tenant_id: 't',
    messages: JSON.stringify({ normalized: [{ role: 'user', content: 'hi' }] }),
    started_at: null, ended_at: null, source: 'api', model: null,
    processing_status: 'processing',
  };

  function makeEnrichPool({ claimReturns, lookupRow } = {}) {
    const captured = { claimSql: null };
    return {
      captured,
      async query(sql, _params) {
        // Claim UPDATE
        if (sql.includes('SET processing_status') && sql.includes('RETURNING')) {
          captured.claimSql = sql;
          return { rows: claimReturns ? [claimRow] : [] };
        }
        // getSession lookup fallback
        if (sql.includes('SELECT') && sql.includes('sessions') && lookupRow) {
          return { rows: [lookupRow] };
        }
        // markStatus
        if (sql.includes('processing_status') && !sql.includes('RETURNING')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      async connect() {
        return {
          async query() { return { rows: [] }; },
          release() {},
        };
      },
    };
  }

  it('claim SQL contains stale reclaim clauses', async () => {
    const pool = makeEnrichPool({ claimReturns: true });
    const aq = createAquifer({ db: pool, schema: 'aq', tenantId: 't' });
    await aq.enrich('sid', { agentId: 'a', skipSummary: true, skipTurnEmbed: true, skipEntities: true });

    const sql = pool.captured.claimSql;
    assert.ok(sql, 'claim SQL was captured');
    assert.ok(sql.includes("'pending'"), 'handles pending');
    assert.ok(sql.includes("'failed'"), 'handles failed');
    assert.ok(sql.includes("processing_status = 'processing'"), 'handles stale processing');
    assert.ok(sql.includes('processing_started_at IS NULL'), 'handles null started_at');
    assert.ok(sql.includes('10 minutes'), 'uses 10 minute threshold');
  });

  it('reclaim succeeds for stale processing session', async () => {
    const pool = makeEnrichPool({ claimReturns: true });
    const aq = createAquifer({ db: pool, schema: 'aq', tenantId: 't' });
    // Should not throw — stale session is reclaimable
    await aq.enrich('sid', { agentId: 'a', skipSummary: true, skipTurnEmbed: true, skipEntities: true });
  });

  it('active processing throws "already being enriched"', async () => {
    const pool = makeEnrichPool({
      claimReturns: false,
      lookupRow: { processing_status: 'processing' },
    });
    const aq = createAquifer({ db: pool, schema: 'aq', tenantId: 't' });
    await assert.rejects(
      () => aq.enrich('sid', { agentId: 'a' }),
      /already being enriched/
    );
  });

  it('succeeded session throws "already enriched"', async () => {
    const pool = makeEnrichPool({
      claimReturns: false,
      lookupRow: { processing_status: 'succeeded' },
    });
    const aq = createAquifer({ db: pool, schema: 'aq', tenantId: 't' });
    await assert.rejects(
      () => aq.enrich('sid', { agentId: 'a' }),
      /already enriched/
    );
  });
});

// ---------------------------------------------------------------------------
// Block 5: createAquifer → enrich scope propagation
// ---------------------------------------------------------------------------

describe('createAquifer entityScope propagation via enrich', () => {
  const claimRow = {
    id: 1, session_id: 'sid', agent_id: 'a', tenant_id: 't',
    messages: JSON.stringify({ normalized: [{ role: 'user', content: 'hi' }] }),
    started_at: new Date().toISOString(), ended_at: null, source: 'api', model: null,
    processing_status: 'pending',
  };

  function makeFullPool() {
    const entityInserts = [];
    return {
      entityInserts,
      async query(sql, _params) {
        // Claim
        if (sql.includes('SET processing_status') && sql.includes('RETURNING')) {
          return { rows: [claimRow] };
        }
        // markStatus
        if (sql.includes('processing_status') && !sql.includes('RETURNING')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      async connect() {
        return {
          async query(sql, params) {
            // Capture entity INSERT
            if (sql.includes('INSERT') && sql.includes('entities') && sql.includes('entity_scope')) {
              entityInserts.push({ sql, params });
              return { rows: [{ id: 99, is_new: true }] };
            }
            // entity_mentions, entity_sessions, markStatus via client
            return { rows: [] };
          },
          release() {},
        };
      },
    };
  }

  // Custom fns to bypass LLM and produce a predictable entity
  const customSummaryFn = async () => ({
    summaryText: 'test summary',
    structuredSummary: {},
    entityRaw: '[ENTITIES]\nname: TestEntity\ntype: concept\naliases:\n---',
  });
  const customEntityParseFn = () => [{
    name: 'TestEntity', normalizedName: 'testentity', type: 'concept', aliases: [],
  }];
  const embedFn = async (_texts) => [[0.1, 0.2, 0.3]];

  it('config.entities.scope flows to upsertEntity during enrich', async () => {
    const pool = makeFullPool();
    const aq = createAquifer({
      db: pool, schema: 'aq', tenantId: 't',
      embed: { fn: embedFn },
      entities: { enabled: true, scope: 'prod' },
    });
    await aq.enrich('sid', {
      agentId: 'a',
      summaryFn: customSummaryFn,
      entityParseFn: customEntityParseFn,
    });
    assert.ok(pool.entityInserts.length > 0, 'entity was inserted');
    assert.equal(pool.entityInserts[0].params[7], 'prod', 'scope = prod');
  });

  it('defaults scope to "default" when config.entities.scope absent', async () => {
    const pool = makeFullPool();
    const aq = createAquifer({
      db: pool, schema: 'aq', tenantId: 't',
      embed: { fn: embedFn },
      entities: { enabled: true },
    });
    await aq.enrich('sid', {
      agentId: 'a',
      summaryFn: customSummaryFn,
      entityParseFn: customEntityParseFn,
    });
    assert.equal(pool.entityInserts[0].params[7], 'default');
  });

  it('scope is independent of agentId', async () => {
    const pool = makeFullPool();
    const aq = createAquifer({
      db: pool, schema: 'aq', tenantId: 't',
      embed: { fn: embedFn },
      entities: { enabled: true, scope: 'scope-val' },
    });
    await aq.enrich('sid', {
      agentId: 'agent-val',
      summaryFn: customSummaryFn,
      entityParseFn: customEntityParseFn,
    });
    const p = pool.entityInserts[0].params;
    assert.equal(p[6], 'agent-val', 'agentId at $7');
    assert.equal(p[7], 'scope-val', 'scope at $8, independent of agentId');
  });
});
