'use strict';

// aq.artifacts.* — producer-declared output record capability.
//
// Spec: aquifer-completion §12 artifact. Aquifer stores the declaration +
// lifecycle status but never interprets the payload. Producers own shape.
// Typical flow: record with status='pending', produce content externally,
// then upsert same idempotency_key with status='produced' + contentRef.

const crypto = require('crypto');
const { AqError, ok, err } = require('./errors');

const DEFAULT_PROFILE = Object.freeze({
  id: 'anon',
  version: 0,
  schemaHash: 'pending',
});

const VALID_STATUSES = new Set(['pending', 'produced', 'failed', 'discarded']);

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

function defaultIdempotencyKey({ tenantId, producerId, sessionId, artifactType, destination }) {
  return crypto.createHash('sha256')
    .update(`${tenantId}:${producerId}:${sessionId || ''}:${artifactType}:${destination}`)
    .digest('hex');
}

function mapRow(row) {
  if (!row) return null;
  return {
    artifactId: toNumber(row.id),
    agentId: row.agent_id,
    sessionId: row.source_session_id,
    producerId: row.producer_id,
    type: row.artifact_type,
    triggerPhase: row.trigger_phase,
    format: row.format,
    destination: row.destination,
    status: row.status,
    contentRef: row.content_ref,
    payload: row.payload || {},
    metadata: row.metadata || {},
    producedAt: row.produced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createArtifacts({ pool, schema, defaultTenantId }) {
  async function record(input) {
    try {
      if (!input || typeof input !== 'object') {
        return err('AQ_INVALID_INPUT', 'record requires an input object');
      }
      if (!input.agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      if (!input.producerId) return err('AQ_INVALID_INPUT', 'producerId is required');
      if (!input.type) return err('AQ_INVALID_INPUT', 'type is required');
      if (!input.format) return err('AQ_INVALID_INPUT', 'format is required');
      if (!input.destination) return err('AQ_INVALID_INPUT', 'destination is required');

      const status = input.status || 'pending';
      if (!VALID_STATUSES.has(status)) {
        return err('AQ_INVALID_INPUT',
          `status must be one of ${Array.from(VALID_STATUSES).join(', ')}`);
      }

      const tenantId = input.tenantId || defaultTenantId || 'default';
      const profile = resolveProfile(input.profile);
      const idempotencyKey = input.idempotencyKey
        || defaultIdempotencyKey({
          tenantId,
          producerId: input.producerId,
          sessionId: input.sessionId,
          artifactType: input.type,
          destination: input.destination,
        });

      // Upsert semantics: producer may re-record the same artifact with
      // updated status ('pending' → 'produced'), so DO UPDATE on matching
      // idempotency_key, allowing lifecycle transitions.
      const { rows } = await pool.query(
        `INSERT INTO ${schema}.artifacts (
           tenant_id, agent_id, source_session_id,
           consumer_profile_id, consumer_profile_version, consumer_schema_hash,
           idempotency_key, producer_id, artifact_type, trigger_phase,
           format, destination, status, content_ref, payload, metadata,
           produced_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                   CASE WHEN $13 = 'produced' THEN COALESCE($17::timestamptz, now()) ELSE $17::timestamptz END)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           status = EXCLUDED.status,
           content_ref = COALESCE(EXCLUDED.content_ref, ${schema}.artifacts.content_ref),
           payload = EXCLUDED.payload,
           metadata = EXCLUDED.metadata,
           produced_at = CASE
             WHEN EXCLUDED.status = 'produced' AND ${schema}.artifacts.produced_at IS NULL
               THEN now()
             ELSE ${schema}.artifacts.produced_at
           END
         RETURNING *`,
        [
          tenantId, input.agentId, input.sessionId || null,
          profile.id, profile.version, profile.schemaHash,
          idempotencyKey, input.producerId, input.type,
          input.triggerPhase || null, input.format, input.destination,
          status, input.contentRef || null,
          JSON.stringify(input.payload || {}),
          JSON.stringify(input.metadata || {}),
          input.producedAt || null,
        ],
      );
      const mapped = mapRow(rows[0]);
      return ok({ artifactId: mapped.artifactId });
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  async function list(input = {}) {
    try {
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const limit = Math.min(Math.max(input.limit || 50, 1), 500);
      const params = [tenantId];
      let where = 'tenant_id = $1';
      if (input.agentId) {
        params.push(input.agentId);
        where += ` AND agent_id = $${params.length}`;
      }
      if (input.sessionId) {
        params.push(input.sessionId);
        where += ` AND source_session_id = $${params.length}`;
      }
      if (input.producerId) {
        params.push(input.producerId);
        where += ` AND producer_id = $${params.length}`;
      }
      if (Array.isArray(input.statuses) && input.statuses.length > 0) {
        params.push(input.statuses);
        where += ` AND status = ANY($${params.length})`;
      }
      params.push(limit);

      const { rows } = await pool.query(
        `SELECT * FROM ${schema}.artifacts
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${params.length}`,
        params,
      );
      return ok({ rows: rows.map(mapRow) });
    } catch (e) {
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  return { record, list };
}

module.exports = { createArtifacts };
