'use strict';

// aquifer.entityState.* — temporal state-change tracking on entities.
//
// One row per (entity, attribute) value valid over [valid_from, valid_to).
// Partial UNIQUE on (tenant, agent, entity, attribute) WHERE valid_to IS NULL
// enforces at-most-one-current.
//
// Out-of-order backfill is supported: applying a change with valid_from < the
// current row's valid_from inserts a closed-interval historical row instead
// of overwriting current. Same-value replays are no-ops (return action='noop_same_value').
//
// Source conflicts (current row source != incoming source AND values differ)
// return AQ_CONFLICT — the DB layer never assumes priority between manual /
// infra / llm; callers decide.

const crypto = require('crypto');
const { ok, err } = require('./errors');

const VALID_SOURCES = new Set(['llm', 'manual', 'infra']);
const ATTRIBUTE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function canonicalJson(value) {
  // Stable JSON for idempotency hashing — sort object keys recursively.
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function defaultIdempotencyKey({ tenantId, agentId, entityId, attribute, value, validFrom, source, evidenceSessionId }) {
  return crypto.createHash('sha256').update([
    tenantId, agentId, String(entityId), attribute, canonicalJson(value),
    new Date(validFrom).toISOString(), source, evidenceSessionId || '',
  ].join('|')).digest('hex');
}

function toIsoOrNull(v) {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function mapRow(row) {
  if (!row) return null;
  return {
    stateId: Number(row.id),
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    entityId: Number(row.entity_id),
    sessionRowId: (row.session_row_id !== null && row.session_row_id !== undefined) ? Number(row.session_row_id) : null,
    evidenceSessionId: row.evidence_session_id || null,
    attribute: row.attribute,
    value: row.value,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    evidenceText: row.evidence_text || '',
    confidence: (row.confidence !== null && row.confidence !== undefined) ? Number(row.confidence) : null,
    source: row.source,
    idempotencyKey: row.idempotency_key || null,
    supersedesStateId: (row.supersedes_state_id !== null && row.supersedes_state_id !== undefined) ? Number(row.supersedes_state_id) : null,
    createdAt: row.created_at,
  };
}

function validateChange(change, idx) {
  if (!change || typeof change !== 'object') {
    return `changes[${idx}] is not an object`;
  }
  if (change.entityId === null || change.entityId === undefined || !Number.isInteger(Number(change.entityId))) {
    return `changes[${idx}].entityId is required (integer)`;
  }
  if (typeof change.attribute !== 'string' || !ATTRIBUTE_RE.test(change.attribute)) {
    return `changes[${idx}].attribute must match /^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$/ (got: ${JSON.stringify(change.attribute)})`;
  }
  if (change.value === undefined) {
    return `changes[${idx}].value is required (use null for explicit null, undefined is forbidden)`;
  }
  const validFromIso = toIsoOrNull(change.validFrom);
  if (!validFromIso) {
    return `changes[${idx}].validFrom must parse to a valid timestamp`;
  }
  if (change.confidence !== null && change.confidence !== undefined) {
    const c = Number(change.confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      return `changes[${idx}].confidence must be in [0,1]`;
    }
  }
  if (change.source !== null && change.source !== undefined && !VALID_SOURCES.has(change.source)) {
    return `changes[${idx}].source must be one of llm|manual|infra`;
  }
  return null;
}

// Apply a single change against a transaction client. Caller MUST be inside
// a transaction. Returns { action, row } on success. On AQ_CONFLICT it throws
// a tagged Error — the outer applyChanges() catches this (see err.code ===
// 'AQ_CONFLICT') and returns the err() envelope, keeping the public surface
// pure-envelope while letting tx-level callers still use try/catch. DB errors
// (syntax, permission, etc.) propagate as real exceptions so savepoint logic
// in aquifer.enrich() can rollback cleanly.
async function applyOneChange(client, change, ctx) {
  const tenantId = change.tenantId || ctx.defaultTenantId || 'default';
  const agentId = change.agentId || ctx.agentId || 'main';
  const entityId = Number(change.entityId);
  const attribute = change.attribute;
  const value = change.value;
  const validFrom = new Date(change.validFrom).toISOString();
  const evidenceText = change.evidenceText || '';
  const confidence = (change.confidence !== null && change.confidence !== undefined) ? Number(change.confidence) : (ctx.defaultConfidence ?? 0.7);
  const source = change.source || 'llm';
  const evidenceSessionId = change.evidenceSessionId || null;
  const sessionRowId = (change.sessionRowId !== null && change.sessionRowId !== undefined) ? Number(change.sessionRowId) : (ctx.sessionRowId ?? null);
  const idempotencyKey = change.idempotencyKey || defaultIdempotencyKey({
    tenantId, agentId, entityId, attribute, value, validFrom, source, evidenceSessionId,
  });

  const schema = ctx.schema;
  const tbl = `${schema}.entity_state_history`;

  // Idempotency preflight: if a row with this key already exists, no-op.
  const idemRow = await client.query(
    `SELECT * FROM ${tbl} WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey]
  );
  if (idemRow.rowCount > 0) {
    return { action: 'noop_idempotent', row: mapRow(idemRow.rows[0]) };
  }

  // Lock the current open row (if any) for this (tenant, agent, entity, attribute).
  const currentRes = await client.query(
    `SELECT * FROM ${tbl}
      WHERE tenant_id = $1 AND agent_id = $2 AND entity_id = $3 AND attribute = $4 AND valid_to IS NULL
      FOR UPDATE`,
    [tenantId, agentId, entityId, attribute]
  );
  const current = currentRes.rows[0] || null;

  // Out-of-order backfill: incoming validFrom is older than current.validFrom →
  // insert a closed-interval historical row [validFrom, predecessorSuccessor).
  // Must check overlap with existing historical rows so the timeline stays
  // non-overlapping (temporal integrity).
  if (current && new Date(validFrom).getTime() < new Date(current.valid_from).getTime()) {
    // Find the nearest neighbours on either side of validFrom.
    const neighbourRes = await client.query(
      `SELECT id, value, valid_from, valid_to, source
         FROM ${tbl}
        WHERE tenant_id = $1 AND agent_id = $2 AND entity_id = $3 AND attribute = $4
          AND valid_from <= $5
        ORDER BY valid_from DESC LIMIT 1`,
      [tenantId, agentId, entityId, attribute, validFrom]
    );
    const predecessor = neighbourRes.rows[0] || null;
    // Exact-timestamp collision on an older row → conflict (can't create
    // duplicate interval start).
    if (predecessor && new Date(predecessor.valid_from).getTime() === new Date(validFrom).getTime()) {
      const conflictErr = new Error(
        `entity_state_history: equal-timestamp historical conflict on (entity=${entityId}, attribute=${attribute}, valid_from=${validFrom}) — predecessor row #${predecessor.id} already has this start`
      );
      conflictErr.code = 'AQ_CONFLICT';
      throw conflictErr;
    }
    // If predecessor has an open-ended interval (valid_to NULL) or a valid_to
    // that extends past validFrom, we'd overlap — refuse.
    if (predecessor) {
      const predEnd = (predecessor.valid_to === null || predecessor.valid_to === undefined)
        ? Infinity : new Date(predecessor.valid_to).getTime();
      if (predEnd > new Date(validFrom).getTime()) {
        const conflictErr = new Error(
          `entity_state_history: backfill overlaps predecessor row #${predecessor.id} [${predecessor.valid_from}, ${predecessor.valid_to ?? 'open'}) — incoming valid_from ${validFrom} falls inside`
        );
        conflictErr.code = 'AQ_CONFLICT';
        throw conflictErr;
      }
    }
    // Successor = next row with valid_from > validFrom; the new historical
    // interval closes at that successor's valid_from (not current's, which
    // may be further in the future than the nearest successor).
    const successorRes = await client.query(
      `SELECT id, valid_from
         FROM ${tbl}
        WHERE tenant_id = $1 AND agent_id = $2 AND entity_id = $3 AND attribute = $4
          AND valid_from > $5
        ORDER BY valid_from ASC LIMIT 1`,
      [tenantId, agentId, entityId, attribute, validFrom]
    );
    const successor = successorRes.rows[0];  // guaranteed to exist — `current` itself qualifies
    const validTo = successor ? successor.valid_from : current.valid_from;

    const inserted = await client.query(
      `INSERT INTO ${tbl}
        (tenant_id, agent_id, entity_id, session_row_id, evidence_session_id,
         attribute, value, valid_from, valid_to, evidence_text, confidence, source,
         idempotency_key, supersedes_state_id)
       VALUES ($1,$2,$3,$4,$5, $6,$7::jsonb,$8,$9, $10,$11,$12, $13,NULL)
       RETURNING *`,
      [tenantId, agentId, entityId, sessionRowId, evidenceSessionId,
       attribute, JSON.stringify(value), validFrom, validTo,
       evidenceText, confidence, source, idempotencyKey]
    );
    return { action: 'inserted_historical', row: mapRow(inserted.rows[0]) };
  }

  // Same value as current → noop. (Optionally bump last_seen via separate API,
  // but state_history is append-only by design.)
  if (current && canonicalJson(current.value) === canonicalJson(value)) {
    return { action: 'noop_same_value', row: mapRow(current) };
  }

  // Source-conflict guard: current row written by a different source, values
  // differ. Don't auto-override; bubble up so caller decides.
  if (current && current.source !== source) {
    const conflictErr = new Error(
      `entity_state_history: source conflict on (entity=${entityId}, attribute=${attribute}): current source=${current.source} value=${JSON.stringify(current.value)}, incoming source=${source} value=${JSON.stringify(value)}`
    );
    conflictErr.code = 'AQ_CONFLICT';
    throw conflictErr;
  }

  // Equal-timestamp different-value → conflict (history would be ambiguous).
  if (current && new Date(current.valid_from).getTime() === new Date(validFrom).getTime()) {
    const conflictErr = new Error(
      `entity_state_history: equal-timestamp conflict on (entity=${entityId}, attribute=${attribute}, valid_from=${validFrom}) — value change must advance time`
    );
    conflictErr.code = 'AQ_CONFLICT';
    throw conflictErr;
  }

  // Forward-in-time supersede: close current, insert new current.
  let supersededId = null;
  if (current) {
    await client.query(
      `UPDATE ${tbl} SET valid_to = $1 WHERE id = $2`,
      [validFrom, current.id]
    );
    supersededId = current.id;
  }

  const inserted = await client.query(
    `INSERT INTO ${tbl}
      (tenant_id, agent_id, entity_id, session_row_id, evidence_session_id,
       attribute, value, valid_from, evidence_text, confidence, source,
       idempotency_key, supersedes_state_id)
     VALUES ($1,$2,$3,$4,$5, $6,$7::jsonb,$8, $9,$10,$11, $12,$13)
     RETURNING *`,
    [tenantId, agentId, entityId, sessionRowId, evidenceSessionId,
     attribute, JSON.stringify(value), validFrom,
     evidenceText, confidence, source, idempotencyKey, supersededId]
  );

  return {
    action: supersededId ? 'closed_and_inserted' : 'inserted_current',
    row: mapRow(inserted.rows[0]),
  };
}

