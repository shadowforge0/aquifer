'use strict';

const crypto = require('crypto');

const ACTIVE_V1_TYPES = new Set([
  'fact',
  'state',
  'decision',
  'preference',
  'constraint',
  'entity_note',
  'open_loop',
  'conclusion',
]);

const AUTHORITY_RANK = {
  raw_transcript: 0,
  llm_inference: 1,
  verified_summary: 2,
  manual: 3,
  system: 4,
  executable_evidence: 5,
  user_explicit: 6,
};

const DEFAULT_INHERITANCE = {
  constraint: 'additive',
  preference: 'defaultable',
  state: 'defaultable',
  fact: 'defaultable',
  conclusion: 'defaultable',
  entity_note: 'defaultable',
  decision: 'non_inheritable',
  open_loop: 'non_inheritable',
};

const DEFAULT_ASPECT = {
  fact: 'fact',
  state: 'state',
  decision: 'decision',
  preference: 'preference',
  constraint: 'constraint',
  entity_note: 'entity_note',
  open_loop: 'open_loop',
  conclusion: 'conclusion',
};

const FORBIDDEN_TAGS = new Set([
  'commentary',
  'tool_narration',
  'failed_hypothesis',
  'wrapper_metadata',
  'session_injected_context',
  'rendered_artifact',
  'stack_trace',
  'secret',
  'secret_risk',
  'tool_output',
  'env_dump',
]);

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeType(value) {
  return normalizeText(value).toLowerCase();
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || '').trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

