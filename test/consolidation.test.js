'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyConsolidation } = require('../pipeline/consolidation');

function makeMockPool(onQuery) {
  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      return onQuery ? onQuery(sql, params) : { rowCount: 1, rows: [{ id: 1 }] };
    },
    release() {},
  };
  return {
    async connect() { return mockClient; },
    _queries: queries,
  };
}

describe('applyConsolidation', () => {
  it('throws on missing pool', async () => {
    await assert.rejects(
      () => applyConsolidation(null, { actions: [], agentId: 'a', schema: 's' }),
      /pool is required/,
    );
  });

  it('throws on missing schema', async () => {
    const pool = makeMockPool();
    await assert.rejects(
      () => applyConsolidation(pool, { actions: [], agentId: 'a' }),
      /schema is required/,
    );
  });

  it('throws on missing agentId', async () => {
    const pool = makeMockPool();
    await assert.rejects(
      () => applyConsolidation(pool, { actions: [], schema: 's' }),
      /agentId is required/,
    );
  });

  it('returns zero summary when actions is empty', async () => {
    const pool = makeMockPool();
    const s = await applyConsolidation(pool, { actions: [], agentId: 'main', schema: 'aq' });
    assert.equal(s.promote, 0);
    assert.equal(s.create, 0);
    assert.equal(s.skipped, 0);
    // no BEGIN issued for empty batch
    assert.equal(pool._queries.length, 0);
  });

  it('promote: updates candidate → active scoped by tenant+agent', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [{ action: 'promote', factId: 42 }],
      agentId: 'main', schema: 'aq', tenantId: 'default',
    });
    assert.equal(s.promote, 1);
    const promoteQ = pool._queries.find(q => q.sql.startsWith('UPDATE'));
    assert.ok(promoteQ.sql.includes(`"aq".facts`));
    assert.ok(promoteQ.sql.includes(`status = 'active'`));
    assert.deepEqual(promoteQ.params, [42, 'main', 'default']);
  });

  it('create: inserts active fact with normalized subject_key', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [{ action: 'create', subject: 'Aquifer', statement: 'Facts pipeline shipped', importance: 8 }],
      agentId: 'main', schema: 'aq',
      normalizeSubject: (s) => s.toLowerCase().replace(/\s+/g, '_'),
      sessionId: 'ses-1', recapOverview: 'done',
    });
    assert.equal(s.create, 1);
    const insertQ = pool._queries.find(q => q.sql.startsWith('INSERT'));
    assert.equal(insertQ.params[1], 'aquifer'); // normalized subject_key
    assert.equal(insertQ.params[2], 'Aquifer');  // subject_label
    assert.equal(insertQ.params[3], 'Facts pipeline shipped');
    assert.equal(insertQ.params[4], 8);           // importance
    assert.equal(insertQ.params[5], 'ses-1');
    assert.equal(insertQ.params[6], 'main');
  });

  it('create: falls back to default normalizer when not provided', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [{ action: 'create', subject: 'Hello World', statement: 'x' }],
      agentId: 'main', schema: 'aq',
    });
    assert.equal(s.create, 1);
    const q = pool._queries.find(q => q.sql.startsWith('INSERT'));
    assert.equal(q.params[1], 'hello world');
  });

  it('create: skips when statement empty', async () => {
    const pool = makeMockPool(() => ({ rowCount: 0, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [{ action: 'create', subject: 'X', statement: '' }],
      agentId: 'main', schema: 'aq',
    });
    assert.equal(s.create, 0);
    assert.equal(s.skipped, 1);
  });

  it('update: refreshes statement + last_confirmed_at on active', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [{ action: 'update', factId: 7, statement: 'New state' }],
      agentId: 'main', schema: 'aq',
    });
    assert.equal(s.update, 1);
    const q = pool._queries.find(q => q.sql.includes('statement = $1'));
    assert.equal(q.params[0], 'New state');
    assert.equal(q.params[1], 7);
  });

  it('confirm / stale / discard: each issues correct status transition', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [
        { action: 'confirm', factId: 1 },
        { action: 'stale', factId: 2 },
        { action: 'discard', factId: 3 },
      ],
      agentId: 'main', schema: 'aq',
    });
    assert.equal(s.confirm, 1);
    assert.equal(s.stale, 1);
    assert.equal(s.discard, 1);
    const sqls = pool._queries.map(q => q.sql);
    assert.ok(sqls.some(q => q.includes(`SET last_confirmed_at = now()`) && !q.includes('statement')));
    assert.ok(sqls.some(q => q.includes(`SET status = 'stale'`)));
    assert.ok(sqls.some(q => q.includes(`SET status = 'archived'`) && q.includes(`'candidate'`)));
  });

  it('merge: two UPDATEs (confirm target + archive source)', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [{ action: 'merge', factId: 5, targetId: 10 }],
      agentId: 'main', schema: 'aq',
    });
    assert.equal(s.merge, 1);
    assert.equal(pool._queries.filter(q => q.sql.startsWith('UPDATE')).length, 2);
  });

  it('supersede: active → superseded with superseded_by set', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [{ action: 'supersede', factId: 5, targetId: 10 }],
      agentId: 'main', schema: 'aq',
    });
    assert.equal(s.supersede, 1);
    const q = pool._queries.find(q => q.sql.includes('superseded_by'));
    assert.ok(q);
    assert.equal(q.params[0], 10);
    assert.equal(q.params[1], 5);
  });

  it('unknown action increments skipped', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [{ action: 'bogus' }],
      agentId: 'main', schema: 'aq',
    });
    assert.equal(s.skipped, 1);
  });

  it('rolls back on query error', async () => {
    const pool = makeMockPool((sql) => {
      if (sql.startsWith('UPDATE')) throw new Error('boom');
      return { rowCount: 1, rows: [] };
    });
    await assert.rejects(
      () => applyConsolidation(pool, {
        actions: [{ action: 'promote', factId: 1 }],
        agentId: 'main', schema: 'aq',
      }),
      /boom/,
    );
    const lastSql = pool._queries[pool._queries.length - 1].sql;
    assert.equal(lastSql, 'ROLLBACK');
  });

  it('commits on success', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    await applyConsolidation(pool, {
      actions: [{ action: 'promote', factId: 1 }],
      agentId: 'main', schema: 'aq',
    });
    const sqls = pool._queries.map(q => q.sql);
    assert.equal(sqls[0], 'BEGIN');
    assert.equal(sqls[sqls.length - 1], 'COMMIT');
  });

  it('zero rowCount counts toward skipped on no-op update', async () => {
    const pool = makeMockPool(() => ({ rowCount: 0, rows: [] }));
    const s = await applyConsolidation(pool, {
      actions: [{ action: 'promote', factId: 999 }],
      agentId: 'main', schema: 'aq',
    });
    assert.equal(s.promote, 0);
    assert.equal(s.skipped, 1);
  });

  it('string sanitization: clamps subject/statement length', async () => {
    const pool = makeMockPool(() => ({ rowCount: 1, rows: [] }));
    const longSubject = 'X'.repeat(500);
    const longStatement = 'Y'.repeat(5000);
    await applyConsolidation(pool, {
      actions: [{ action: 'create', subject: longSubject, statement: longStatement }],
      agentId: 'main', schema: 'aq',
    });
    const q = pool._queries.find(q => q.sql.startsWith('INSERT'));
    assert.equal(q.params[2].length, 200);  // subject_label ≤ 200
    assert.equal(q.params[3].length, 2000); // statement ≤ 2000
  });
});
