'use strict';

const crypto = require('crypto');
const storage = require('./storage');
const { createMemoryRecords } = require('./memory-records');
const { createMemoryPromotion } = require('./memory-promotion');
const { sanitizeSummaryResult } = require('./memory-safety-gate');
const { buildFinalizationReview, buildSessionStartContext } = require('./finalization-review');

function qi(identifier) { return `"${identifier}"`; }

function requireField(obj, field) {
  if (!obj || obj[field] === undefined || obj[field] === null || obj[field] === '') {
    throw new Error(`${field} is required`);
  }
}

function hasStructuredContent(value) {
  return value && typeof value === 'object' && Object.keys(value).length > 0;
}

const TERMINAL_SUPPRESSION_STATUSES = new Set(['skipped', 'declined', 'deferred']);

function countByReason(results) {
  const reasons = {};
  for (const result of results || []) {
    const reason = result && result.reason ? result.reason : 'unknown';
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return reasons;
}

function summarizeMemoryResults(results = [], extra = {}) {
  return {
    candidates: results.length,
    promoted: results.filter(result => result.action === 'promote').length,
    quarantined: results.filter(result => result.action === 'quarantine').length,
    skipped: results.filter(result => result.action && !['promote', 'quarantine'].includes(result.action)).length,
    reasons: countByReason(results),
    ...extra,
  };
}

function stableJson(value) {
  if (value === null || value === undefined) return JSON.stringify(null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashStable(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function publicCandidateEnvelopeRow(candidate = {}, index = 0) {
  const rest = { ...(candidate || {}) };
  delete rest.embedding;
  delete rest._preparedEvidenceTexts;
  return {
    index,
    memoryType: rest.memoryType || rest.memory_type || null,
    canonicalKey: rest.canonicalKey || rest.canonical_key || null,
    scopeKind: rest.scopeKind || rest.scope_kind || null,
    scopeKey: rest.scopeKey || rest.scope_key || null,
    contextKey: rest.contextKey || rest.context_key || null,
    topicKey: rest.topicKey || rest.topic_key || null,
    inheritanceMode: rest.inheritanceMode || rest.inheritance_mode || null,
    authority: rest.authority || null,
    title: rest.title || null,
    summary: rest.summary || null,
    payload: rest.payload || {},
    visibleInBootstrap: rest.visibleInBootstrap === true || rest.visible_in_bootstrap === true,
    visibleInRecall: rest.visibleInRecall === true || rest.visible_in_recall === true,
    evidenceRefs: Array.isArray(rest.evidenceRefs || rest.evidence_refs)
      ? (rest.evidenceRefs || rest.evidence_refs)
      : [],
    validFrom: rest.validFrom || rest.valid_from || null,
    validTo: rest.validTo || rest.valid_to || null,
    staleAfter: rest.staleAfter || rest.stale_after || null,
    candidateHash: hashStable({
      memoryType: rest.memoryType || rest.memory_type || null,
      canonicalKey: rest.canonicalKey || rest.canonical_key || null,
      summary: rest.summary || null,
      payload: rest.payload || {},
      evidenceRefs: rest.evidenceRefs || rest.evidence_refs || [],
    }),
  };
}

function buildCandidateEnvelope(input = {}, candidates = [], opts = {}) {
  const provided = input.candidateEnvelope || input.candidate_envelope || {};
  const version = provided.version
    || input.candidateEnvelopeVersion
    || input.candidate_envelope_version
    || 'current_memory_candidate_envelope_v1';
  return {
    ...provided,
    version,
    source: provided.source || input.mode || 'finalization',
    transcriptHash: opts.transcriptHash || input.transcriptHash || null,
    inputContext: provided.inputContext || provided.input_context || {},
    candidates: candidates.map(publicCandidateEnvelopeRow),
  };
}

function decorateCandidates(candidates = [], input = {}) {
  const candidatePayload = input.candidatePayload && typeof input.candidatePayload === 'object'
    ? input.candidatePayload
    : null;
  if (!candidatePayload) return candidates;
  return candidates.map(candidate => ({
    ...candidate,
    payload: {
      ...(candidate.payload || {}),
      ...candidatePayload,
    },
  }));
}

function normalizeFinalizationInput(input = {}, defaults = {}) {
  const tenantId = input.tenantId || defaults.defaultTenantId || 'default';
  return {
    tenantId,
    sessionId: input.sessionId,
    agentId: input.agentId || 'main',
    source: input.source || 'codex',
    host: input.host || 'codex',
    transcriptHash: input.transcriptHash,
    phase: input.phase || 'curated_memory_v1',
    mode: input.mode || 'handoff',
  };
}

function createSessionFinalization({
  pool,
  schema,
  recordsSchema,
  defaultTenantId = 'default',
  embedFn = null,
}) {
  const memorySchema = recordsSchema || qi(schema);

  async function createTask(input = {}) {
    const base = normalizeFinalizationInput(input, { defaultTenantId });
    requireField(base, 'sessionId');
    requireField(base, 'agentId');
    requireField(base, 'source');
    requireField(base, 'transcriptHash');

    let sessionRowId = input.sessionRowId || null;
    if (!sessionRowId) {
      const session = await storage.getSession(
        pool,
        base.sessionId,
        base.agentId,
        { tenantId: base.tenantId, source: base.source },
        { schema, tenantId: base.tenantId },
      );
      if (!session) {
        throw new Error(`Session not found: ${base.sessionId} (agentId=${base.agentId}, source=${base.source})`);
      }
      sessionRowId = session.id;
    }

    return storage.upsertSessionFinalization(pool, {
      ...base,
      sessionRowId,
      status: input.status || 'pending',
      finalizerModel: input.finalizerModel || null,
      scopeKind: input.scopeKind || null,
      scopeKey: input.scopeKey || null,
      contextKey: input.contextKey || null,
      topicKey: input.topicKey || null,
      scopeId: input.scopeId || input.scope_id || null,
      scopeSnapshot: input.scopeSnapshot || input.scope_snapshot || {},
      memoryResult: input.memoryResult || {},
      error: input.error || null,
      metadata: input.metadata || {},
      claimedAt: input.claimedAt || null,
      finalizedAt: input.finalizedAt || null,
    }, { schema, tenantId: base.tenantId });
  }

  async function get(input = {}) {
    const base = normalizeFinalizationInput(input, { defaultTenantId });
    return storage.getSessionFinalization(pool, base, { schema, tenantId: base.tenantId });
  }

  async function list(input = {}) {
    const tenantId = input.tenantId || defaultTenantId || 'default';
    return storage.listSessionFinalizations(pool, input, { schema, tenantId });
  }

  async function updateStatus(input = {}) {
    const tenantId = input.tenantId || defaultTenantId || 'default';
    return storage.updateSessionFinalizationStatus(pool, input, { schema, tenantId });
  }

  async function finalizeSession(input = {}) {
    const base = normalizeFinalizationInput(input, { defaultTenantId });
    requireField(base, 'sessionId');
    requireField(base, 'agentId');
    requireField(base, 'source');
    requireField(base, 'transcriptHash');

    const summaryText = String(input.summaryText || '').trim();
    const structuredSummary = input.structuredSummary || {};
    if (!summaryText && !hasStructuredContent(structuredSummary)) {
      throw new Error('summaryText or structuredSummary is required');
    }

    const client = await pool.connect();
    let failureSession = null;
    let processingTask = null;
    try {
      await client.query('BEGIN');

      const sessionResult = await client.query(
        `SELECT *
           FROM ${qi(schema)}.sessions
          WHERE tenant_id = $1
            AND agent_id = $2
            AND session_id = $3
            AND source = $4
          FOR UPDATE`,
        [base.tenantId, base.agentId, base.sessionId, base.source],
      );
      const session = sessionResult.rows[0] || null;
      if (!session) {
        throw new Error(`Session not found: ${base.sessionId} (agentId=${base.agentId}, source=${base.source})`);
      }
      failureSession = session;

      const existing = await storage.getSessionFinalization(client, base, {
        schema,
        tenantId: base.tenantId,
      });
      if (existing && existing.status === 'finalized') {
        await client.query('COMMIT');
        return {
          status: 'already_finalized',
          finalization: existing,
          memoryResult: existing.memory_result || {},
        };
      }
      if (existing && TERMINAL_SUPPRESSION_STATUSES.has(existing.status)) {
        await client.query('COMMIT');
        return {
          status: 'suppressed',
          finalizationStatus: existing.status,
          finalization: existing,
          memoryResult: existing.memory_result || {},
        };
      }

      processingTask = await storage.upsertSessionFinalization(client, {
        ...base,
        sessionRowId: session.id,
        status: 'processing',
        finalizerModel: input.finalizerModel || input.model || null,
        scopeKind: input.scopeKind || null,
        scopeKey: input.scopeKey || null,
        contextKey: input.contextKey || null,
        topicKey: input.topicKey || null,
        scopeId: input.scopeId || input.scope_id || null,
        scopeSnapshot: input.scopeSnapshot || input.scope_snapshot || {},
        metadata: input.metadata || {},
        claimedAt: input.claimedAt || new Date().toISOString(),
      }, { schema, tenantId: base.tenantId });

      const sanitized = sanitizeSummaryResult({ summaryText, structuredSummary });
      const safeSummary = sanitized.summaryResult || {};
      const safeStructuredSummary = safeSummary.structuredSummary || {};
      const safeSummaryText = safeSummary.summaryText || summaryText;
      const finalizerModel = input.finalizerModel || input.model || session.model || null;

      const summaryRow = await storage.upsertSummary(client, session.id, {
        schema,
        tenantId: base.tenantId,
        agentId: base.agentId,
        sessionId: base.sessionId,
        summaryText: safeSummaryText,
        structuredSummary: safeStructuredSummary,
        model: finalizerModel,
        sourceHash: base.transcriptHash,
        msgCount: input.msgCount || input.messageCount || session.msg_count || 0,
        userCount: input.userCount || session.user_count || 0,
        assistantCount: input.assistantCount || session.assistant_count || 0,
        startedAt: input.startedAt || session.started_at || null,
        endedAt: input.endedAt || session.ended_at || session.last_message_at || null,
        embedding: input.embedding || null,
      });

      const records = createMemoryRecords({
        pool: client,
        schema: memorySchema,
        defaultTenantId: base.tenantId,
        inTransaction: true,
      });
      const promotion = createMemoryPromotion({ records, embedFn });
      const evidenceRefs = [{
        sourceKind: 'session_summary',
        sourceRef: base.sessionId,
        relationKind: 'primary',
        metadata: {
          transcriptHash: base.transcriptHash,
          finalizationId: processingTask ? processingTask.id : null,
          mode: base.mode,
          phase: base.phase,
        },
      }];
      const rawCandidates = Array.isArray(input.candidates)
        ? input.candidates
        : promotion.extractCandidates({
            sessionId: base.sessionId,
            structuredSummary: safeStructuredSummary,
            scopeKind: input.scopeKind || null,
            scopeKey: input.scopeKey || null,
            contextKey: input.contextKey || null,
            topicKey: input.topicKey || null,
            authority: input.authority || 'verified_summary',
            evidenceRefs,
          });
      const candidates = decorateCandidates(rawCandidates, input);
      const candidateEnvelope = buildCandidateEnvelope(input, candidates, {
        transcriptHash: base.transcriptHash,
      });

      const memoryResults = candidates.length > 0
        ? await promotion.promote(candidates, {
            tenantId: base.tenantId,
            acceptedAt: input.acceptedAt || new Date().toISOString(),
            createdByFinalizationId: processingTask ? processingTask.id : null,
          })
        : [];
      if (processingTask && memoryResults.length > 0) {
        await storage.upsertFinalizationCandidates(client, memoryResults, {
          tenantId: base.tenantId,
          finalizationId: processingTask.id,
          sessionId: base.sessionId,
        }, { schema, tenantId: base.tenantId });
      }
      const memoryResult = summarizeMemoryResults(memoryResults, {
        safetyGate: sanitized.meta || {},
      });
      const promotedMemories = memoryResults
        .filter(result => result && result.action === 'promote' && result.memory)
        .map(result => result.memory);
      const humanReviewText = buildFinalizationReview({
        summary: {
          summaryText: safeSummaryText,
          structuredSummary: safeStructuredSummary,
        },
        memoryResult,
        memoryResults,
        sessionId: base.sessionId,
        transcriptHash: base.transcriptHash,
        finalization: processingTask,
      });
      const sessionStartText = buildSessionStartContext(promotedMemories);

      const finalization = await storage.upsertSessionFinalization(client, {
        ...base,
        sessionRowId: session.id,
        status: 'finalized',
        finalizerModel,
        scopeKind: input.scopeKind || null,
        scopeKey: input.scopeKey || null,
        contextKey: input.contextKey || null,
        topicKey: input.topicKey || null,
        scopeId: input.scopeId || input.scope_id || null,
        scopeSnapshot: input.scopeSnapshot || input.scope_snapshot || {},
        summaryRowId: summaryRow ? summaryRow.session_row_id : session.id,
        memoryResult,
        summaryText: safeSummaryText,
        structuredSummary: safeStructuredSummary,
        humanReviewText,
        sessionStartText,
        candidateEnvelope,
        candidateEnvelopeHash: hashStable(candidateEnvelope),
        candidateEnvelopeVersion: candidateEnvelope.version,
        coverage: input.coverage || candidateEnvelope.coverage || {},
        metadata: {
          ...(input.metadata || {}),
          safetyGate: sanitized.meta || {},
        },
      }, { schema, tenantId: base.tenantId });

      await storage.markStatus(client, session.id, 'succeeded', null, { schema });
      await client.query('COMMIT');

      return {
        status: 'finalized',
        finalization,
        summary: {
          summaryText: safeSummaryText,
          structuredSummary: safeStructuredSummary,
        },
        memoryResult,
        memoryResults,
        humanReviewText,
        sessionStartText,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (failureSession) {
        try {
          await storage.upsertSessionFinalization(pool, {
            ...base,
            sessionRowId: failureSession.id,
            status: 'failed',
            finalizerModel: input.finalizerModel || input.model || null,
            scopeKind: input.scopeKind || null,
            scopeKey: input.scopeKey || null,
            contextKey: input.contextKey || null,
            topicKey: input.topicKey || null,
            scopeId: input.scopeId || input.scope_id || null,
            scopeSnapshot: input.scopeSnapshot || input.scope_snapshot || {},
            metadata: input.metadata || {},
            error: error.message,
          }, { schema, tenantId: base.tenantId });
        } catch {
          // The original finalization failure is the useful error. A secondary
          // ledger failure should not hide it.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    createTask,
    get,
    list,
    updateStatus,
    finalizeSession,
  };
}

module.exports = {
  createSessionFinalization,
};