function stableJson(value) {
  if (value === null || value === undefined) return JSON.stringify(null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertionHash(value) {
  return crypto
    .createHash('sha256')
    .update(stableJson(value))
    .digest('hex');
}

function defaultInheritanceForType(memoryType) {
  return DEFAULT_INHERITANCE[normalizeType(memoryType)] || 'defaultable';
}

function authorityRank(authority) {
  return AUTHORITY_RANK[String(authority || 'llm_inference').toLowerCase()] ?? 0;
}

function buildCanonicalKey({ memoryType, scopeKey, contextKey, topicKey, subject, aspect }) {
  const type = normalizeType(memoryType || 'memory');
  const scope = normalizeType(scopeKey || 'unspecified');
  const context = normalizeType(contextKey || '');
  const topic = normalizeType(topicKey || '');
  const scopePart = [scope, context, topic].filter(Boolean).join('|');
  const subj = normalizeType(subject || 'session');
  const asp = normalizeType(aspect || DEFAULT_ASPECT[type] || type);
  return [type, scopePart, subj, asp].join(':');
}

function textFromItem(item, keys) {
  if (typeof item === 'string') return normalizeText(item);
  for (const key of keys) {
    const text = normalizeText(item && item[key]);
    if (text) return text;
  }
  return '';
}

function normalizeEvidenceRefs(candidate = {}) {
  return candidate.evidenceRefs || candidate.evidence_refs || [];
}

function normalizeEvidenceTexts(candidate = {}) {
  const raw = candidate.evidenceItems || candidate.evidence_items || candidate.evidenceTexts || candidate.evidence_texts;
  const values = Array.isArray(raw) ? raw : [];
  const direct = [
    candidate.evidenceText,
    candidate.evidence_text,
    candidate.evidenceExcerpt,
    candidate.evidence_excerpt,
    candidate.sourceText,
    candidate.source_text,
    candidate.quote,
  ];
  for (const value of direct) {
    if (value) values.push(value);
  }
  return values
    .map(value => {
      if (typeof value === 'string') return { excerptText: normalizeText(value), metadata: {} };
      if (!value || typeof value !== 'object') return null;
      const excerptText = normalizeText(value.excerptText || value.excerpt_text || value.text || value.quote || value.summary);
      if (!excerptText) return null;
      return {
        ...value,
        excerptText,
        metadata: value.metadata || {},
      };
    })
    .filter(value => value && value.excerptText);
}

function buildMemoryEmbeddingText(candidate = {}) {
  const fields = [
    ['title', candidate.title],
    ['summary', candidate.summary],
    ['context', candidate.contextKey || candidate.context_key],
    ['topic', candidate.topicKey || candidate.topic_key],
  ]
    .map(([label, value]) => {
      const text = normalizeText(value);
      return text ? `${label}: ${text}` : '';
    })
    .filter(Boolean);
  return fields.join('\n');
}

function assignEmbeddedVectors(items, vectors, errorPrefix) {
  if (!Array.isArray(vectors) || vectors.length !== items.length) {
    throw new Error(`${errorPrefix} returned ${Array.isArray(vectors) ? vectors.length : 'invalid'} vectors for ${items.length} texts`);
  }
  for (let i = 0; i < items.length; i++) {
    const vector = vectors[i];
    if (Array.isArray(vector) && vector.length > 0) items[i].embedding = vector;
  }
}

function buildFactAssertion(candidate = {}, opts = {}) {
  const memoryType = normalizeType(candidate.memoryType || candidate.memory_type);
  if (memoryType !== 'fact') return null;

  const payload = candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : {};
  const subject = normalizeText(payload.subject || candidate.subject || 'session');
  const predicate = normalizeText(
    payload.predicate ||
    payload.aspect ||
    payload.attribute ||
    candidate.predicate ||
    candidate.aspect ||
    'fact',
  );
  const statement = normalizeText(
    payload.statement ||
    payload.fact ||
    payload.summary ||
    payload.text ||
    candidate.summary ||
    candidate.title,
  );
  if (!predicate || !statement) return null;

  const rawObjectKind = normalizeText(payload.object_kind || payload.objectKind || 'value') || 'value';
  const objectKind = ['entity', 'value', 'none'].includes(rawObjectKind) ? rawObjectKind : 'value';
  const objectEntityId = payload.object_entity_id || payload.objectEntityId || null;
  const objectValueJson = objectKind === 'none' || objectKind === 'entity'
    ? null
    : (payload.object_value_json !== undefined
        ? payload.object_value_json
        : {
            statement,
            subject,
          });
  const qualifiersJson = {
    subject,
    statement,
    ...(payload.qualifiers && typeof payload.qualifiers === 'object' ? payload.qualifiers : {}),
  };
  const acceptedAt = candidate.acceptedAt || opts.acceptedAt || new Date().toISOString();
  const observedAt = candidate.observedAt || candidate.observed_at || payload.observed_at || payload.observedAt || acceptedAt;
  const assertion = {
    tenantId: opts.tenantId,
    canonicalKey: candidate.canonicalKey || candidate.canonical_key,
    scopeId: opts.scopeId,
    subjectEntityId: payload.subject_entity_id || payload.subjectEntityId || candidate.subjectEntityId || null,
    predicate,
    objectKind,
    objectEntityId: objectKind === 'entity' ? objectEntityId : null,
    objectValueJson,
    qualifiersJson,
    validFrom: candidate.validFrom || candidate.valid_from || payload.valid_from || payload.validFrom || null,
    validTo: candidate.validTo || candidate.valid_to || payload.valid_to || payload.validTo || null,
    observedAt,
    staleAfter: candidate.staleAfter || candidate.stale_after || payload.stale_after || payload.staleAfter || null,
    acceptedAt,
    status: 'active',
    authority: candidate.authority || 'verified_summary',
    versionId: candidate.versionId || candidate.version_id || null,
    createdByFinalizationId: opts.createdByFinalizationId || opts.created_by_finalization_id || null,
    createdByCompactionRunId: opts.createdByCompactionRunId || opts.created_by_compaction_run_id || null,
    metadata: {
      source: 'memory_promotion',
      memoryType,
      createdByFinalizationId: opts.createdByFinalizationId || opts.created_by_finalization_id || null,
      createdByCompactionRunId: opts.createdByCompactionRunId || opts.created_by_compaction_run_id || null,
    },
  };
  assertion.assertionHash = assertionHash({
    canonicalKey: assertion.canonicalKey,
    predicate: assertion.predicate,
    objectKind: assertion.objectKind,
    objectEntityId: assertion.objectEntityId,
    objectValueJson: assertion.objectValueJson,
    qualifiersJson: assertion.qualifiersJson,
    validFrom: assertion.validFrom,
    validTo: assertion.validTo,
    observedAt: assertion.observedAt,
    authority: assertion.authority,
  });
  return assertion;
}

function sameClaim(a, b) {
  return normalizeText(a && (a.summary || a.title)).toLowerCase()
    === normalizeText(b && (b.summary || b.title)).toLowerCase();
}

function pushStructuredCandidates(candidates, items, spec) {
  for (const item of items) {
    const text = textFromItem(item, spec.keys);
    if (!text) continue;
    const itemObj = item && typeof item === 'object' ? item : null;
    const evidenceText = normalizeText(itemObj && (
      itemObj.evidenceText
      || itemObj.evidence_text
      || itemObj.evidenceExcerpt
      || itemObj.evidence_excerpt
      || itemObj.sourceText
      || itemObj.source_text
      || itemObj.quote
    ));
    const explicitSubject = normalizeText(itemObj && (itemObj.subject || itemObj.entity || itemObj.name));
    const explicitAspect = normalizeText(itemObj && (itemObj.aspect || itemObj.predicate || itemObj.attribute));
    const subject = explicitSubject || normalizeText(spec.subject);
    let aspect = explicitAspect || normalizeText(spec.aspect);
    if (!explicitAspect) aspect = `${aspect}:${stableHash(text)}`;
    candidates.push({
      memoryType: spec.memoryType,
      canonicalKey: buildCanonicalKey({
        memoryType: spec.memoryType,
        scopeKey: spec.scopeKey,
        contextKey: spec.contextKey,
        topicKey: spec.topicKey,
        subject,
        aspect,
      }),
      scopeKind: spec.scopeKind,
      scopeKey: spec.scopeKey,
      contextKey: spec.contextKey,
      topicKey: spec.topicKey,
      inheritanceMode: spec.inheritanceMode || defaultInheritanceForType(spec.memoryType),
      title: text.slice(0, 120),
      summary: text,
      payload: typeof item === 'string' ? { [spec.payloadKey]: text } : { ...item, [spec.payloadKey]: text },
      authority: spec.authority,
      evidenceRefs: spec.evidenceRefs,
      evidenceText: evidenceText || undefined,
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
  }
}

function extractCandidatesFromStructuredSummary(input = {}) {
  const structuredSummary = input.structuredSummary || {};
  const sessionId = input.sessionId || null;
  const scopeKey = input.scopeKey || (sessionId ? `session:${sessionId}` : 'global');
  const scopeKind = input.scopeKind || (sessionId ? 'session' : 'global');
  const subject = input.subject || 'session';
  const contextKey = input.contextKey || null;
  const topicKey = input.topicKey || null;
  const authority = input.authority || 'verified_summary';
  const evidenceRefs = input.evidenceRefs || (sessionId
    ? [{ sourceKind: 'session_summary', sourceRef: sessionId, relationKind: 'primary' }]
    : []);
  const candidates = [];

  const specs = [
    ['decision', ['decisions'], ['decision', 'summary', 'text'], 'decision', input.inheritanceMode || 'non_inheritable'],
    ['open_loop', ['open_loops'], ['item', 'summary', 'text'], 'item', input.inheritanceMode || 'non_inheritable'],
    ['fact', ['important_facts', 'facts'], ['statement', 'fact', 'summary', 'text'], 'statement'],
    ['preference', ['preferences'], ['preference', 'summary', 'text'], 'preference'],
    ['constraint', ['constraints'], ['constraint', 'summary', 'text'], 'constraint'],
    ['conclusion', ['conclusions'], ['conclusion', 'summary', 'text'], 'conclusion'],
    ['state', ['states', 'state'], ['state', 'summary', 'text', 'value'], 'state'],
    ['entity_note', ['entity_notes'], ['note', 'summary', 'text'], 'note'],
  ];

  for (const [memoryType, fieldNames, keys, payloadKey, inheritanceMode] of specs) {
    const items = fieldNames.flatMap(field => Array.isArray(structuredSummary[field]) ? structuredSummary[field] : []);
    const filtered = memoryType === 'open_loop'
      ? items.filter(item => {
          const text = textFromItem(item, keys);
          return text && !['none', 'n/a', 'na', 'done', '無'].includes(text.toLowerCase());
        })
      : items;
    pushStructuredCandidates(candidates, filtered, {
      memoryType,
      keys,
      payloadKey,
      scopeKind,
      scopeKey,
      contextKey,
      topicKey,
      subject,
      aspect: DEFAULT_ASPECT[memoryType],
      inheritanceMode,
      authority,
      evidenceRefs,
    });
  }

  return candidates;
}

function assessCandidate(candidate = {}, opts = {}) {
  const memoryType = normalizeType(candidate.memoryType || candidate.memory_type);
  const tags = new Set([
    ...(candidate.pollutionTags || []),
    ...(candidate.tags || []),
  ].map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean));

  for (const tag of tags) {
    if (FORBIDDEN_TAGS.has(tag)) {
      return { action: 'quarantine', reason: `forbidden_${tag}` };
    }
  }

  if (!ACTIVE_V1_TYPES.has(memoryType)) {
    return { action: 'quarantine', reason: 'unsupported_memory_type' };
  }

  const evidenceRefs = normalizeEvidenceRefs(candidate);
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    return { action: 'quarantine', reason: 'missing_provenance' };
  }

  const authority = String(candidate.authority || 'llm_inference').toLowerCase();
  if (authority === 'raw_transcript') {
    return { action: 'quarantine', reason: 'raw_transcript_not_authoritative' };
  }
  if (authorityRank(authority) < authorityRank('verified_summary')) {
    return { action: 'quarantine', reason: 'insufficient_authority' };
  }

  if (!candidate.scopeId && !candidate.scope_id && !(candidate.scopeKey || candidate.scope_key)) {
    return { action: 'quarantine', reason: 'missing_scope' };
  }

  const activeConflicts = opts.existingActiveRecords || [];
  for (const existing of activeConflicts) {
    if (sameClaim(candidate, existing)) continue;
    const incomingRank = authorityRank(authority);
    const existingRank = authorityRank(existing.authority);
    if (incomingRank < existingRank) {
      return { action: 'quarantine', reason: 'lower_authority_conflict', conflictWith: existing.id || existing.memory_id };
    }
    if (incomingRank === existingRank) {
      return { action: 'quarantine', reason: 'unresolved_active_conflict', conflictWith: existing.id || existing.memory_id };
    }
    return {
      action: 'promote',
      reason: 'higher_authority_supersedes',
      supersedeId: existing.id || existing.memory_id,
    };
  }

  return { action: 'promote', reason: 'v1_foundation_allowed' };
}

function createMemoryPromotion({ records, embedFn = null }) {
  async function prepareCandidates(candidates = []) {
    const prepared = candidates.map(candidate => ({ ...candidate }));
    if (typeof embedFn !== 'function' || prepared.length === 0) return prepared;

    const pendingMemoryRows = [];
    const memoryTexts = [];
    for (const candidate of prepared) {
      if (Array.isArray(candidate.embedding) && candidate.embedding.length > 0) continue;
      const text = buildMemoryEmbeddingText(candidate);
      if (!text) continue;
      pendingMemoryRows.push(candidate);
      memoryTexts.push(text);
    }
    if (memoryTexts.length > 0) {
      const vectors = await embedFn(memoryTexts);
      assignEmbeddedVectors(pendingMemoryRows, vectors, 'memory promotion embedFn');
    }

    const pendingEvidenceItems = [];
    const evidenceTexts = [];
    for (const candidate of prepared) {
      const normalizedEvidenceTexts = normalizeEvidenceTexts(candidate);
      candidate._preparedEvidenceTexts = normalizedEvidenceTexts;
      for (const item of normalizedEvidenceTexts) {
        if (Array.isArray(item.embedding) && item.embedding.length > 0) continue;
        if (!item.excerptText) continue;
        pendingEvidenceItems.push(item);
        evidenceTexts.push(item.excerptText);
      }
    }
    if (evidenceTexts.length > 0) {
      const vectors = await embedFn(evidenceTexts);
      assignEmbeddedVectors(pendingEvidenceItems, vectors, 'memory evidence embedFn');
    }

    return prepared;
  }

  async function promoteOne(candidate, opts = {}, candidateRecords = records, tx = {}) {
    if (tx.inTransaction && candidateRecords.lockCanonicalKey && candidate.canonicalKey) {
      await candidateRecords.lockCanonicalKey({
        tenantId: opts.tenantId,
        canonicalKey: candidate.canonicalKey,
      });
    }

    const existingActiveRecords = candidateRecords.findActiveByCanonicalKey && candidate.canonicalKey
      ? await candidateRecords.findActiveByCanonicalKey({
          tenantId: opts.tenantId,
          canonicalKey: candidate.canonicalKey,
          forUpdate: tx.inTransaction === true,
        })
      : [];
    const assessment = assessCandidate(candidate, { existingActiveRecords });
    if (assessment.action !== 'promote') {
      return { candidate, ...assessment };
    }

    if (assessment.supersedeId && candidateRecords.updateMemoryStatus) {
      await candidateRecords.updateMemoryStatus({
        tenantId: opts.tenantId,
        memoryId: assessment.supersedeId,
        status: 'superseded',
      });
    }

    const memoryType = normalizeType(candidate.memoryType || candidate.memory_type);
    const acceptedAt = candidate.acceptedAt || opts.acceptedAt || new Date().toISOString();
    const evidenceTexts = candidate._preparedEvidenceTexts || normalizeEvidenceTexts(candidate);
    let scopeId = candidate.scopeId || candidate.scope_id || null;
    if (!scopeId) {
      const scope = await candidateRecords.upsertScope({
        tenantId: opts.tenantId,
        scopeKind: candidate.scopeKind || candidate.scope_kind || 'session',
        scopeKey: candidate.scopeKey || candidate.scope_key,
        inheritanceMode: candidate.inheritanceMode || candidate.inheritance_mode || defaultInheritanceForType(memoryType),
        contextKey: candidate.contextKey || candidate.context_key || null,
        topicKey: candidate.topicKey || candidate.topic_key || null,
      });
      scopeId = scope.id;
    }

    async function linkCandidateEvidence(ownerKind, ownerId, ref) {
      const base = {
        tenantId: opts.tenantId,
        ownerKind,
        ownerId,
        sourceKind: ref.sourceKind || ref.source_kind,
        sourceRef: ref.sourceRef || ref.source_ref,
        relationKind: ref.relationKind || ref.relation_kind || 'supporting',
        weight: ref.weight ?? 1.0,
        metadata: ref.metadata || {},
        createdByFinalizationId: opts.createdByFinalizationId || opts.created_by_finalization_id || null,
        createdByCompactionRunId: opts.createdByCompactionRunId || opts.created_by_compaction_run_id || null,
      };

      if (!candidateRecords.upsertEvidenceItem || evidenceTexts.length === 0) {
        await candidateRecords.linkEvidence(base);
        return;
      }

      for (const item of evidenceTexts) {
        const evidenceItem = await candidateRecords.upsertEvidenceItem({
          tenantId: opts.tenantId,
          sourceKind: item.sourceKind || item.source_kind || base.sourceKind,
          sourceRef: item.sourceRef || item.source_ref || base.sourceRef,
          sessionRowId: item.sessionRowId || item.session_row_id || null,
          turnEmbeddingId: item.turnEmbeddingId || item.turn_embedding_id || null,
          summaryRowId: item.summaryRowId || item.summary_row_id || null,
          createdByFinalizationId: base.createdByFinalizationId,
          excerptText: item.excerptText,
          excerptHash: item.excerptHash || item.excerpt_hash || null,
          embedding: item.embedding || null,
          metadata: {
            ...(item.metadata || {}),
            memoryType,
            canonicalKey: candidate.canonicalKey,
          },
        });
        await candidateRecords.linkEvidence({
          ...base,
          sourceKind: item.sourceKind || item.source_kind || base.sourceKind,
          sourceRef: item.sourceRef || item.source_ref || base.sourceRef,
          evidenceItemId: evidenceItem ? evidenceItem.id : null,
        });
      }
    }

    let backingFact = null;
    const factAssertion = buildFactAssertion(candidate, {
      tenantId: opts.tenantId,
      scopeId,
      acceptedAt,
      createdByFinalizationId: opts.createdByFinalizationId || opts.created_by_finalization_id || null,
      createdByCompactionRunId: opts.createdByCompactionRunId || opts.created_by_compaction_run_id || null,
    });
    const supersededFacts = [];
    if (factAssertion && candidateRecords.upsertFactAssertion) {
      const existingFacts = candidateRecords.findActiveFactByCanonicalKey
        ? await candidateRecords.findActiveFactByCanonicalKey({
            tenantId: opts.tenantId,
            canonicalKey: candidate.canonicalKey,
            forUpdate: tx.inTransaction === true,
          })
        : [];

      for (const fact of existingFacts) {
        if (fact.assertion_hash === factAssertion.assertionHash) continue;
        if (!candidateRecords.updateFactAssertionStatus) continue;
        await candidateRecords.updateFactAssertionStatus({
          tenantId: opts.tenantId,
          factId: fact.id,
          status: 'superseded',
          validTo: factAssertion.validFrom || acceptedAt,
          supersededAt: acceptedAt,
        });
        supersededFacts.push(fact);
      }

      backingFact = await candidateRecords.upsertFactAssertion(factAssertion);

      for (const fact of supersededFacts) {
        await candidateRecords.updateFactAssertionStatus({
          tenantId: opts.tenantId,
          factId: fact.id,
          status: 'superseded',
          supersededBy: backingFact.id,
          validTo: factAssertion.validFrom || acceptedAt,
          supersededAt: acceptedAt,
        });
      }

      for (const ref of normalizeEvidenceRefs(candidate)) {
        await linkCandidateEvidence('fact', backingFact.id, ref);
      }
    }

    const memory = await candidateRecords.upsertMemory({
      tenantId: opts.tenantId,
      memoryType,
      canonicalKey: candidate.canonicalKey,
      scopeId,
      contextKey: candidate.contextKey || null,
      topicKey: candidate.topicKey || null,
      title: candidate.title || null,
      summary: candidate.summary || '',
      payload: candidate.payload || {},
      status: 'active',
      authority: candidate.authority || 'verified_summary',
      acceptedAt,
      validFrom: candidate.validFrom || null,
      validTo: candidate.validTo || null,
      staleAfter: candidate.staleAfter || null,
      backingFactId: backingFact ? backingFact.id : null,
      observedAt: factAssertion ? factAssertion.observedAt : (candidate.observedAt || candidate.observed_at || null),
      createdByFinalizationId: opts.createdByFinalizationId || opts.created_by_finalization_id || null,
      createdByCompactionRunId: opts.createdByCompactionRunId || opts.created_by_compaction_run_id || null,
      visibleInBootstrap: candidate.visibleInBootstrap !== false,
      visibleInRecall: candidate.visibleInRecall !== false,
      rankFeatures: candidate.rankFeatures || {},
      embedding: candidate.embedding || null,
    });

    if (assessment.supersedeId && candidateRecords.updateMemoryStatus) {
      await candidateRecords.updateMemoryStatus({
        tenantId: opts.tenantId,
        memoryId: assessment.supersedeId,
        status: 'superseded',
        supersededBy: memory.id,
        validTo: candidate.validFrom || acceptedAt,
      });
    }

    for (const ref of normalizeEvidenceRefs(candidate)) {
      await linkCandidateEvidence('memory_record', memory.id, ref);
    }

    return { candidate, action: 'promote', reason: assessment.reason, memory, backingFact };
  }

  async function promote(candidates = [], opts = {}) {
    const preparedCandidates = await prepareCandidates(candidates);
    const results = [];
    for (const candidate of preparedCandidates) {
      const result = records.withTransaction
        ? await records.withTransaction((txRecords, meta = {}) => promoteOne(candidate, opts, txRecords, {
            inTransaction: meta.transactional !== false,
          }))
        : await promoteOne(candidate, opts, records, { inTransaction: false });
      results.push(result);
    }
    return results;
  }

  return {
    extractCandidates: extractCandidatesFromStructuredSummary,
    assessCandidate,
    promote,
  };
}

module.exports = {
  ACTIVE_V1_TYPES,
  FORBIDDEN_TAGS,
  AUTHORITY_RANK,
  defaultInheritanceForType,
  buildCanonicalKey,
  buildMemoryEmbeddingText,
  extractCandidatesFromStructuredSummary,
  assessCandidate,
  createMemoryPromotion,
};