function createEntityState({ pool, schema, defaultTenantId }) {
  if (!pool) throw new Error('createEntityState: pool is required');
  if (!schema) throw new Error('createEntityState: schema is required');

  // ---------------------------------------------------------------------------
  // applyChanges (tx-aware, caller passes client)
  // ---------------------------------------------------------------------------
  async function applyChanges(client, input = {}) {
    try {
      if (!client || typeof client.query !== 'function') {
        return err('AQ_INVALID_INPUT', 'applyChanges requires a tx client');
      }
      const changes = Array.isArray(input.changes) ? input.changes : null;
      if (!changes) return err('AQ_INVALID_INPUT', 'changes must be an array');

      // Validate up-front (cheap, fail-fast before any DB work).
      for (let i = 0; i < changes.length; i++) {
        const msg = validateChange(changes[i], i);
        if (msg) return err('AQ_INVALID_INPUT', msg);
      }

      // Sort changes by valid_from ASC so within a single batch the supersede
      // chain is correctly built (older first, current last).
      const sorted = changes.slice().sort((a, b) =>
        new Date(a.validFrom).getTime() - new Date(b.validFrom).getTime()
      );

      const ctx = {
        schema,
        defaultTenantId,
        agentId: input.agentId,
        sessionRowId: input.sessionRowId,
        defaultConfidence: input.defaultConfidence,
      };

      const results = [];
      for (const change of sorted) {
        try {
          const r = await applyOneChange(client, change, ctx);
          results.push(r);
        } catch (e) {
          if (e.code === 'AQ_CONFLICT') return err('AQ_CONFLICT', e.message);
          throw e;
        }
      }
      return ok({ applied: results });
    } catch (e) {
      return err('AQ_INTERNAL', e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // applyChangesStandalone — convenience wrapper; opens its own savepointed tx.
  // ---------------------------------------------------------------------------
  async function applyChangesStandalone(input = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await applyChanges(client, input);
      if (result.ok) await client.query('COMMIT');
      else await client.query('ROLLBACK');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      return err('AQ_INTERNAL', e.message);
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // resolveEntity — accept entityId or entityName, return entityId.
  // ---------------------------------------------------------------------------
  async function resolveEntity({ entityId, entityName, tenantId, agentId: _agentId, entityScope }) {
    if (entityId !== null && entityId !== undefined) {
      // When caller passed entityScope, require the looked-up entity to
      // match it — otherwise the id can be used to read cross-scope state.
      const params = [Number(entityId), tenantId || defaultTenantId || 'default'];
      let scopeClause = '';
      if (entityScope) {
        params.push(entityScope);
        scopeClause = `AND entity_scope = $${params.length}`;
      }
      const r = await pool.query(
        `SELECT id, name FROM ${schema}.entities
          WHERE id = $1 AND tenant_id = $2 ${scopeClause} LIMIT 1`,
        params
      );
      if (r.rowCount === 0) return null;
      return { entityId: Number(r.rows[0].id), entityName: r.rows[0].name };
    }
    if (entityName) {
      const normalized = String(entityName).toLowerCase().normalize('NFKC').trim();
      const r = await pool.query(
        `SELECT id, name FROM ${schema}.entities
          WHERE tenant_id = $1 AND normalized_name = $2
            AND (entity_scope = $3 OR $3 IS NULL)
          ORDER BY id ASC LIMIT 1`,
        [tenantId || defaultTenantId || 'default', normalized, entityScope || null]
      );
      if (r.rowCount === 0) return null;
      return { entityId: Number(r.rows[0].id), entityName: r.rows[0].name };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // getEntityCurrentState
  // ---------------------------------------------------------------------------
  async function getEntityCurrentState(input = {}) {
    try {
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const agentId = input.agentId;
      if (!agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      if ((input.entityId === null || input.entityId === undefined) && !input.entityName) {
        return err('AQ_INVALID_INPUT', 'entityId or entityName is required');
      }
      const minConfidence = (input.minConfidence !== null && input.minConfidence !== undefined) ? Number(input.minConfidence) : 0;
      const attributes = Array.isArray(input.attributes) && input.attributes.length > 0
        ? input.attributes : null;

      const ent = await resolveEntity({
        entityId: input.entityId,
        entityName: input.entityName,
        tenantId,
        agentId,
        entityScope: input.entityScope,
      });
      if (!ent) return err('AQ_NOT_FOUND', `entity not found (${input.entityId ?? input.entityName})`);

      const params = [tenantId, agentId, ent.entityId, minConfidence];
      let attrClause = '';
      if (attributes) {
        params.push(attributes);
        attrClause = `AND attribute = ANY($${params.length})`;
      }
      const r = await pool.query(
        `SELECT * FROM ${schema}.entity_state_history
          WHERE tenant_id = $1 AND agent_id = $2 AND entity_id = $3
            AND valid_to IS NULL
            AND confidence >= $4
            ${attrClause}
          ORDER BY attribute ASC`,
        params
      );
      return ok({
        entityId: ent.entityId,
        entityName: ent.entityName,
        states: r.rows.map(mapRow),
      });
    } catch (e) {
      return err('AQ_INTERNAL', e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // getEntityStateHistory
  // ---------------------------------------------------------------------------
  async function getEntityStateHistory(input = {}) {
    try {
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const agentId = input.agentId;
      if (!agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      if ((input.entityId === null || input.entityId === undefined) && !input.entityName) {
        return err('AQ_INVALID_INPUT', 'entityId or entityName is required');
      }
      const attribute = input.attribute || null;  // optional: full entity history if omitted
      const limit = Math.max(1, Math.min(200, Number(input.limit) || 50));
      const minConfidence = (input.minConfidence !== null && input.minConfidence !== undefined) ? Number(input.minConfidence) : 0;
      const before = input.before ? toIsoOrNull(input.before) : null;

      const ent = await resolveEntity({
        entityId: input.entityId,
        entityName: input.entityName,
        tenantId,
        agentId,
        entityScope: input.entityScope,
      });
      if (!ent) return err('AQ_NOT_FOUND', `entity not found (${input.entityId ?? input.entityName})`);

      const where = [
        'tenant_id = $1', 'agent_id = $2', 'entity_id = $3', 'confidence >= $4',
      ];
      const params = [tenantId, agentId, ent.entityId, minConfidence];
      if (attribute) {
        params.push(attribute);
        where.push(`attribute = $${params.length}`);
      }
      if (before) {
        params.push(before);
        where.push(`valid_from < $${params.length}`);
      }
      params.push(limit);

      const r = await pool.query(
        `SELECT * FROM ${schema}.entity_state_history
          WHERE ${where.join(' AND ')}
          ORDER BY valid_from DESC, id DESC
          LIMIT $${params.length}`,
        params
      );
      return ok({
        entityId: ent.entityId,
        entityName: ent.entityName,
        rows: r.rows.map(mapRow),
      });
    } catch (e) {
      return err('AQ_INTERNAL', e.message);
    }
  }

  return {
    applyChanges,
    applyChangesStandalone,
    getEntityCurrentState,
    getEntityStateHistory,
    // expose for testing
    _internal: { defaultIdempotencyKey, canonicalJson, validateChange, applyOneChange, resolveEntity },
  };
}

module.exports = {
  createEntityState,
  defaultIdempotencyKey,
  canonicalJson,
  validateChange,
};
