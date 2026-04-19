'use strict';

// aq.decisions.* — append-only decision log capability.
//
// Spec: aquifer-completion §9 decisionLog. status vocabulary
// (proposed/committed/reversed) enforced both at API layer (fast reject)
// and by DB CHECK constraint (defense in depth). reversal is implemented
// by appending a new 'reversed' decision and optionally pointing
// reversed_by_decision_id; Aquifer doesn't auto-compute the chain.

const crypto = require('crypto');
const { AqError, ok, err } = require('./errors');

const DEFAULT_PROFILE = Object.freeze({
  id: 'anon',
  version: 0,
  schemaHash: 'pending',
});

const VALID_STATUSES = new Set(['proposed', 'committed', 'reversed']);

function resolveProfile(profile) {
  if (!profile) return DEFAULT_PROFILE;
  return {
    id: profile.id || DEFAULT_PROFILE.id,
    version: Number.isInteger(profile.version) ? profile.version : DEFAULT_PROFILE.version,
    schemaHash: profile.schemaHash || DEFAULT_PROFILE.schemaHash,
  };
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function defaultIdempotencyKey({ tenantId, agentId, sessionId, payload }) {
  return crypto.createHash('sha256')
    .update(`${tenantId}:${agentId}:${sessionId}:${JSON.stringify(payload)}`)
    .digest('hex');
}

function mapRow(row) {
  if (!row) return null;
  return {
    decisionId: toNumber(row.id),
    sessionId: row.source_session_id,
    agentId: row.agent_id,
    status: row.status,
    decisionText: row.decision_text,
    reasonText: row.reason_text,
    payload: row.payload || {},
    metadata: row.metadata || {},
    decidedAt: row.decided_at,
    reversedByDecisionId: toNumber(row.reversed_by_decision_id),
    createdAt: row.created_at,
  };
}

function createDecisions({ pool, schema, defaultTenantId }) {
  async function append(input) {
    try {
      if (!input || typeof input !== 'object') {
        return err('AQ_INVALID_INPUT', 'append requires an input object');
      }
      if (!input.agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      if (!input.sessionId) return err('AQ_INVALID_INPUT', 'sessionId is required');
      if (!input.payload || typeof input.payload !== 'object') {
        return err('AQ_INVALID_INPUT', 'payload is required');
      }
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const agentId = input.agentId;
      const sessionId = input.sessionId;
      const payload = input.payload;
      const profile = resolveProfile(input.profile);

      const status = payload.status || 'committed';
      if (!VALID_STATUSES.has(status)) {
        return err('AQ_INVALID_INPUT',
          `status must be one of ${Array.from(VALID_STATUSES).join(', ')}`);
      }
      const decisionText = typeof payload.decision === 'string'
        ? payload.decision
        : (typeof payload.decision_text === 'string' ? payload.decision_text : null);
      if (!decisionText) {
        return err('AQ_INVALID_INPUT', 'payload.decision (or decision_text) is required');
      }
      const reasonText = typeof payload.reason === 'string'
        ? payload.reason
        : (typeof payload.reason_text === 'string' ? payload.reason_text : null);

      const idempotencyKey = input.idempotencyKey
        || defaultIdempotencyKey({ tenantId, agentId, sessionId, payload });

      const insertResult = await pool.query(
        `INSERT INTO ${schema}.decisions (
           tenant_id, agent_id, source_session_id,
           consumer_profile_id, consumer_profile_version, consumer_schema_hash,
           idempotency_key, payload, status, decision_text, reason_text,
           decided_at, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   COALESCE($12::timestamptz, now()), $13)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          tenantId, agentId, sessionId,
          profile.id, profile.version, profile.schemaHash,
          idempotencyKey, JSON.stringify(payload), status,
          decisionText, reasonText,
          input.decidedAt || null,
          JSON.stringify(payload.metadata || {}),
        ],
      );
      let row = insertResult.rows[0];
      if (!row) {
        const existing = await pool.query(
          `SELECT * FROM ${schema}.decisions WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        row = existing.rows[0];
      }
      const mapped = mapRow(row);
      return ok({ decisionId: mapped.decisionId, payload: mapped.payload });
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  async function list(input = {}) {
    try {
      if (!input.agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const limit = Math.min(Math.max(input.limit || 50, 1), 500);

      const params = [tenantId, input.agentId];
      let where = 'tenant_id = $1 AND agent_id = $2';
      if (Array.isArray(input.statuses) && input.statuses.length > 0) {
        params.push(input.statuses);
        where += ` AND status = ANY($${params.length})`;
      }
      if (input.sessionId) {
        params.push(input.sessionId);
        where += ` AND source_session_id = $${params.length}`;
      }
      params.push(limit);

      const { rows } = await pool.query(
        `SELECT * FROM ${schema}.decisions
          WHERE ${where}
          ORDER BY decided_at DESC, id DESC
          LIMIT $${params.length}`,
        params,
      );
      return ok({ rows: rows.map(mapRow) });
    } catch (e) {
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  return { append, list };
}

module.exports = { createDecisions };
