'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../core/storage');

function makePool({
  overlap = null,
  existingByKey = null,
  existingByRange = null,
  existingById = null,
} = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (String(sql).includes('SELECT *') && String(sql).includes('checkpoint_key = $3')) {
        return { rows: existingByKey ? [existingByKey] : [], rowCount: existingByKey ? 1 : 0 };
      }
      if (String(sql).includes('SELECT *') && String(sql).includes('from_finalization_id_exclusive = $3')) {
        return { rows: existingByRange ? [existingByRange] : [], rowCount: existingByRange ? 1 : 0 };
      }
      if (String(sql).includes('SELECT *') && String(sql).includes('AND id = $2')) {
        return { rows: existingById ? [existingById] : [], rowCount: existingById ? 1 : 0 };
      }
      if (String(sql).includes('SELECT id, checkpoint_key') && String(sql).includes('checkpoint_runs')) {
        return { rows: overlap ? [overlap] : [], rowCount: overlap ? 1 : 0 };
      }
      if (String(sql).includes('INSERT INTO "aq".checkpoint_runs')) {
        return {
          rows: [{
            id: 11,
            tenant_id: params[0],
            scope_id: params[1],
            checkpoint_key: params[2],
            from_finalization_id_exclusive: params[3],
            to_finalization_id_inclusive: params[4],
            status: params[5],
          }],
          rowCount: 1,
        };
      }
      if (String(sql).includes('UPDATE "aq".checkpoint_runs')) {
        return {
          rows: [{
            id: params[10],
            tenant_id: params[0],
            status: params[1],
            from_finalization_id_exclusive: params[2],
            to_finalization_id_inclusive: params[3],
          }],
          rowCount: 1,
        };
      }
      if (String(sql).includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

describe('storage checkpoint run ranges', () => {
  it('derives a deterministic checkpoint key from finalization range and writes range columns', async () => {
    const pool = makePool();
    const row = await storage.upsertCheckpointRun(pool, {
      scopeId: 7,
      fromFinalizationIdExclusive: 10,
      toFinalizationIdInclusive: 14,
      status: 'processing',
      checkpointText: 'Range checkpoint',
    }, { schema: 'aq', tenantId: 'default' });

    assert.equal(row.checkpoint_key, 'scope:7:finalization:10-14');
    assert.equal(row.from_finalization_id_exclusive, 10);
    assert.equal(row.to_finalization_id_inclusive, 14);
    const overlapQuery = pool.queries.find(q => String(q.sql).includes('SELECT id, checkpoint_key'));
    const insertQuery = pool.queries.find(q => String(q.sql).includes('INSERT INTO "aq".checkpoint_runs'));
    assert.match(overlapQuery.sql, /from_finalization_id_exclusive < \$4/);
    assert.match(overlapQuery.sql, /to_finalization_id_inclusive > \$3/);
    assert.deepEqual(overlapQuery.params.slice(0, 4), ['default', 7, 10, 14]);
    assert.deepEqual(insertQuery.params.slice(0, 6), [
      'default',
      7,
      'scope:7:finalization:10-14',
      10,
      14,
      'processing',
    ]);
  });

  it('rejects overlapping processing or finalized ranges for the same scope', async () => {
    const pool = makePool({ overlap: { id: 99, checkpoint_key: 'existing' } });

    await assert.rejects(
      () => storage.upsertCheckpointRun(pool, {
        scopeId: 7,
        checkpointKey: 'new-range',
        fromFinalizationIdExclusive: 12,
        toFinalizationIdInclusive: 18,
      }, { schema: 'aq', tenantId: 'default' }),
      /checkpoint range overlaps existing run 99/,
    );
    assert.equal(pool.queries.length, 4);
  });

  it('treats an exact same-range upsert as idempotent even when the caller key differs', async () => {
    const pool = makePool({
      existingByRange: {
        id: 11,
        tenant_id: 'default',
        scope_id: 7,
        checkpoint_key: 'scope:7:finalization:10-14',
        from_finalization_id_exclusive: 10,
        to_finalization_id_inclusive: 14,
        status: 'processing',
      },
    });

    const row = await storage.upsertCheckpointRun(pool, {
      scopeId: 7,
      checkpointKey: 'manual-key',
      fromFinalizationIdExclusive: 10,
      toFinalizationIdInclusive: 14,
      status: 'processing',
    }, { schema: 'aq', tenantId: 'default' });

    assert.equal(row.checkpoint_key, 'scope:7:finalization:10-14');
    const insertQuery = pool.queries.find(q => String(q.sql).includes('INSERT INTO "aq".checkpoint_runs'));
    assert.deepEqual(insertQuery.params.slice(0, 6), [
      'default',
      7,
      'scope:7:finalization:10-14',
      10,
      14,
      'processing',
    ]);
  });

  it('rejects changing the range of a terminal checkpoint run', async () => {
    const pool = makePool({
      existingByKey: {
        id: 21,
        tenant_id: 'default',
        scope_id: 7,
        checkpoint_key: 'scope:7:finalization:10-14',
        from_finalization_id_exclusive: 10,
        to_finalization_id_inclusive: 14,
        status: 'finalized',
      },
    });

    await assert.rejects(
      () => storage.upsertCheckpointRun(pool, {
        scopeId: 7,
        checkpointKey: 'scope:7:finalization:10-14',
        fromFinalizationIdExclusive: 11,
        toFinalizationIdInclusive: 15,
        status: 'finalized',
      }, { schema: 'aq', tenantId: 'default' }),
      /terminal and cannot change finalization range/,
    );
  });

  it('updates range columns when promoting a run into processing', async () => {
    const pool = makePool({
      existingById: {
        id: 11,
        tenant_id: 'default',
        scope_id: 7,
        checkpoint_key: 'pending-run',
        from_finalization_id_exclusive: 0,
        to_finalization_id_inclusive: null,
        status: 'pending',
      },
    });

    const row = await storage.updateCheckpointRunStatus(pool, {
      id: 11,
      status: 'processing',
      fromFinalizationIdExclusive: 10,
      toFinalizationIdInclusive: 14,
    }, { schema: 'aq', tenantId: 'default' });

    assert.equal(row.from_finalization_id_exclusive, 10);
    assert.equal(row.to_finalization_id_inclusive, 14);
    const overlapQuery = pool.queries.find(q => String(q.sql).includes('SELECT id, checkpoint_key'));
    const updateQuery = pool.queries.find(q => String(q.sql).includes('UPDATE "aq".checkpoint_runs'));
    assert.match(overlapQuery.sql, /from_finalization_id_exclusive < \$4/);
    assert.match(updateQuery.sql, /SET status = \$2,\s+from_finalization_id_exclusive = \$3,\s+to_finalization_id_inclusive = \$4,/);
  });

  it('rejects overlapping range changes during status updates', async () => {
    const pool = makePool({
      existingById: {
        id: 11,
        tenant_id: 'default',
        scope_id: 7,
        checkpoint_key: 'pending-run',
        from_finalization_id_exclusive: 0,
        to_finalization_id_inclusive: null,
        status: 'pending',
      },
      overlap: {
        id: 99,
        checkpoint_key: 'other-run',
      },
    });

    await assert.rejects(
      () => storage.updateCheckpointRunStatus(pool, {
        id: 11,
        status: 'finalized',
        fromFinalizationIdExclusive: 10,
        toFinalizationIdInclusive: 14,
      }, { schema: 'aq', tenantId: 'default' }),
      /checkpoint range overlaps existing run 99/,
    );
    assert.equal(pool.queries.some(q => String(q.sql).includes('UPDATE "aq".checkpoint_runs')), false);
  });

  it('validates finalization range ordering', async () => {
    const pool = makePool();

    await assert.rejects(
      () => storage.upsertCheckpointRun(pool, {
        scopeId: 7,
        fromFinalizationIdExclusive: 10,
        toFinalizationIdInclusive: 10,
      }, { schema: 'aq', tenantId: 'default' }),
      /toFinalizationIdInclusive must be greater/,
    );
    assert.equal(pool.queries.length, 0);
  });
});
