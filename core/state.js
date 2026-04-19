'use strict';

// aq.state.* — latest-snapshot-per-scope session state capability.
//
// Spec: aquifer-completion §7 sessionState. Strict core table is
// ${schema}.session_states. Default shape
// { goal, active_work, blockers, affect } is projected to explicit
// columns for cheap filtering; full payload also stored as JSONB so
// consumer-specific fields are lossless.
//
// write() supersedes the prior is_latest=true row for the same
// (tenant, agent, scope_key) atomically. idempotencyKey replay returns
// the existing row unchanged. Partial unique index enforces at-most-one
// latest per scope.

const crypto = require('crypto');
const { AqError, ok, err } = require('./errors');

const DEFAULT_PROFILE = Object.freeze({
  id: 'anon',
  version: 0,
  schemaHash: 'pending',
});

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

function defaultIdempotencyKey({ tenantId, agentId, scopeKey, payload }) {
  return crypto.createHash('sha256')
    .update(`${tenantId}:${agentId}:${scopeKey}:${JSON.stringify(payload)}`)
    .digest('hex');
}

function mapRow(row) {
  if (!row) return null;
  return {
    stateId: toNumber(row.id),
    agentId: row.agent_id,
    scopeKey: row.scope_key,
    payload: row.payload || {},
    isLatest: row.is_latest,
    supersedesStateId: toNumber(row.supersedes_state_id),
    createdAt: row.created_at,
  };
}

function createState({ pool, schema, defaultTenantId }) {
  async function write(input) {
    try {
      if (!input || typeof input !== 'object') {
        return err('AQ_INVALID_INPUT', 'write requires an input object');
      }
      if (!input.agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      if (!input.payload || typeof input.payload !== 'object') {
        return err('AQ_INVALID_INPUT', 'payload is required');
      }
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const agentId = input.agentId;
      const scopeKey = input.scopeKey || agentId;
      const payload = input.payload;
      const profile = resolveProfile(input.profile);
      const idempotencyKey = input.idempotencyKey
        || defaultIdempotencyKey({ tenantId, agentId, scopeKey, payload });

      // Projected columns for cheap filtering/indexes. Fall back cleanly
      // when payload uses consumer-specific shape.
      const goal = typeof payload.goal === 'string' ? payload.goal : null;
      const activeWork = Array.isArray(payload.active_work) ? payload.active_work : [];
      const blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
      const affect = payload.affect && typeof payload.affect === 'object' ? payload.affect : {};

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existing = await client.query(
          `SELECT * FROM ${schema}.session_states WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        if (existing.rowCount > 0) {
          await client.query('COMMIT');
          return ok(mapRow(existing.rows[0]));
        }

        const prev = await client.query(
          `UPDATE ${schema}.session_states
             SET is_latest = false
           WHERE tenant_id = $1 AND agent_id = $2 AND scope_key = $3
             AND is_latest = true
           RETURNING id`,
          [tenantId, agentId, scopeKey],
        );
        const supersedesStateId = prev.rowCount > 0 ? toNumber(prev.rows[0].id) : null;

        const inserted = await client.query(
          `INSERT INTO ${schema}.session_states (
             tenant_id, agent_id, scope_key, source_session_id,
             consumer_profile_id, consumer_profile_version, consumer_schema_hash,
             idempotency_key, goal, active_work, blockers, affect, payload,
             is_latest, supersedes_state_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, $14)
           RETURNING *`,
          [
            tenantId, agentId, scopeKey, input.sessionId || null,
            profile.id, profile.version, profile.schemaHash,
            idempotencyKey, goal,
            JSON.stringify(activeWork), JSON.stringify(blockers), JSON.stringify(affect),
            JSON.stringify(payload), supersedesStateId,
          ],
        );

        await client.query('COMMIT');
        return ok(mapRow(inserted.rows[0]));
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  async function getLatest(input = {}) {
    try {
      if (!input.agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const scopeKey = input.scopeKey || input.agentId;
      const { rows } = await pool.query(
        `SELECT * FROM ${schema}.session_states
          WHERE tenant_id = $1 AND agent_id = $2
            AND scope_key = $3 AND is_latest = true
          LIMIT 1`,
        [tenantId, input.agentId, scopeKey],
      );
      const mapped = mapRow(rows[0]);
      return ok({
        state: mapped ? mapped.payload : null,
        stateId: mapped ? mapped.stateId : null,
      });
    } catch (e) {
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  return { write, getLatest };
}

module.exports = { createState };
