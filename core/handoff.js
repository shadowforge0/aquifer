'use strict';

// aq.handoff.* — append-only session handoff capability.
//
// Spec: aquifer-completion §8 sessionHandoff. Every write is an append.
// getLatest retrieves by created_at DESC, optionally narrowed to a single
// sessionId.

const crypto = require('crypto');
const { AqError, ok, err } = require('./errors');

const DEFAULT_PROFILE = Object.freeze({
  id: 'anon',
  version: 0,
  schemaHash: 'pending',
});

const VALID_STATUSES = new Set(['in_progress', 'completed', 'blocked']);

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
    handoffId: toNumber(row.id),
    sessionId: row.source_session_id,
    agentId: row.agent_id,
    status: row.status,
    lastStep: row.last_step,
    nextStep: row.next_step,
    blockers: row.blockers || [],
    decided: row.decided || [],
    openLoops: row.open_loops || [],
    payload: row.payload || {},
    createdAt: row.created_at,
  };
}

function createHandoff({ pool, schema, defaultTenantId }) {
  async function write(input) {
    try {
      if (!input || typeof input !== 'object') {
        return err('AQ_INVALID_INPUT', 'write requires an input object');
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

      const status = payload.status || 'in_progress';
      if (!VALID_STATUSES.has(status)) {
        return err('AQ_INVALID_INPUT', `status must be one of ${Array.from(VALID_STATUSES).join(', ')}`);
      }
      const lastStep = typeof payload.last_step === 'string' ? payload.last_step : null;
      const nextStep = typeof payload.next === 'string' ? payload.next : null;
      const blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
      const decided = Array.isArray(payload.decided) ? payload.decided : [];
      const openLoops = Array.isArray(payload.open_loops) ? payload.open_loops : [];
      const idempotencyKey = input.idempotencyKey
        || defaultIdempotencyKey({ tenantId, agentId, sessionId, payload });

      // ON CONFLICT DO NOTHING + fallback SELECT for the canonical row.
      const insertResult = await pool.query(
        `INSERT INTO ${schema}.session_handoffs (
           tenant_id, agent_id, source_session_id,
           consumer_profile_id, consumer_profile_version, consumer_schema_hash,
           idempotency_key, status, last_step, next_step,
           blockers, decided, open_loops, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          tenantId, agentId, sessionId,
          profile.id, profile.version, profile.schemaHash,
          idempotencyKey, status, lastStep, nextStep,
          JSON.stringify(blockers), JSON.stringify(decided),
          JSON.stringify(openLoops), JSON.stringify(payload),
        ],
      );
      let row = insertResult.rows[0];
      if (!row) {
        const existing = await pool.query(
          `SELECT * FROM ${schema}.session_handoffs WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        row = existing.rows[0];
      }
      const mapped = mapRow(row);
      return ok({ handoffId: mapped.handoffId, payload: mapped.payload });
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  async function getLatest(input = {}) {
    try {
      if (!input.agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      const tenantId = input.tenantId || defaultTenantId || 'default';

      const params = [tenantId, input.agentId];
      let where = 'tenant_id = $1 AND agent_id = $2';
      if (input.sessionId) {
        params.push(input.sessionId);
        where += ` AND source_session_id = $${params.length}`;
      }

      const { rows } = await pool.query(
        `SELECT * FROM ${schema}.session_handoffs
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        params,
      );
      const mapped = mapRow(rows[0]);
      return ok({
        handoff: mapped ? mapped.payload : null,
        handoffId: mapped ? mapped.handoffId : null,
      });
    } catch (e) {
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  return { write, getLatest };
}

module.exports = { createHandoff };
