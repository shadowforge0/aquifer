'use strict';

// aq.timeline.* — append-only event log capability.
//
// Spec: aquifer-completion §10 timeline. Fixed event shape
// (occurred_at / source / session_ref / category / text / metadata),
// consumer-owned category vocabulary. idempotency_key UNIQUE across the
// table; appends with a duplicate key are a safe no-op and return the
// existing row.

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

function defaultIdempotencyKey({ tenantId, agentId, occurredAt, category, text }) {
  return crypto.createHash('sha256')
    .update(`${tenantId}:${agentId}:${occurredAt}:${category}:${text}`)
    .digest('hex');
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRow(row) {
  if (!row) return null;
  return {
    eventId: toNumber(row.id),
    occurredAt: row.occurred_at,
    source: row.source,
    sessionRef: row.session_ref,
    category: row.category,
    text: row.text,
    metadata: row.metadata || {},
  };
}

function createTimeline({ pool, schema, defaultTenantId }) {
  async function append(input) {
    try {
      if (!input || typeof input !== 'object') {
        return err('AQ_INVALID_INPUT', 'append requires an input object');
      }
      if (!input.agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      if (!input.occurredAt) return err('AQ_INVALID_INPUT', 'occurredAt is required');
      if (!input.source) return err('AQ_INVALID_INPUT', 'source is required');
      if (!input.category) return err('AQ_INVALID_INPUT', 'category is required');
      if (!input.text || typeof input.text !== 'string') {
        return err('AQ_INVALID_INPUT', 'text is required');
      }

      const tenantId = input.tenantId || defaultTenantId || 'default';
      const agentId = input.agentId;
      const profile = resolveProfile(input.profile);
      const idempotencyKey = input.idempotencyKey
        || defaultIdempotencyKey({
          tenantId, agentId,
          occurredAt: input.occurredAt,
          category: input.category,
          text: input.text,
        });

      // Idempotent append: on conflict, fall back to SELECT so the caller
      // always gets the canonical row (the row that *won* the insert).
      const insertResult = await pool.query(
        `INSERT INTO ${schema}.timeline_events (
           tenant_id, agent_id, occurred_at, source, session_ref,
           category, text, metadata, source_session_id,
           consumer_profile_id, consumer_profile_version, consumer_schema_hash,
           idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          tenantId, agentId, input.occurredAt, input.source,
          input.sessionRef || null, input.category, input.text,
          input.metadata || {}, input.sessionId || null,
          profile.id, profile.version, profile.schemaHash,
          idempotencyKey,
        ],
      );
      let row = insertResult.rows[0];
      if (!row) {
        const existing = await pool.query(
          `SELECT * FROM ${schema}.timeline_events WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        row = existing.rows[0];
      }
      const mapped = mapRow(row);
      return ok({ eventId: mapped.eventId, event: mapped });
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
      if (Array.isArray(input.categories) && input.categories.length > 0) {
        params.push(input.categories);
        where += ` AND category = ANY($${params.length})`;
      }
      if (input.since) {
        params.push(input.since);
        where += ` AND occurred_at >= $${params.length}`;
      }
      if (input.until) {
        params.push(input.until);
        where += ` AND occurred_at <= $${params.length}`;
      }
      params.push(limit);

      const { rows } = await pool.query(
        `SELECT * FROM ${schema}.timeline_events
          WHERE ${where}
          ORDER BY occurred_at DESC, id DESC
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

module.exports = { createTimeline };
