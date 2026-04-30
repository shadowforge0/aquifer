'use strict';

const crypto = require('crypto');
const { resolveApplicableRecords } = require('./memory-bootstrap');

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

function vecToStr(vec) {
  if (!vec || !Array.isArray(vec) || vec.length === 0) return null;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) throw new Error(`Vector contains non-finite value at index ${i}`);
  }
  return `[${vec.join(',')}]`;
}

function advisoryLockKeys(namespace, value) {
  const digest = crypto.createHash('sha256').update(`${namespace}:${value}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

const BOOTSTRAP_ORDER_SQL = `
         CASE m.memory_type
           WHEN 'constraint' THEN 0
           WHEN 'state' THEN 1
           WHEN 'open_loop' THEN 2
           WHEN 'decision' THEN 3
           WHEN 'preference' THEN 4
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

const CURRENT_TYPE_PRIORITY = {
  constraint: 0,
  state: 1,
  open_loop: 2,
  decision: 3,
  preference: 4,
  fact: 5,
  conclusion: 6,
  entity_note: 7,
};

const CURRENT_AUTHORITY_PRIORITY = {
  user_explicit: 0,
  executable_evidence: 1,
  manual: 2,
  system: 3,
  verified_summary: 4,
  llm_inference: 5,
  raw_transcript: 6,
};

function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeScopePath(activeScopePath, activeScopeKey) {
  const source = Array.isArray(activeScopePath)
    ? activeScopePath
    : (typeof activeScopePath === 'string' ? activeScopePath.split(',') : null);
  if (source && source.length > 0) {
    const seen = new Set();
    const path = [];
    for (const value of source) {
      const key = String(value || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      path.push(key);
    }
    if (path.length > 0) return path;
  }
  if (activeScopeKey) return [String(activeScopeKey).trim()].filter(Boolean);
  return ['global'];
}

function compareRecordIdAsc(a, b) {
  const left = a.memoryId ?? a.memory_id ?? a.id ?? null;
  const right = b.memoryId ?? b.memory_id ?? b.id ?? null;
  const leftNum = Number(left);
  const rightNum = Number(right);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
    return leftNum - rightNum;
  }
  return String(left ?? '').localeCompare(String(right ?? ''));
}

function normalizeCurrentMemoryRow(row = {}) {
  const { embedding: _embedding, ...publicRow } = row;
  void _embedding;
  const memoryId = row.memoryId ?? row.memory_id ?? row.id ?? null;
  const evidenceRefsValue = row.evidenceRefs ?? row.evidence_refs ?? [];
  const evidenceRefs = Array.isArray(evidenceRefsValue) ? evidenceRefsValue : [];
  return {
    ...publicRow,
    memoryId: memoryId === null ? null : String(memoryId),
    canonicalKey: row.canonicalKey ?? row.canonical_key ?? null,
    memoryType: row.memoryType ?? row.memory_type ?? null,
    scopeKey: row.scopeKey ?? row.scope_key ?? null,
    scopeKind: row.scopeKind ?? row.scope_kind ?? null,
    inheritanceMode: row.inheritanceMode ?? row.inheritance_mode ?? row.scope_inheritance_mode ?? null,
    visibleInBootstrap: row.visibleInBootstrap ?? row.visible_in_bootstrap ?? false,
    visibleInRecall: row.visibleInRecall ?? row.visible_in_recall ?? false,
    acceptedAt: row.acceptedAt ?? row.accepted_at ?? null,
    validFrom: row.validFrom ?? row.valid_from ?? null,
    validTo: row.validTo ?? row.valid_to ?? null,
    staleAfter: row.staleAfter ?? row.stale_after ?? null,
    evidenceRefs,
    evidence_refs: evidenceRefs,
  };
}

function currentScopePriority(record, positions) {
  return positions.get(record.scopeKey ?? record.scope_key) ?? -1;
}

function sortCurrentMemoryRecords(a, b, positions) {
  const leftScope = currentScopePriority(a, positions);
  const rightScope = currentScopePriority(b, positions);
  if (rightScope !== leftScope) return rightScope - leftScope;

  const leftType = CURRENT_TYPE_PRIORITY[a.memoryType ?? a.memory_type] ?? 99;
  const rightType = CURRENT_TYPE_PRIORITY[b.memoryType ?? b.memory_type] ?? 99;
  if (leftType !== rightType) return leftType - rightType;

  const leftAuthority = CURRENT_AUTHORITY_PRIORITY[a.authority] ?? 99;
  const rightAuthority = CURRENT_AUTHORITY_PRIORITY[b.authority] ?? 99;
  if (leftAuthority !== rightAuthority) return leftAuthority - rightAuthority;

  const leftAccepted = parseTime(a.acceptedAt ?? a.accepted_at);
  const rightAccepted = parseTime(b.acceptedAt ?? b.accepted_at);
  if (leftAccepted !== rightAccepted) return (rightAccepted ?? 0) - (leftAccepted ?? 0);

  return compareRecordIdAsc(a, b);
}

function isCurrentProjectionRow(row, asOf) {
  if ((row.status || 'candidate') !== 'active') return false;
  if (row.visibleInBootstrap !== true && row.visibleInRecall !== true) return false;
  const at = parseTime(asOf);
  if (at === null) return true;
  const validFrom = parseTime(row.validFrom ?? row.valid_from);
  const validTo = parseTime(row.validTo ?? row.valid_to);
  const staleAfter = parseTime(row.staleAfter ?? row.stale_after);
  if (validFrom !== null && validFrom > at) return false;
  if (validTo !== null && validTo <= at) return false;
  if (staleAfter !== null && staleAfter <= at) return false;
  return true;
}

function createMemoryRecords({ pool, schema, defaultTenantId, inTransaction = false }) {
  const scopes = `${schema}.scopes`;
  const versions = `${schema}.versions`;
  const memories = `${schema}.memory_records`;
  const factAssertions = `${schema}.fact_assertions_v1`;
  const evidenceRefs = `${schema}.evidence_refs`;
  const evidenceItems = `${schema}.evidence_items`;
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
         created_by_compaction_run_id, embedding
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,COALESCE($8,''),COALESCE($9::jsonb,'{}'::jsonb),
         COALESCE($10,'candidate'),COALESCE($11,'llm_inference'),$12,$13,$14,$15,
         $16,$17,$18,$19,$20,$21,COALESCE($22,false),COALESCE($23,false),COALESCE($24::jsonb,'{}'::jsonb),$25,$26,$27::vector
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
         created_by_compaction_run_id = COALESCE(${memories}.created_by_compaction_run_id, EXCLUDED.created_by_compaction_run_id),
         embedding = COALESCE(EXCLUDED.embedding, ${memories}.embedding)
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
        vecToStr(input.embedding),
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
    const evidenceItemId = input.evidenceItemId || input.evidence_item_id || null;
    const conflictTarget = evidenceItemId
      ? `(tenant_id, owner_kind, owner_id, evidence_item_id, relation_kind)
         WHERE evidence_item_id IS NOT NULL`
      : `(tenant_id, owner_kind, owner_id, source_kind, source_ref, relation_kind)
         WHERE evidence_item_id IS NULL`;
    const result = await pool.query(
      `INSERT INTO ${evidenceRefs} (
         tenant_id, owner_kind, owner_id, source_kind, source_ref,
         relation_kind, weight, metadata, created_by_finalization_id,
         created_by_compaction_run_id, evidence_item_id
       )
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'supporting'),COALESCE($7,1.0),COALESCE($8::jsonb,'{}'::jsonb),$9,$10,$11)
       ON CONFLICT ${conflictTarget}
       DO UPDATE SET weight = EXCLUDED.weight,
                     source_kind = EXCLUDED.source_kind,
                     source_ref = EXCLUDED.source_ref,
                     metadata = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${evidenceRefs}.metadata),
                     created_by_finalization_id = COALESCE(${evidenceRefs}.created_by_finalization_id, EXCLUDED.created_by_finalization_id),
                     created_by_compaction_run_id = COALESCE(${evidenceRefs}.created_by_compaction_run_id, EXCLUDED.created_by_compaction_run_id),
                     evidence_item_id = COALESCE(${evidenceRefs}.evidence_item_id, EXCLUDED.evidence_item_id)
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
        evidenceItemId,
      ]
    );
    return result.rows[0] || null;
  }

  async function upsertEvidenceItem(input = {}) {
    requireField(input, 'sourceKind');
    requireField(input, 'sourceRef');
    requireField(input, 'excerptText');
    const tenantId = input.tenantId || defaultTenantId;
    const excerptText = String(input.excerptText || input.excerpt_text || '').trim();
    const excerptHash = input.excerptHash || input.excerpt_hash || crypto
      .createHash('sha256')
      .update(excerptText)
      .digest('hex');
    const result = await pool.query(
      `INSERT INTO ${evidenceItems} (
         tenant_id, source_kind, source_ref, session_row_id, turn_embedding_id,
         summary_row_id, created_by_finalization_id, excerpt_text, excerpt_hash,
         embedding, metadata
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,COALESCE($11::jsonb,'{}'::jsonb))
       ON CONFLICT (tenant_id, source_kind, source_ref, excerpt_hash)
       DO UPDATE SET
         session_row_id = COALESCE(${evidenceItems}.session_row_id, EXCLUDED.session_row_id),
         turn_embedding_id = COALESCE(${evidenceItems}.turn_embedding_id, EXCLUDED.turn_embedding_id),
         summary_row_id = COALESCE(${evidenceItems}.summary_row_id, EXCLUDED.summary_row_id),
         created_by_finalization_id = COALESCE(${evidenceItems}.created_by_finalization_id, EXCLUDED.created_by_finalization_id),
         embedding = COALESCE(${evidenceItems}.embedding, EXCLUDED.embedding),
         metadata = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${evidenceItems}.metadata)
       RETURNING *`,
      [
        tenantId,
        input.sourceKind || input.source_kind,
        input.sourceRef || input.source_ref,
        input.sessionRowId || input.session_row_id || null,
        input.turnEmbeddingId || input.turn_embedding_id || null,
        input.summaryRowId || input.summary_row_id || null,
        input.createdByFinalizationId || input.created_by_finalization_id || null,
        excerptText,
        excerptHash,
        vecToStr(input.embedding),
        toJson(input.metadata, {}),
      ],
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
    if (input.withoutEmbedding === true) {
      where.push(`m.embedding IS NULL`);
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

  async function updateMemoryEmbedding(input = {}) {
    requireField(input, 'memoryId');
    const tenantId = input.tenantId || defaultTenantId;
    const embedding = vecToStr(input.embedding);
    if (!embedding) throw new Error('embedding is required');
    const result = await pool.query(
      `UPDATE ${memories}
       SET embedding = $3::vector,
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2
         AND embedding IS NULL
       RETURNING *`,
      [
        tenantId,
        input.memoryId,
        embedding,
      ]
    );
    if (result.rows[0]) {
      return {
        status: 'updated',
        updated: true,
        skipped: false,
        memory: result.rows[0],
      };
    }
    const existing = await pool.query(
      `SELECT * FROM ${memories}
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [tenantId, input.memoryId]
    );
    if (existing.rows[0]) {
      return {
        status: 'skipped_existing_embedding',
        updated: false,
        skipped: true,
        memory: existing.rows[0],
      };
    }
    return {
      status: 'missing',
      updated: false,
      skipped: true,
      memory: null,
    };
  }

  async function currentProjection(input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    let activeScopePath = normalizeScopePath(input.activeScopePath, input.activeScopeKey);
    let activeScopeKey = input.activeScopeKey || activeScopePath[activeScopePath.length - 1] || null;
    if (input.scopeId && !input.activeScopeKey && !input.activeScopePath) {
      const scopeResult = await pool.query(
        `SELECT scope_key FROM ${scopes} WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, input.scopeId],
      );
      const scopedKey = scopeResult.rows[0]?.scope_key || null;
      if (scopedKey) {
        activeScopePath = [scopedKey];
        activeScopeKey = scopedKey;
      }
    }
    const limit = Math.max(1, Math.min(100, input.limit || 50));
    const fetchLimit = Math.max(limit + 1, Math.min(200, Math.max(limit * 4, 40)));
    const asOf = input.asOf || new Date().toISOString();
    const params = [tenantId, activeScopePath, asOf];
    const where = [
      `m.tenant_id = $1`,
      `m.status = 'active'`,
      `s.scope_key = ANY($2::text[])`,
      `(m.visible_in_bootstrap = true OR m.visible_in_recall = true)`,
      `(m.valid_from IS NULL OR m.valid_from <= $3::timestamptz)`,
      `(m.valid_to IS NULL OR m.valid_to > $3::timestamptz)`,
      `(m.stale_after IS NULL OR m.stale_after > $3::timestamptz)`,
    ];

    if (input.scopeId) {
      params.push(input.scopeId);
      where.push(`m.scope_id = $${params.length}`);
    }

    params.push(fetchLimit);
    const limitParam = `$${params.length}`;
    const evidenceRefsSelect = input.includeEvidenceRefs === true
      ? `COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'id', e.id,
               'sourceKind', e.source_kind,
               'sourceRef', e.source_ref,
               'relationKind', e.relation_kind,
               'weight', e.weight,
               'metadata', e.metadata
             )
             ORDER BY e.id ASC
           )
           FROM ${evidenceRefs} e
           WHERE e.tenant_id = m.tenant_id
             AND e.owner_kind = 'memory_record'
             AND e.owner_id = m.id
         ), '[]'::jsonb)`
      : `'[]'::jsonb`;

    const result = await pool.query(
      `SELECT
         m.*,
         s.scope_kind,
         s.scope_key,
         s.inheritance_mode AS scope_inheritance_mode,
         ${evidenceRefsSelect} AS evidence_refs
       FROM ${memories} m
       JOIN ${scopes} s ON s.id = m.scope_id
       WHERE ${where.join(' AND ')}
       ORDER BY array_position($2::text[], s.scope_key) DESC NULLS LAST,
                ${BOOTSTRAP_ORDER_SQL}
       LIMIT ${limitParam}`,
      params,
    );

    const positions = new Map(activeScopePath.map((key, index) => [key, index]));
    const applicable = resolveApplicableRecords(
      result.rows
        .map(normalizeCurrentMemoryRow)
        .filter(row => isCurrentProjectionRow(row, asOf)),
      { activeScopeKey, activeScopePath },
    ).sort((left, right) => sortCurrentMemoryRecords(left, right, positions));

    const selected = applicable.slice(0, limit);
    const truncated = applicable.length > limit;
    return {
      memories: selected,
      meta: {
        source: 'memory_records',
        servingContract: 'current_memory_v1',
        count: selected.length,
        activeScopeKey,
        activeScopePath,
        asOf,
        truncated,
        degraded: truncated,
      },
    };
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
    upsertEvidenceItem,
    linkEvidence,
    recordFeedback,
    findActiveByCanonicalKey,
    findActiveFactByCanonicalKey,
    lockCanonicalKey,
    updateMemoryStatus,
    updateMemoryStatusIfCurrent,
    updateMemoryEmbedding,
    updateFactAssertionStatus,
    listActive,
    currentProjection,
    normalizeCurrentMemoryRow,
    withTransaction,
  };

  return api;
}

module.exports = { createMemoryRecords };
