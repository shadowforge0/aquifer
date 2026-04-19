'use strict';

// aq.profiles.* — consumer profile registry (capability #4 schemaRegistry).
//
// Spec: aquifer-completion §4 schemaRegistry, §D2 (consumer_profiles DDL).
// The P2-2b surface only covers register/load; diff + resolveForWrite +
// compiled template/schema generation land in P3 alongside prompt template
// engine and output parser work.
//
// register(): insert (tenant_id, consumer_id, version, profile_hash,
//   profile_json). If the same (consumer_id, version) with a different
//   profile_hash is submitted, the UNIQUE (consumer_id, version,
//   profile_hash) constraint makes this a conflict, returning
//   AQ_CONFLICT so callers must bump version rather than silently drift.
//
// load(): fetch latest non-deprecated version (or a specific version).

const crypto = require('crypto');
const { AqError, ok, err } = require('./errors');

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function canonicaliseJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicaliseJson);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicaliseJson(value[key]);
  }
  return sorted;
}

function computeProfileHash(profileJson) {
  // Stable hash over deeply-canonicalised JSON so semantically identical
  // profiles always produce the same hash regardless of key ordering.
  const canonical = JSON.stringify(canonicaliseJson(profileJson));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function mapRow(row) {
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    version: toNumber(row.version),
    profileHash: row.profile_hash,
    profile: row.profile_json,
    loadedAt: row.loaded_at,
    deprecatedAt: row.deprecated_at,
  };
}

function createProfiles({ pool, schema, defaultTenantId }) {
  async function register(input) {
    try {
      if (!input || typeof input !== 'object') {
        return err('AQ_INVALID_INPUT', 'register requires an input object');
      }
      if (!input.consumerId) return err('AQ_INVALID_INPUT', 'consumerId is required');
      if (!Number.isInteger(input.version) || input.version < 1) {
        return err('AQ_INVALID_INPUT', 'version must be a positive integer');
      }
      if (!input.profile || typeof input.profile !== 'object') {
        return err('AQ_INVALID_INPUT', 'profile (object) is required');
      }

      const tenantId = input.tenantId || defaultTenantId || 'default';
      const profileHash = input.profileHash || computeProfileHash(input.profile);

      // Try insert; if (tenant, consumer, version) already exists with a
      // different hash, map to AQ_CONFLICT — the caller must bump version.
      try {
        const { rows } = await pool.query(
          `INSERT INTO ${schema}.consumer_profiles
             (tenant_id, consumer_id, version, profile_hash, profile_json)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, consumer_id, version) DO NOTHING
           RETURNING *`,
          [tenantId, input.consumerId, input.version, profileHash, input.profile],
        );
        if (rows.length > 0) {
          return ok({
            consumerProfileId: input.consumerId,
            version: input.version,
            schemaHash: profileHash,
            inserted: true,
          });
        }
      } catch (e) {
        // UNIQUE (consumer_id, version, profile_hash) may still violate if
        // same version registered with different hash under a different
        // tenant — surface as conflict.
        if (e.code === '23505') {
          return err('AQ_CONFLICT', 'profile hash collision on (consumer_id, version)');
        }
        throw e;
      }

      // Row already exists — verify hash matches for idempotent replay.
      const existing = await pool.query(
        `SELECT profile_hash FROM ${schema}.consumer_profiles
          WHERE tenant_id = $1 AND consumer_id = $2 AND version = $3`,
        [tenantId, input.consumerId, input.version],
      );
      if (existing.rows[0].profile_hash !== profileHash) {
        return err('AQ_CONFLICT',
          `profile (${input.consumerId} v${input.version}) already registered with a different hash — bump version`);
      }
      return ok({
        consumerProfileId: input.consumerId,
        version: input.version,
        schemaHash: profileHash,
        inserted: false,
      });
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  async function load(input = {}) {
    try {
      if (!input.consumerId) return err('AQ_INVALID_INPUT', 'consumerId is required');
      const tenantId = input.tenantId || defaultTenantId || 'default';

      let rows;
      if (input.version === 'latest' || input.version === undefined || input.version === null) {
        const result = await pool.query(
          `SELECT * FROM ${schema}.consumer_profiles
            WHERE tenant_id = $1 AND consumer_id = $2 AND deprecated_at IS NULL
            ORDER BY version DESC
            LIMIT 1`,
          [tenantId, input.consumerId],
        );
        rows = result.rows;
      } else if (Number.isInteger(input.version) && input.version >= 1) {
        const result = await pool.query(
          `SELECT * FROM ${schema}.consumer_profiles
            WHERE tenant_id = $1 AND consumer_id = $2 AND version = $3`,
          [tenantId, input.consumerId, input.version],
        );
        rows = result.rows;
      } else {
        return err('AQ_INVALID_INPUT', 'version must be a positive integer or "latest"');
      }

      if (rows.length === 0) {
        return err('AQ_PROFILE_NOT_FOUND',
          `no profile for consumer=${input.consumerId} version=${input.version || 'latest'}`);
      }
      const mapped = mapRow(rows[0]);
      return ok({
        profile: mapped.profile,
        consumerProfileId: mapped.consumerId,
        version: mapped.version,
        schemaHash: mapped.profileHash,
        loadedAt: mapped.loadedAt,
      });
    } catch (e) {
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  return { register, load };
}

module.exports = { createProfiles };
