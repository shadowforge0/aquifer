'use strict';

// aq.narratives.* — cross-session state snapshot capability.
//
// Spec: aquifer-completion §2 narrative. Strict core table is
// ${schema}.narratives, with at-most-one 'active' row per
// (tenant_id, agent_id, scope, scope_key) enforced by partial UNIQUE index
// idx_narratives_active_scope.
//
// upsertSnapshot atomically supersedes the prior active row and inserts a
// new active row. If the same idempotencyKey has already been recorded, the
// existing narrative is returned unchanged (safe replay).

const crypto = require('crypto');
const { AqError, ok, err } = require('./errors');

// Placeholder profile stamp — real stamps land via aq.schema registry
// (capability 4, P2-2b). Until then consumers may pass a partial profile
// or rely on this default so narratives/timeline can ship independently.
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

function defaultIdempotencyKey({ tenantId, agentId, scope, scopeKey, text }) {
  return crypto.createHash('sha256')
    .update(`${tenantId}:${agentId}:${scope}:${scopeKey}:${text}`)
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
    id: toNumber(row.id),
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    scope: row.scope,
    scopeKey: row.scope_key,
    sourceSessionId: row.source_session_id,
    text: row.text,
    status: row.status,
    basedOnFactIds: (row.based_on_fact_ids || []).map(toNumber),
    metadata: row.metadata || {},
    supersededByNarrativeId: toNumber(row.superseded_by_narrative_id),
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consumerProfileId: row.consumer_profile_id,
    consumerProfileVersion: row.consumer_profile_version,
    consumerSchemaHash: row.consumer_schema_hash,
  };
}

function createNarratives({ pool, schema, defaultTenantId }) {
  async function upsertSnapshot(input) {
    try {
      if (!input || typeof input !== 'object') {
        return err('AQ_INVALID_INPUT', 'upsertSnapshot requires an input object');
      }
      if (!input.agentId) {
        return err('AQ_INVALID_INPUT', 'agentId is required');
      }
      if (!input.text || typeof input.text !== 'string') {
        return err('AQ_INVALID_INPUT', 'text is required');
      }
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const agentId = input.agentId;
      const scope = input.scope || 'agent';
      const scopeKey = input.scopeKey || agentId;
      const text = input.text;
      const basedOnFactIds = Array.isArray(input.basedOnFactIds) ? input.basedOnFactIds : [];
      const metadata = input.metadata || {};
      const profile = resolveProfile(input.profile);
      const idempotencyKey = input.idempotencyKey
        || defaultIdempotencyKey({ tenantId, agentId, scope, scopeKey, text });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Idempotent replay: if this idempotency_key already exists, return it.
        const existing = await client.query(
          `SELECT * FROM ${schema}.narratives WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        if (existing.rowCount > 0) {
          await client.query('COMMIT');
          return ok({
            narrative: mapRow(existing.rows[0]),
            supersededNarrativeId: null,
          });
        }

        // Mark the prior active row (if any) as superseded; capture its id
        // so the caller can link supersede chain for observability.
        const prev = await client.query(
          `UPDATE ${schema}.narratives
             SET status = 'superseded'
           WHERE tenant_id = $1 AND agent_id = $2 AND scope = $3
             AND scope_key = $4 AND status = 'active'
           RETURNING id`,
          [tenantId, agentId, scope, scopeKey],
        );
        const supersededNarrativeId = prev.rowCount > 0 ? toNumber(prev.rows[0].id) : null;

        const inserted = await client.query(
          `INSERT INTO ${schema}.narratives (
             tenant_id, agent_id, scope, scope_key, text, status,
             based_on_fact_ids, metadata, source_session_id,
             consumer_profile_id, consumer_profile_version, consumer_schema_hash,
             idempotency_key
           ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            tenantId, agentId, scope, scopeKey, text,
            basedOnFactIds, metadata, input.sourceSessionId || null,
            profile.id, profile.version, profile.schemaHash,
            idempotencyKey,
          ],
        );

        if (supersededNarrativeId) {
          await client.query(
            `UPDATE ${schema}.narratives
               SET superseded_by_narrative_id = $1
             WHERE id = $2`,
            [inserted.rows[0].id, supersededNarrativeId],
          );
        }

        await client.query('COMMIT');
        return ok({
          narrative: mapRow(inserted.rows[0]),
          supersededNarrativeId,
        });
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
      if (!input.agentId) {
        return err('AQ_INVALID_INPUT', 'agentId is required');
      }
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const scope = input.scope || 'agent';
      const scopeKey = input.scopeKey || input.agentId;
      const { rows } = await pool.query(
        `SELECT * FROM ${schema}.narratives
          WHERE tenant_id = $1 AND agent_id = $2
            AND scope = $3 AND scope_key = $4
            AND status = 'active'
          LIMIT 1`,
        [tenantId, input.agentId, scope, scopeKey],
      );
      return ok({ narrative: mapRow(rows[0]) });
    } catch (e) {
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  async function listHistory(input = {}) {
    try {
      if (!input.agentId) {
        return err('AQ_INVALID_INPUT', 'agentId is required');
      }
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const scope = input.scope || 'agent';
      const scopeKey = input.scopeKey || input.agentId;
      const limit = Math.min(Math.max(input.limit || 20, 1), 200);
      const { rows } = await pool.query(
        `SELECT * FROM ${schema}.narratives
          WHERE tenant_id = $1 AND agent_id = $2
            AND scope = $3 AND scope_key = $4
          ORDER BY effective_at DESC, id DESC
          LIMIT $5`,
        [tenantId, input.agentId, scope, scopeKey, limit],
      );
      return ok({ rows: rows.map(mapRow) });
    } catch (e) {
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  return { upsertSnapshot, getLatest, listHistory };
}

module.exports = { createNarratives };
