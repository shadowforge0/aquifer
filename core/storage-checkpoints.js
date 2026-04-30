'use strict';

const crypto = require('crypto');

function qi(identifier) { return `"${identifier}"`; }

const CHECKPOINT_RUN_STATUSES = new Set([
  'pending',
  'processing',
  'finalized',
  'failed',
  'skipped',
]);
const CHECKPOINT_RUN_TERMINAL_STATUSES = new Set(['finalized', 'skipped']);

function requireField(obj, field) {
  if (!obj || obj[field] === undefined || obj[field] === null || obj[field] === '') {
    throw new Error(`${field} is required`);
  }
}

function toJson(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function normalizeCheckpointRunStatus(status) {
  const out = status || 'pending';
  if (!CHECKPOINT_RUN_STATUSES.has(out)) throw new Error(`Invalid checkpoint run status: ${out}`);
  return out;
}

function checkpointRunTerminalSql(tableName) {
  return `${tableName}.status IN (${[...CHECKPOINT_RUN_TERMINAL_STATUSES].map(value => `'${value}'`).join(',')})`;
}

function normalizeNonNegativeInteger(value, field) {
  if (value === undefined || value === null) return null;
  const out = Number(value);
  if (!Number.isInteger(out) || out < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return out;
}

function normalizePositiveInteger(value, field) {
  if (value === undefined || value === null) return null;
  const out = Number(value);
  if (!Number.isInteger(out) || out <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return out;
}

function checkpointRunRange(input = {}) {
  const from = normalizeNonNegativeInteger(
    input.fromFinalizationIdExclusive ?? input.from_finalization_id_exclusive,
    'fromFinalizationIdExclusive'
  );
  const to = normalizePositiveInteger(
    input.toFinalizationIdInclusive ?? input.to_finalization_id_inclusive,
    'toFinalizationIdInclusive'
  );
  if (from !== null && to !== null && to <= from) {
    throw new Error('toFinalizationIdInclusive must be greater than fromFinalizationIdExclusive');
  }
  return {
    from: from === null ? 0 : from,
    to,
  };
}

function checkpointRunRangesEqual(left, right) {
  return left && right
    && left.from === right.from
    && left.to === right.to;
}

function advisoryLockKeys(namespace, value) {
  const digest = crypto.createHash('sha256').update(`${namespace}:${value}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

async function withTransaction(queryable, fn) {
  if (!queryable || typeof queryable.connect !== 'function') {
    return fn(queryable);
  }
  const client = await queryable.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failure and surface the original error.
    }
    throw err;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}

async function lockCheckpointRunScope(queryable, tenantId, scopeId) {
  const [key1, key2] = advisoryLockKeys(
    'aquifer.checkpoint_runs.scope',
    `${tenantId}:${scopeId}`,
  );
  await queryable.query('SELECT pg_advisory_xact_lock($1, $2)', [key1, key2]);
}

function defaultCheckpointKey(scopeId, range) {
  if (range.to === null) return null;
  return `scope:${scopeId}:finalization:${range.from}-${range.to}`;
}

function checkpointRunRowRange(row = {}) {
  return checkpointRunRange({
    fromFinalizationIdExclusive: row.from_finalization_id_exclusive,
    toFinalizationIdInclusive: row.to_finalization_id_inclusive,
  });
}

function checkpointRunIsTerminal(row = {}) {
  return CHECKPOINT_RUN_TERMINAL_STATUSES.has(row.status);
}

async function getCheckpointRunByKey(pool, input = {}, { schema, tenantId }) {
  const scopeId = input.scopeId || input.scope_id;
  const checkpointKey = input.checkpointKey || input.checkpoint_key;
  if (!scopeId || !checkpointKey) return null;
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.checkpoint_runs
      WHERE tenant_id = $1
        AND scope_id = $2
        AND checkpoint_key = $3
      LIMIT 1`,
    [tenantId, scopeId, checkpointKey]
  );
  return result.rows[0] || null;
}

async function getCheckpointRunById(pool, input = {}, { schema, tenantId }) {
  if (!input.id) return null;
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.checkpoint_runs
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, input.id]
  );
  return result.rows[0] || null;
}

async function getCheckpointRunByExactRange(pool, input = {}, { schema, tenantId }) {
  const scopeId = input.scopeId || input.scope_id;
  const range = checkpointRunRange(input);
  if (!scopeId || range.to === null) return null;
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.checkpoint_runs
      WHERE tenant_id = $1
        AND scope_id = $2
        AND from_finalization_id_exclusive = $3
        AND to_finalization_id_inclusive = $4
      LIMIT 1`,
    [tenantId, scopeId, range.from, range.to]
  );
  return result.rows[0] || null;
}

async function assertNoCheckpointRangeOverlap(pool, input = {}, { schema, tenantId }) {
  const scopeId = input.scopeId || input.scope_id;
  const range = checkpointRunRange(input);
  if (range.to === null) return;
  const params = [tenantId, scopeId, range.from, range.to];
  const where = [
    'tenant_id = $1',
    'scope_id = $2',
    "status IN ('processing','finalized')",
    'to_finalization_id_inclusive IS NOT NULL',
    'from_finalization_id_exclusive < $4',
    'to_finalization_id_inclusive > $3',
  ];
  if (input.id) {
    params.push(input.id);
    where.push(`id <> $${params.length}`);
  }
  if (input.checkpointKey || input.checkpoint_key) {
    params.push(input.checkpointKey || input.checkpoint_key);
    where.push(`checkpoint_key <> $${params.length}`);
  }
  const result = await pool.query(
    `SELECT id, checkpoint_key
       FROM ${qi(schema)}.checkpoint_runs
      WHERE ${where.join(' AND ')}
      LIMIT 1`,
    params
  );
  if (result.rows && result.rows.length > 0) {
    const existing = result.rows[0];
    throw new Error(`checkpoint range overlaps existing run ${existing.id || existing.checkpoint_key}`);
  }
}

async function upsertCheckpointRun(pool, input = {}, { schema, tenantId: defaultTenantId } = {}) {
  const scopeId = input.scopeId || input.scope_id;
  requireField({ scopeId }, 'scopeId');
  const range = checkpointRunRange(input);
  const requestedCheckpointKey = input.checkpointKey || input.checkpoint_key || defaultCheckpointKey(scopeId, range);
  requireField({ checkpointKey: requestedCheckpointKey }, 'checkpointKey');
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const status = normalizeCheckpointRunStatus(input.status || 'pending');
  return withTransaction(pool, async (queryable) => {
    await lockCheckpointRunScope(queryable, tenantId, scopeId);
    const existingByKey = await getCheckpointRunByKey(queryable, {
      scopeId,
      checkpointKey: requestedCheckpointKey,
    }, { schema, tenantId });
    const existingByRange = await getCheckpointRunByExactRange(queryable, {
      scopeId,
      fromFinalizationIdExclusive: range.from,
      toFinalizationIdInclusive: range.to,
    }, { schema, tenantId });
    if (existingByKey && existingByRange && existingByKey.id !== existingByRange.id) {
      throw new Error(`checkpointKey ${requestedCheckpointKey} already maps to a different checkpoint run`);
    }
    const targetRow = existingByRange || existingByKey || null;
    if (targetRow && checkpointRunIsTerminal(targetRow)
      && !checkpointRunRangesEqual(checkpointRunRowRange(targetRow), range)) {
      throw new Error(`checkpoint run ${targetRow.id || targetRow.checkpoint_key} is terminal and cannot change finalization range`);
    }
    const checkpointKey = targetRow ? targetRow.checkpoint_key : requestedCheckpointKey;
    await assertNoCheckpointRangeOverlap(queryable, {
      ...input,
      id: targetRow ? targetRow.id : input.id,
      scopeId,
      checkpointKey,
      fromFinalizationIdExclusive: range.from,
      toFinalizationIdInclusive: range.to,
    }, { schema, tenantId });
    const preserveTerminal = `${checkpointRunTerminalSql(qi(schema) + '.checkpoint_runs')}
          AND ${qi(schema)}.checkpoint_runs.status <> EXCLUDED.status`;
    const result = await queryable.query(
      `INSERT INTO ${qi(schema)}.checkpoint_runs (
       tenant_id, scope_id, checkpoint_key, from_finalization_id_exclusive,
       to_finalization_id_inclusive, status, window_start, window_end,
       scope_snapshot, checkpoint_text, checkpoint_payload, error,
       metadata, claimed_at, finalized_at
     )
     VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::jsonb,'{}'::jsonb),$10,
       COALESCE($11::jsonb,'{}'::jsonb),$12,COALESCE($13::jsonb,'{}'::jsonb),$14,$15
     )
     ON CONFLICT (tenant_id, scope_id, checkpoint_key)
     DO UPDATE SET
       status = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.status
         ELSE EXCLUDED.status
       END,
       from_finalization_id_exclusive = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.from_finalization_id_exclusive
         ELSE EXCLUDED.from_finalization_id_exclusive
       END,
       to_finalization_id_inclusive = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.to_finalization_id_inclusive
         ELSE COALESCE(EXCLUDED.to_finalization_id_inclusive, ${qi(schema)}.checkpoint_runs.to_finalization_id_inclusive)
       END,
       window_start = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.window_start
         ELSE COALESCE(EXCLUDED.window_start, ${qi(schema)}.checkpoint_runs.window_start)
       END,
       window_end = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.window_end
         ELSE COALESCE(EXCLUDED.window_end, ${qi(schema)}.checkpoint_runs.window_end)
       END,
       scope_snapshot = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.scope_snapshot
         ELSE COALESCE(NULLIF(EXCLUDED.scope_snapshot, '{}'::jsonb), ${qi(schema)}.checkpoint_runs.scope_snapshot)
       END,
       checkpoint_text = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.checkpoint_text
         ELSE COALESCE(EXCLUDED.checkpoint_text, ${qi(schema)}.checkpoint_runs.checkpoint_text)
       END,
       checkpoint_payload = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.checkpoint_payload
         ELSE COALESCE(NULLIF(EXCLUDED.checkpoint_payload, '{}'::jsonb), ${qi(schema)}.checkpoint_runs.checkpoint_payload)
       END,
       error = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.error
         ELSE EXCLUDED.error
       END,
       metadata = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.metadata
         ELSE COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${qi(schema)}.checkpoint_runs.metadata)
       END,
       claimed_at = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.claimed_at
         ELSE COALESCE(EXCLUDED.claimed_at, ${qi(schema)}.checkpoint_runs.claimed_at)
       END,
       finalized_at = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.finalized_at
         WHEN EXCLUDED.status = 'finalized'
         THEN COALESCE(EXCLUDED.finalized_at, ${qi(schema)}.checkpoint_runs.finalized_at, now())
         ELSE COALESCE(EXCLUDED.finalized_at, ${qi(schema)}.checkpoint_runs.finalized_at)
       END,
       updated_at = CASE
         WHEN ${preserveTerminal}
         THEN ${qi(schema)}.checkpoint_runs.updated_at
         ELSE now()
       END
     RETURNING *`,
      [
        tenantId,
        scopeId,
        checkpointKey,
        range.from,
        range.to,
        status,
        input.windowStart || input.window_start || null,
        input.windowEnd || input.window_end || null,
        toJson(input.scopeSnapshot || input.scope_snapshot, {}),
        input.checkpointText || input.checkpoint_text || null,
        toJson(input.checkpointPayload || input.checkpoint_payload, {}),
        input.error || null,
        toJson(input.metadata, {}),
        input.claimedAt || input.claimed_at || (status === 'processing' ? new Date().toISOString() : null),
        input.finalizedAt || input.finalized_at || (status === 'finalized' ? new Date().toISOString() : null),
      ]
    );
    return result.rows[0] || null;
  });
}

async function updateCheckpointRunStatus(pool, input = {}, { schema, tenantId: defaultTenantId } = {}) {
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const status = normalizeCheckpointRunStatus(input.status);
  return withTransaction(pool, async (queryable) => {
    const existing = input.id
      ? await getCheckpointRunById(queryable, input, { schema, tenantId })
      : await getCheckpointRunByKey(queryable, input, { schema, tenantId });
    if (!existing) return null;
    await lockCheckpointRunScope(queryable, tenantId, existing.scope_id);
    const current = await getCheckpointRunById(queryable, { id: existing.id }, { schema, tenantId }) || existing;
    const currentRange = checkpointRunRowRange(current);
    const nextRange = checkpointRunRange({
      fromFinalizationIdExclusive: (
        input.fromFinalizationIdExclusive ?? input.from_finalization_id_exclusive ?? currentRange.from
      ),
      toFinalizationIdInclusive: (
        input.toFinalizationIdInclusive ?? input.to_finalization_id_inclusive ?? currentRange.to
      ),
    });
    if (checkpointRunIsTerminal(current) && !checkpointRunRangesEqual(currentRange, nextRange)) {
      throw new Error(`checkpoint run ${current.id || current.checkpoint_key} is terminal and cannot change finalization range`);
    }
    if ((status === 'processing' || status === 'finalized') && nextRange.to !== null) {
      await assertNoCheckpointRangeOverlap(queryable, {
        id: current.id,
        scopeId: current.scope_id,
        checkpointKey: current.checkpoint_key,
        fromFinalizationIdExclusive: nextRange.from,
        toFinalizationIdInclusive: nextRange.to,
      }, { schema, tenantId });
    }
    const params = [
      tenantId,
      status,
      nextRange.from,
      nextRange.to,
      input.error || null,
      input.checkpointText || input.checkpoint_text || null,
      toJson(input.checkpointPayload || input.checkpoint_payload, {}),
      toJson(input.metadata, {}),
      input.claimedAt || input.claimed_at || (status === 'processing' ? new Date().toISOString() : null),
      input.finalizedAt || input.finalized_at || (status === 'finalized' ? new Date().toISOString() : null),
      current.id,
    ];
    const result = await queryable.query(
      `UPDATE ${qi(schema)}.checkpoint_runs
        SET status = $2,
            from_finalization_id_exclusive = $3,
            to_finalization_id_inclusive = $4,
            error = $5,
            checkpoint_text = COALESCE($6, checkpoint_text),
            checkpoint_payload = COALESCE(NULLIF($7::jsonb, '{}'::jsonb), checkpoint_payload),
            metadata = COALESCE(NULLIF($8::jsonb, '{}'::jsonb), metadata),
            claimed_at = CASE WHEN $2 = 'processing' THEN COALESCE(claimed_at, $9::timestamptz, now()) ELSE claimed_at END,
            finalized_at = CASE WHEN $2 = 'finalized' THEN COALESCE(finalized_at, $10::timestamptz, now()) ELSE finalized_at END,
            updated_at = now()
      WHERE tenant_id = $1
        AND id = $11
        AND (
          status NOT IN (${[...CHECKPOINT_RUN_TERMINAL_STATUSES].map(value => `'${value}'`).join(',')})
          OR status = $2
        )
      RETURNING *`,
      params
    );
    return result.rows[0] || null;
  });
}

async function listCheckpointRuns(pool, input = {}, { schema, tenantId: defaultTenantId } = {}) {
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const params = [tenantId];
  const where = ['tenant_id = $1'];
  if (input.scopeId || input.scope_id) {
    params.push(input.scopeId || input.scope_id);
    where.push(`scope_id = $${params.length}`);
  }
  if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    for (const status of statuses) normalizeCheckpointRunStatus(status);
    params.push(statuses);
    where.push(`status = ANY($${params.length}::text[])`);
  }
  if (input.checkpointKey || input.checkpoint_key) {
    params.push(input.checkpointKey || input.checkpoint_key);
    where.push(`checkpoint_key = $${params.length}`);
  }
  if (input.id) {
    params.push(input.id);
    where.push(`id = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(200, input.limit || 50)));
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.checkpoint_runs
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function upsertCheckpointRunSources(pool, rows = [], input = {}, { schema, tenantId: defaultTenantId } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const checkpointRunId = input.checkpointRunId || input.checkpoint_run_id;
  requireField({ checkpointRunId }, 'checkpointRunId');
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const finalization = row.finalization || {};
    const finalizationId = row.finalizationId || row.finalization_id || finalization.id;
    requireField({ finalizationId }, 'finalizationId');
    const sourceIndex = normalizeNonNegativeInteger(
      row.sourceIndex !== undefined ? row.sourceIndex : (
        row.source_index !== undefined ? row.source_index : i
      ),
      'sourceIndex'
    );
    const result = await pool.query(
      `INSERT INTO ${qi(schema)}.checkpoint_run_sources (
         tenant_id, checkpoint_run_id, finalization_id, source_index, scope_id,
         scope_snapshot, session_row_id, session_id, transcript_hash,
         summary_row_id, finalized_at, metadata
       )
       VALUES (
         $1,$2,$3,$4,$5,COALESCE($6::jsonb,'{}'::jsonb),$7,$8,$9,$10,$11,COALESCE($12::jsonb,'{}'::jsonb)
       )
       ON CONFLICT (tenant_id, checkpoint_run_id, finalization_id)
       DO UPDATE SET
         source_index = EXCLUDED.source_index,
         scope_id = COALESCE(EXCLUDED.scope_id, ${qi(schema)}.checkpoint_run_sources.scope_id),
         scope_snapshot = COALESCE(NULLIF(EXCLUDED.scope_snapshot, '{}'::jsonb), ${qi(schema)}.checkpoint_run_sources.scope_snapshot),
         session_row_id = COALESCE(EXCLUDED.session_row_id, ${qi(schema)}.checkpoint_run_sources.session_row_id),
         session_id = COALESCE(EXCLUDED.session_id, ${qi(schema)}.checkpoint_run_sources.session_id),
         transcript_hash = COALESCE(EXCLUDED.transcript_hash, ${qi(schema)}.checkpoint_run_sources.transcript_hash),
         summary_row_id = COALESCE(EXCLUDED.summary_row_id, ${qi(schema)}.checkpoint_run_sources.summary_row_id),
         finalized_at = COALESCE(EXCLUDED.finalized_at, ${qi(schema)}.checkpoint_run_sources.finalized_at),
         metadata = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${qi(schema)}.checkpoint_run_sources.metadata),
         updated_at = now()
       RETURNING *`,
      [
        tenantId,
        checkpointRunId,
        finalizationId,
        sourceIndex,
        row.scopeId || row.scope_id || finalization.scopeId || finalization.scope_id || null,
        toJson(row.scopeSnapshot || row.scope_snapshot || finalization.scopeSnapshot || finalization.scope_snapshot, {}),
        row.sessionRowId || row.session_row_id || finalization.sessionRowId || finalization.session_row_id || null,
        row.sessionId || row.session_id || finalization.sessionId || finalization.session_id || null,
        row.transcriptHash || row.transcript_hash || finalization.transcriptHash || finalization.transcript_hash || null,
        row.summaryRowId || row.summary_row_id || finalization.summaryRowId || finalization.summary_row_id || null,
        row.finalizedAt || row.finalized_at || finalization.finalizedAt || finalization.finalized_at || null,
        toJson(row.metadata, {}),
      ]
    );
    out.push(result.rows[0] || null);
  }
  return out;
}

async function listCheckpointRunSources(pool, input = {}, { schema, tenantId: defaultTenantId } = {}) {
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const params = [tenantId];
  const where = ['tenant_id = $1'];
  if (input.checkpointRunId || input.checkpoint_run_id) {
    params.push(input.checkpointRunId || input.checkpoint_run_id);
    where.push(`checkpoint_run_id = $${params.length}`);
  }
  if (input.finalizationId || input.finalization_id) {
    params.push(input.finalizationId || input.finalization_id);
    where.push(`finalization_id = $${params.length}`);
  }
  if (input.scopeId || input.scope_id) {
    params.push(input.scopeId || input.scope_id);
    where.push(`scope_id = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(500, input.limit || 200)));
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.checkpoint_run_sources
      WHERE ${where.join(' AND ')}
      ORDER BY checkpoint_run_id DESC, source_index ASC, id ASC
      LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

module.exports = {
  upsertCheckpointRun,
  updateCheckpointRunStatus,
  listCheckpointRuns,
  upsertCheckpointRunSources,
  listCheckpointRunSources,
};
