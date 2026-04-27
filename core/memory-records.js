'use strict';

const crypto = require('crypto');

function requireField(obj, field) {
  if (!obj || obj[field] === undefined || obj[field] === null || obj[field] === '') {
    throw new Error(`${field} is required`);
  }
}

function toJson(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function toJsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function advisoryLockKeys(namespace, value) {
  const digest = crypto.createHash('sha256').update(`${namespace}:${value}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

const BOOTSTRAP_ORDER_SQL = `
         CASE m.memory_type
           WHEN 'constraint' THEN 0
           WHEN 'preference' THEN 1
           WHEN 'state' THEN 2
           WHEN 'open_loop' THEN 3
           WHEN 'decision' THEN 4
           WHEN 'fact' THEN 5
           WHEN 'conclusion' THEN 6
           WHEN 'entity_note' THEN 7
           ELSE 99
         END ASC,
         CASE m.authority
           WHEN 'user_explicit' THEN 0
           WHEN 'executable_evidence' THEN 1
           WHEN 'manual' THEN 2
           WHEN 'system' THEN 3
           WHEN 'verified_summary' THEN 4
           WHEN 'llm_inference' THEN 5
           WHEN 'raw_transcript' THEN 6
           ELSE 99
         END ASC,
         m.accepted_at DESC NULLS LAST,
         m.id ASC`;

function createMemoryRecords({ pool, schema, defaultTenantId, inTransaction = false }) {
  const scopes = `${schema}.scopes`;
  const versions = `${schema}.versions`;
  const memories = `${schema}.memory_records`;
  const factAssertions = `${schema}.fact_assertions_v1`;
  const evidenceRefs = `${schema}.evidence_refs`;
  const feedback = `${schema}.feedback`;
  const canTransact = typeof pool.connect === 'function';

  async function upsertScope(input = {}) {
    requireField(input, 'scopeKind');
    requireField(input, 'scopeKey');
    const tenantId = input.tenantId || defaultTenantId;
    const result = await pool.query(
      `INSERT INTO ${scopes} (
         tenant_id, scope_kind, scope_key, parent_scope_id, inheritance_mode,
         context_key, topic_key, metadata, active_from, active_to
       )
       VALUES ($1,$2,$3,$4,COALESCE($5,'defaultable'),$6,$7,COALESCE($8::jsonb,'{}'::jsonb),$9,$10)
       ON CONFLICT (tenant_id, scope_kind, scope_key) DO UPDATE SET
         parent_scope_id = COALESCE(EXCLUDED.parent_scope_id, ${scopes}.parent_scope_id),
         inheritance_mode = EXCLUDED.inheritance_mode,
         context_key = COALESCE(EXCLUDED.context_key, ${scopes}.context_key),
         topic_key = COALESCE(EXCLUDED.topic_key, ${scopes}.topic_key),
         metadata = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${scopes}.metadata),
         active_from = COALESCE(EXCLUDED.active_from, ${scopes}.active_from),
         active_to = COALESCE(EXCLUDED.active_to, ${scopes}.active_to)
       RETURNING *`,
      [
        tenantId,
        input.scopeKind,
        input.scopeKey,
        input.parentScopeId || null,
        input.inheritanceMode || 'defaultable',
        input.contextKey || null,
        input.topicKey || null,
        toJson(input.metadata, {}),
        input.activeFrom || null,
        input.activeTo || null,
      ]
    );
    return result.rows[0] || null;
  }

  async function createVersion(input = {}) {
    requireField(input, 'versionKind');
    requireField(input, 'version');
    requireField(input, 'versionHash');
    const tenantId = input.tenantId || defaultTenantId;
    const result = await pool.query(
      `INSERT INTO ${versions} (
         tenant_id, version_kind, version, version_hash, active, metadata,
         released_at, retired_at
       )
       VALUES ($1,$2,$3,$4,COALESCE($5,false),COALESCE($6::jsonb,'{}'::jsonb),COALESCE($7,now()),$8)
       ON CONFLICT (tenant_id, version_kind, version_hash) DO UPDATE SET
         version = EXCLUDED.version,
         metadata = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${versions}.metadata),
         retired_at = COALESCE(EXCLUDED.retired_at, ${versions}.retired_at)
       RETURNING *`,
      [
        tenantId,
        input.versionKind,
        input.version,
        input.versionHash,
        input.active === true,
        toJson(input.metadata, {}),
        input.releasedAt || null,
        input.retiredAt || null,
      ]
    );
    return result.rows[0] || null;
  }

  async function upsertMemory(input = {}) {
    requireField(input, 'memoryType');
    requireField(input, 'canonicalKey');
    requireField(input, 'scopeId');
    const tenantId = input.tenantId || defaultTenantId;
    const status = input.status || 'candidate';
    const result = await pool.query(
      `INSERT INTO ${memories} (
         tenant_id, memory_type, canonical_key, scope_id, context_key, topic_key,
         title, summary, payload, status, authority, accepted_at, valid_from,
         valid_to, stale_after, superseded_by, backing_fact_id, observed_at,
         revoked_at, superseded_at, version_id, visible_in_bootstrap,
         visible_in_recall, rank_features, created_by_finalization_id,
         created_by_compaction_run_id
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,COALESCE($8,''),COALESCE($9::jsonb,'{}'::jsonb),
         COALESCE($10,'candidate'),COALESCE($11,'llm_inference'),$12,$13,$14,$15,
         $16,$17,$18,$19,$20,$21,COALESCE($22,false),COALESCE($23,false),COALESCE($24::jsonb,'{}'::jsonb),$25,$26
       )
       ON CONFLICT (tenant_id, canonical_key) WHERE status = 'active' DO UPDATE SET
         scope_id = EXCLUDED.scope_id,
         context_key = COALESCE(EXCLUDED.context_key, ${memories}.context_key),
         topic_key = COALESCE(EXCLUDED.topic_key, ${memories}.topic_key),
         title = COALESCE(EXCLUDED.title, ${memories}.title),
         summary = COALESCE(NULLIF(EXCLUDED.summary, ''), ${memories}.summary),
         payload = COALESCE(NULLIF(EXCLUDED.payload, '{}'::jsonb), ${memories}.payload),
         authority = EXCLUDED.authority,
         accepted_at = COALESCE(EXCLUDED.accepted_at, ${memories}.accepted_at),
         valid_from = COALESCE(EXCLUDED.valid_from, ${memories}.valid_from),
         valid_to = COALESCE(EXCLUDED.valid_to, ${memories}.valid_to),
         stale_after = COALESCE(EXCLUDED.stale_after, ${memories}.stale_after),
         version_id = COALESCE(EXCLUDED.version_id, ${memories}.version_id),
         backing_fact_id = COALESCE(EXCLUDED.backing_fact_id, ${memories}.backing_fact_id),
         observed_at = COALESCE(EXCLUDED.observed_at, ${memories}.observed_at),
         revoked_at = COALESCE(EXCLUDED.revoked_at, ${memories}.revoked_at),
         superseded_at = COALESCE(EXCLUDED.superseded_at, ${memories}.superseded_at),
         visible_in_bootstrap = EXCLUDED.visible_in_bootstrap,
         visible_in_recall = EXCLUDED.visible_in_recall,
         rank_features = COALESCE(NULLIF(EXCLUDED.rank_features, '{}'::jsonb), ${memories}.rank_features),
         created_by_finalization_id = COALESCE(${memories}.created_by_finalization_id, EXCLUDED.created_by_finalization_id),
         created_by_compaction_run_id = COALESCE(${memories}.created_by_compaction_run_id, EXCLUDED.created_by_compaction_run_id)
       RETURNING *`,
      [
        tenantId,
        input.memoryType,
        input.canonicalKey,
        input.scopeId,
        input.contextKey || null,
        input.topicKey || null,
        input.title || null,
        input.summary || '',
        toJson(input.payload, {}),
        status,
        input.authority || 'llm_inference',
        input.acceptedAt || (status === 'active' ? new Date().toISOString() : null),
        input.validFrom || null,
        input.validTo || null,
        input.staleAfter || null,
        input.supersededBy || null,
        input.backingFactId || input.backing_fact_id || null,
        input.observedAt || input.observed_at || null,
        input.revokedAt || input.revoked_at || null,
        input.supersededAt || input.superseded_at || null,
        input.versionId || null,
        input.visibleInBootstrap === true,
        input.visibleInRecall === true,
        toJson(input.rankFeatures, {}),
        input.createdByFinalizationId || input.created_by_finalization_id || null,
        input.createdByCompactionRunId || input.created_by_compaction_run_id || null,
      ]
    );
    return result.rows[0] || null;
  }

  async function upsertFactAssertion(input = {}) {
    requireField(input, 'canonicalKey');
    requireField(input, 'scopeId');
    requireField(input, 'predicate');
    requireField(input, 'objectKind');
    requireField(input, 'assertionHash');
    const tenantId = input.tenantId || defaultTenantId;
    const status = input.status || 'active';
    const result = await pool.query(
      `INSERT INTO ${factAssertions} (
         tenant_id, canonical_key, scope_id, subject_entity_id, predicate,
         object_kind, object_entity_id, object_value_json, qualifiers_json,
         valid_from, valid_to, observed_at, stale_after, accepted_at,
         revoked_at, superseded_at, status, authority, assertion_hash,
         superseded_by, version_id, metadata, created_by_finalization_id,
         created_by_compaction_run_id
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,COALESCE($9::jsonb,'{}'::jsonb),
         $10,$11,$12,$13,$14,$15,$16,COALESCE($17,'active'),COALESCE($18,'verified_summary'),
         $19,$20,$21,COALESCE($22::jsonb,'{}'::jsonb),$23,$24
       )
       ON CONFLICT (tenant_id, canonical_key) WHERE status = 'active' DO UPDATE SET
         scope_id = EXCLUDED.scope_id,
         subject_entity_id = COALESCE(EXCLUDED.subject_entity_id, ${factAssertions}.subject_entity_id),
         predicate = EXCLUDED.predicate,
         object_kind = EXCLUDED.object_kind,
         object_entity_id = COALESCE(EXCLUDED.object_entity_id, ${factAssertions}.object_entity_id),
         object_value_json = EXCLUDED.object_value_json,
         qualifiers_json = COALESCE(NULLIF(EXCLUDED.qualifiers_json, '{}'::jsonb), ${factAssertions}.qualifiers_json),
         valid_from = COALESCE(EXCLUDED.valid_from, ${factAssertions}.valid_from),
         valid_to = COALESCE(EXCLUDED.valid_to, ${factAssertions}.valid_to),
         observed_at = COALESCE(EXCLUDED.observed_at, ${factAssertions}.observed_at),
         stale_after = COALESCE(EXCLUDED.stale_after, ${factAssertions}.stale_after),
         accepted_at = COALESCE(EXCLUDED.accepted_at, ${factAssertions}.accepted_at),
         revoked_at = COALESCE(EXCLUDED.revoked_at, ${factAssertions}.revoked_at),
         superseded_at = COALESCE(EXCLUDED.superseded_at, ${factAssertions}.superseded_at),
         authority = EXCLUDED.authority,
         assertion_hash = EXCLUDED.assertion_hash,
         version_id = COALESCE(EXCLUDED.version_id, ${factAssertions}.version_id),
         metadata = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${factAssertions}.metadata),
         created_by_finalization_id = COALESCE(${factAssertions}.created_by_finalization_id, EXCLUDED.created_by_finalization_id),
         created_by_compaction_run_id = COALESCE(${factAssertions}.created_by_compaction_run_id, EXCLUDED.created_by_compaction_run_id),
         updated_at = now()
       RETURNING *`,
      [
        tenantId,
        input.canonicalKey,
        input.scopeId,
        input.subjectEntityId || input.subject_entity_id || null,
        input.predicate,
        input.objectKind || input.object_kind,
        input.objectEntityId || input.object_entity_id || null,
        toJsonOrNull(input.objectValueJson ?? input.object_value_json),
        toJson(input.qualifiersJson ?? input.qualifiers_json, {}),
        input.validFrom || input.valid_from || null,
        input.validTo || input.valid_to || null,
        input.observedAt || input.observed_at || null,
        input.staleAfter || input.stale_after || null,
        input.acceptedAt || input.accepted_at || (status === 'active' ? new Date().toISOString() : null),
        input.revokedAt || input.revoked_at || null,
        input.supersededAt || input.superseded_at || null,
        status,
        input.authority || 'verified_summary',
        input.assertionHash || input.assertion_hash,
        input.supersededBy || input.superseded_by || null,
        input.versionId || input.version_id || null,
        toJson(input.metadata, {}),
        input.createdByFinalizationId || input.created_by_finalization_id || null,
        input.createdByCompactionRunId || input.created_by_compaction_run_id || null,
      ]
    );
    return result.rows[0] || null;
  }

  async function linkEvidence(input = {}) {
    requireField(input, 'ownerKind');
    requireField(input, 'ownerId');
    requireField(input, 'sourceKind');
    requireField(input, 'sourceRef');
    const tenantId = input.tenantId || defaultTenantId;
    const result = await pool.query(
      `INSERT INTO ${evidenceRefs} (
         tenant_id, owner_kind, owner_id, source_kind, source_ref,
         relation_kind, weight, metadata, created_by_finalization_id,
         created_by_compaction_run_id
       )
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'supporting'),COALESCE($7,1.0),COALESCE($8::jsonb,'{}'::jsonb),$9,$10)
       ON CONFLICT (tenant_id, owner_kind, owner_id, source_kind, source_ref, relation_kind)
       DO UPDATE SET weight = EXCLUDED.weight,
                     metadata = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${evidenceRefs}.metadata),
                     created_by_finalization_id = COALESCE(${evidenceRefs}.created_by_finalization_id, EXCLUDED.created_by_finalization_id),
                     created_by_compaction_run_id = COALESCE(${evidenceRefs}.created_by_compaction_run_id, EXCLUDED.created_by_compaction_run_id)
       RETURNING *`,
      [
        tenantId,
        input.ownerKind,
        input.ownerId,
        input.sourceKind,
        input.sourceRef,
        input.relationKind || 'supporting',
        input.weight ?? 1.0,
        toJson(input.metadata, {}),
        input.createdByFinalizationId || input.created_by_finalization_id || null,
        input.createdByCompactionRunId || input.created_by_compaction_run_id || null,
      ]
    );
    return result.rows[0] || null;
  }

  async function recordFeedback(input = {}) {
    requireField(input, 'targetKind');
    requireField(input, 'targetId');
    requireField(input, 'feedbackType');
    const tenantId = input.tenantId || defaultTenantId;
    const result = await pool.query(
      `INSERT INTO ${feedback} (
         tenant_id, target_kind, target_id, feedback_type, actor_kind, actor_id,
         query_fingerprint, note, metadata
       )
       VALUES ($1,$2,$3,$4,COALESCE($5,'user'),$6,$7,$8,COALESCE($9::jsonb,'{}'::jsonb))
       RETURNING *`,
      [
        tenantId,
        input.targetKind,
        String(input.targetId),
        input.feedbackType,
        input.actorKind || 'user',
        input.actorId || null,
        input.queryFingerprint || null,
        input.note || null,
        toJson(input.metadata, {}),
      ]
    );
    return result.rows[0] || null;
  }

  async function findActiveByCanonicalKey(input = {}) {
    requireField(input, 'canonicalKey');
    const tenantId = input.tenantId || defaultTenantId;
    const lockClause = input.forUpdate === true ? 'FOR UPDATE OF m' : '';
    const result = await pool.query(
      `SELECT m.*, s.scope_kind, s.scope_key, s.inheritance_mode AS scope_inheritance_mode
       FROM ${memories} m
       JOIN ${scopes} s ON s.id = m.scope_id
       WHERE m.tenant_id = $1
         AND m.canonical_key = $2
         AND m.status = 'active'
       ORDER BY m.accepted_at DESC NULLS LAST, m.id ASC
       ${lockClause}`,
      [tenantId, input.canonicalKey]
    );
    return result.rows;
  }

  async function findActiveFactByCanonicalKey(input = {}) {
    requireField(input, 'canonicalKey');
    const tenantId = input.tenantId || defaultTenantId;
    const lockClause = input.forUpdate === true ? 'FOR UPDATE OF f' : '';
    const result = await pool.query(
      `SELECT f.*, s.scope_kind, s.scope_key, s.inheritance_mode AS scope_inheritance_mode
       FROM ${factAssertions} f
       JOIN ${scopes} s ON s.id = f.scope_id
       WHERE f.tenant_id = $1
         AND f.canonical_key = $2
         AND f.status = 'active'
       ORDER BY f.accepted_at DESC NULLS LAST, f.id ASC
       ${lockClause}`,
      [tenantId, input.canonicalKey]
    );
    return result.rows;
  }

  async function lockCanonicalKey(input = {}) {
    requireField(input, 'canonicalKey');
    const tenantId = input.tenantId || defaultTenantId;
    const [key1, key2] = advisoryLockKeys(
      'aquifer.memory_records.active_canonical',
      `${tenantId}:${input.canonicalKey}`,
    );
    await pool.query('SELECT pg_advisory_xact_lock($1, $2)', [key1, key2]);
  }

  async function updateMemoryStatus(input = {}) {
    requireField(input, 'memoryId');
    requireField(input, 'status');
    const tenantId = input.tenantId || defaultTenantId;
    const visibleBootstrap = input.status === 'active' ? input.visibleInBootstrap === true : false;
    const visibleRecall = input.status === 'active' ? input.visibleInRecall === true : false;
    const result = await pool.query(
      `UPDATE ${memories}
       SET status = $3,
           superseded_by = COALESCE($4, superseded_by),
           valid_to = COALESCE($5, valid_to),
           superseded_at = CASE
             WHEN $3 = 'superseded' THEN COALESCE($8, superseded_at, now())
             ELSE superseded_at
           END,
           revoked_at = CASE
             WHEN $3 = 'revoked' THEN COALESCE($9, revoked_at, now())
             ELSE revoked_at
           END,
           visible_in_bootstrap = $6,
           visible_in_recall = $7,
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        input.memoryId,
        input.status,
        input.supersededBy || null,
        input.validTo || null,
        visibleBootstrap,
        visibleRecall,
        input.supersededAt || input.superseded_at || null,
        input.revokedAt || input.revoked_at || null,
      ]
    );
    return result.rows[0] || null;
  }

  async function updateMemoryStatusIfCurrent(input = {}) {
    requireField(input, 'memoryId');
    requireField(input, 'fromStatus');
    requireField(input, 'status');
    const tenantId = input.tenantId || defaultTenantId;
    const visibleBootstrap = input.status === 'active' ? input.visibleInBootstrap === true : false;
    const visibleRecall = input.status === 'active' ? input.visibleInRecall === true : false;
    const result = await pool.query(
      `UPDATE ${memories}
       SET status = $4,
           superseded_by = COALESCE($5, superseded_by),
           valid_to = COALESCE($6, valid_to),
           superseded_at = CASE
             WHEN $4 = 'superseded' THEN COALESCE($9, superseded_at, now())
             ELSE superseded_at
           END,
           revoked_at = CASE
             WHEN $4 = 'revoked' THEN COALESCE($10, revoked_at, now())
             ELSE revoked_at
           END,
           visible_in_bootstrap = $7,
           visible_in_recall = $8,
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = $3
       RETURNING *`,
      [
        tenantId,
        input.memoryId,
        input.fromStatus,
        input.status,
        input.supersededBy || null,
        input.validTo || null,
        visibleBootstrap,
        visibleRecall,
        input.supersededAt || input.superseded_at || null,
        input.revokedAt || input.revoked_at || null,
      ]
    );
    return result.rows[0] || null;
  }

  async function updateFactAssertionStatus(input = {}) {
    requireField(input, 'factId');
    requireField(input, 'status');
    const tenantId = input.tenantId || defaultTenantId;
    const result = await pool.query(
      `UPDATE ${factAssertions}
       SET status = $3,
           superseded_by = COALESCE($4, superseded_by),
           valid_to = COALESCE($5, valid_to),
           superseded_at = CASE
             WHEN $3 = 'superseded' THEN COALESCE($6, superseded_at, now())
             ELSE superseded_at
           END,
           revoked_at = CASE
             WHEN $3 = 'revoked' THEN COALESCE($7, revoked_at, now())
             ELSE revoked_at
           END,
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        input.factId,
        input.status,
        input.supersededBy || input.superseded_by || null,
        input.validTo || input.valid_to || null,
        input.supersededAt || input.superseded_at || null,
        input.revokedAt || input.revoked_at || null,
      ]
    );
    return result.rows[0] || null;
  }

  async function listActive(input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    const params = [tenantId];
    const where = [`m.tenant_id = $1`, `m.status = 'active'`];
    if (input.asOf) {
      params.push(input.asOf);
      const at = `$${params.length}::timestamptz`;
      where.push(`(m.valid_from IS NULL OR m.valid_from <= ${at})`);
      where.push(`(m.valid_to IS NULL OR m.valid_to > ${at})`);
      where.push(`(m.stale_after IS NULL OR m.stale_after > ${at})`);
    }
    if (input.scopeId) {
      params.push(input.scopeId);
      where.push(`m.scope_id = $${params.length}`);
    }
    if (Array.isArray(input.scopeKeys) && input.scopeKeys.length > 0) {
      params.push(input.scopeKeys.map(value => String(value)));
      where.push(`s.scope_key = ANY($${params.length}::text[])`);
    }
    if (input.visibleInBootstrap !== undefined) {
      params.push(input.visibleInBootstrap === true);
      where.push(`m.visible_in_bootstrap = $${params.length}`);
    }
    if (input.visibleInRecall !== undefined) {
      params.push(input.visibleInRecall === true);
      where.push(`m.visible_in_recall = $${params.length}`);
    }
    params.push(Math.max(1, Math.min(200, input.limit || 50)));
    const orderBy = input.visibleInBootstrap === true
      ? BOOTSTRAP_ORDER_SQL
      : `m.accepted_at DESC NULLS LAST, m.id ASC`;
    const result = await pool.query(
      `SELECT m.*, s.scope_kind, s.scope_key, s.inheritance_mode AS scope_inheritance_mode
       FROM ${memories} m
       JOIN ${scopes} s ON s.id = m.scope_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${params.length}`,
      params
    );
    return result.rows;
  }

  async function withTransaction(fn) {
    if (inTransaction) {
      return fn(api, { transactional: true });
    }

    if (!canTransact) {
      return fn(api, { transactional: false });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txRecords = createMemoryRecords({ pool: client, schema, defaultTenantId, inTransaction: true });
      const result = await fn(txRecords, { transactional: true });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  const api = {
    upsertScope,
    createVersion,
    upsertMemory,
    upsertFactAssertion,
    linkEvidence,
    recordFeedback,
    findActiveByCanonicalKey,
    findActiveFactByCanonicalKey,
    lockCanonicalKey,
    updateMemoryStatus,
    updateMemoryStatusIfCurrent,
    updateFactAssertionStatus,
    listActive,
    withTransaction,
  };

  return api;
}

module.exports = { createMemoryRecords };
