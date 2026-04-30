'use strict';

const crypto = require('node:crypto');
const { sanitizeSummaryResult } = require('./memory-safety-gate');
const { buildScopeEnvelope, getScopeByEnvelopeId } = require('./scope-attribution');

const DEFAULT_POLICY_VERSION = 'session_checkpoint_producer_v1';
const DEFAULT_COVERAGE_COORDINATE_SYSTEM = 'codex_sanitized_view_v1';
const STRUCTURED_SUMMARY_SHAPE = '{"summaryText":"...","structuredSummary":{"facts":[],"decisions":[],"open_loops":[],"preferences":[],"constraints":[],"conclusions":[],"entity_notes":[],"states":[]},"coverage":{"coordinateSystem":"codex_sanitized_view_v1","coveredUntilMessageIndex":0,"coveredUntilChar":0}}';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashSnapshot(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function optionalNonNegativeInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function requiredPositiveInteger(value, field) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return n;
}

function normalizeFinalizationRange(input = {}) {
  const from = Number(input.fromFinalizationIdExclusive ?? input.from_finalization_id_exclusive ?? 0);
  const to = Number(input.toFinalizationIdInclusive ?? input.to_finalization_id_inclusive);
  if (!Number.isSafeInteger(from) || from < 0) {
    throw new Error('fromFinalizationIdExclusive must be a non-negative integer');
  }
  if (!Number.isSafeInteger(to) || to <= from) {
    throw new Error('toFinalizationIdInclusive must be greater than fromFinalizationIdExclusive');
  }
  return {
    fromFinalizationIdExclusive: from,
    toFinalizationIdInclusive: to,
  };
}

function assertOkTranscriptView(view = {}) {
  if (!view || view.status !== 'ok') {
    throw new Error(`checkpoint synthesis requires an ok transcript view; got ${view && view.status ? view.status : 'missing'}`);
  }
  if (typeof view.text !== 'string') {
    throw new Error('checkpoint synthesis requires view.text');
  }
}

function normalizeCoverageNumber(...values) {
  for (const value of values) {
    const n = optionalNonNegativeInteger(value);
    if (n !== null) return n;
  }
  return null;
}

function buildCheckpointCoverageFromView(view = {}, opts = {}) {
  assertOkTranscriptView(view);
  const explicit = opts.coverage && typeof opts.coverage === 'object'
    ? opts.coverage
    : (view.coverage && typeof view.coverage === 'object' ? view.coverage : {});
  const transcript = explicit.transcript && typeof explicit.transcript === 'object' ? explicit.transcript : {};
  const messageCount = Number.isFinite(Number(view.counts?.safeMessageCount))
    ? Number(view.counts.safeMessageCount)
    : (Array.isArray(view.messages) ? view.messages.length : 0);
  const text = typeof view.text === 'string' ? view.text : '';
  const fullCharCount = Number.isFinite(Number(view.fullCharCount ?? view.counts?.fullCharCount))
    ? Number(view.fullCharCount ?? view.counts.fullCharCount)
    : text.length;
  const coveredUntilMessageIndex = normalizeCoverageNumber(
    opts.coveredUntilMessageIndex,
    explicit.coveredUntilMessageIndex,
    explicit.covered_until_message_index,
    explicit.messageIndex,
    explicit.message_index,
    transcript.coveredUntilMessageIndex,
    transcript.covered_until_message_index
  );
  const coveredUntilChar = normalizeCoverageNumber(
    opts.coveredUntilChar,
    opts.coveredUntilCharIndex,
    explicit.coveredUntilChar,
    explicit.coveredUntilCharIndex,
    explicit.covered_until_char,
    explicit.covered_until_char_index,
    transcript.coveredUntilChar,
    transcript.covered_until_char
  );
  const coveredUntilLine = normalizeCoverageNumber(
    opts.coveredUntilLine,
    explicit.coveredUntilLine,
    explicit.coveredUntilLineIndex,
    explicit.covered_until_line,
    explicit.covered_until_line_index,
    transcript.coveredUntilLine,
    transcript.covered_until_line
  );
  const coveredUntilLineChar = normalizeCoverageNumber(
    opts.coveredUntilLineChar,
    explicit.coveredUntilLineChar,
    explicit.coveredUntilLineCharIndex,
    explicit.covered_until_line_char,
    explicit.covered_until_line_char_index,
    transcript.coveredUntilLineChar,
    transcript.covered_until_line_char
  );
  const coverage = {
    coordinateSystem: explicit.coordinateSystem || explicit.coordinate_system || DEFAULT_COVERAGE_COORDINATE_SYSTEM,
    messageIndexBase: 0,
    charIndexBase: 0,
    semantics: 'coveredUntilChar is the first uncovered zero-based char offset; messages up to coveredUntilMessageIndex are covered.',
  };
  if (coveredUntilMessageIndex !== null) coverage.coveredUntilMessageIndex = coveredUntilMessageIndex;
  if (coveredUntilChar !== null) coverage.coveredUntilChar = coveredUntilChar;
  if (coveredUntilLine !== null) coverage.coveredUntilLine = coveredUntilLine;
  if (coveredUntilLineChar !== null) coverage.coveredUntilLineChar = coveredUntilLineChar;
  if (coverage.coveredUntilMessageIndex === undefined && messageCount > 0) {
    coverage.coveredUntilMessageIndex = messageCount - 1;
  }
  if (coverage.coveredUntilChar === undefined) coverage.coveredUntilChar = fullCharCount;
  return coverage;
}

function compactText(value, maxChars = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}...`;
}

function compactCurrentMemoryRow(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    memoryType: row.memoryType || row.memory_type || 'memory',
    canonicalKey: row.canonicalKey || row.canonical_key || null,
    scopeKey: row.scopeKey || row.scope_key || null,
    summary: compactText(row.summary || row.title || '', 420),
    authority: row.authority || null,
    confidence: payload.confidence || payload.currentMemoryConfidence || null,
  };
}

function compactCurrentMemory(currentMemory = null, opts = {}) {
  const rows = Array.isArray(currentMemory?.memories)
    ? currentMemory.memories
    : (Array.isArray(currentMemory?.items) ? currentMemory.items : []);
  const maxItems = Math.max(0, Math.min(20, opts.maxCurrentMemoryItems || opts.currentMemoryLimit || 12));
  return rows
    .map(compactCurrentMemoryRow)
    .filter(row => row.summary)
    .slice(0, maxItems);
}

function compactCheckpointRow(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    checkpointKey: row.checkpointKey || row.checkpoint_key || null,
    scopeKey: row.scopeKey || row.scope_key || null,
    topicKey: row.topicKey || row.topic_key || payload.topicKey || null,
    triggerKind: row.triggerKind || row.trigger_kind || payload.triggerKind || null,
    summaryText: compactText(row.summaryText || row.summary_text || row.summary || payload.summaryText, 520),
    coverage: row.coverage || payload.coverage || {},
  };
}

function compactPreviousCheckpoints(checkpoints = [], opts = {}) {
  const rows = Array.isArray(checkpoints?.checkpoints)
    ? checkpoints.checkpoints
    : (Array.isArray(checkpoints?.items) ? checkpoints.items : checkpoints);
  const maxItems = Math.max(0, Math.min(12, opts.maxCheckpoints || opts.checkpointLimit || 6));
  return (Array.isArray(rows) ? rows : [])
    .map(compactCheckpointRow)
    .filter(row => row.summaryText || Object.keys(row.coverage || {}).length > 0)
    .slice(0, maxItems);
}

function normalizeScopeEnvelope(input = {}) {
  const envelope = input.scopeEnvelope || input.scope_envelope || null;
  if (envelope && typeof envelope === 'object') {
    return {
      ...envelope,
      scopeById: envelope.scopeById || Object.fromEntries((envelope.slots || []).map(scope => [scope.id, scope])),
    };
  }
  const scopeInput = input.scope && typeof input.scope === 'object' ? input.scope : input;
  const built = buildScopeEnvelope(scopeInput);
  if (built.activeScopeKey === 'global' && (!built.slots || built.slots.length === 0)) {
    throw new Error('checkpoint synthesis requires a bounded scope envelope');
  }
  return built;
}

function normalizeTargetScope(envelope = {}, input = {}) {
  const targetScopeEnvelopeId = input.targetScopeEnvelopeId
    || input.target_scope_envelope_id
    || input.targetScopeId
    || input.target_scope_id
    || envelope.activeSlotId;
  const scope = getScopeByEnvelopeId(envelope, targetScopeEnvelopeId);
  if (!scope.promotable) {
    throw new Error(`checkpoint synthesis target scope is not promotable: ${targetScopeEnvelopeId}`);
  }
  if (!Array.isArray(envelope.allowedScopeKeys) || !envelope.allowedScopeKeys.includes(scope.scopeKey)) {
    throw new Error(`checkpoint synthesis target scope is outside allowed envelope: ${scope.scopeKey}`);
  }
  return {
    envelopeId: scope.id,
    scopeKind: scope.scopeKind,
    scopeKey: scope.scopeKey,
    label: scope.label || null,
  };
}

function buildCheckpointSynthesisInput(input = {}, opts = {}) {
  const view = input.view || opts.view;
  assertOkTranscriptView(view);
  const range = normalizeFinalizationRange(input);
  const scopeEnvelope = normalizeScopeEnvelope(input);
  const targetScope = normalizeTargetScope(scopeEnvelope, input);
  const coverage = buildCheckpointCoverageFromView(view, input);
  const maxTranscriptChars = Math.max(1000, Math.min(120000, input.maxTranscriptChars || opts.maxTranscriptChars || 60000));
  const transcriptText = view.text.length > maxTranscriptChars
    ? view.text.slice(Math.max(0, view.text.length - maxTranscriptChars))
    : view.text;
  const base = {
    kind: 'session_checkpoint_synthesis_input_v1',
    policyVersion: input.policyVersion || opts.policyVersion || DEFAULT_POLICY_VERSION,
    sourceOfTruth: input.sourceOfTruth || input.source_of_truth || opts.sourceOfTruth || 'sanitized_transcript_view',
    triggerKind: input.triggerKind || input.trigger_kind || opts.triggerKind || 'manual',
    promotion: {
      default: 'checkpoint_proposal_only',
      requires: 'operator_review_or_explicit_finalize',
    },
    guards: {
      checkpointIsProcessMaterial: true,
      rawToolOutputExcluded: true,
      debugIdsExcluded: true,
      activeMemoryCommitExcluded: true,
    },
    range,
    coverage,
    targetScope,
    scopeEnvelope: {
      policyVersion: scopeEnvelope.policyVersion || 'scope_envelope_v1',
      activeSlotId: scopeEnvelope.activeSlotId,
      activeScopeKey: scopeEnvelope.activeScopeKey,
      allowedScopeKeys: scopeEnvelope.allowedScopeKeys || [],
      slots: (scopeEnvelope.slots || []).map(scope => ({
        id: scope.id,
        slot: scope.slot,
        scopeKind: scope.scopeKind,
        scopeKey: scope.scopeKey,
        label: scope.label || null,
        promotable: Boolean(scope.promotable),
        allowedScopeKeys: scope.allowedScopeKeys || [],
      })),
    },
    transcript: {
      sessionId: view.sessionId || null,
      transcriptHash: view.transcriptHash || null,
      charCount: view.charCount ?? view.text.length,
      approxPromptTokens: view.approxPromptTokens || Math.ceil(view.text.length / 3),
      truncated: transcriptText.length !== view.text.length,
      text: transcriptText,
    },
    currentMemory: compactCurrentMemory(input.currentMemory || opts.currentMemory || null, input),
    previousCheckpoints: compactPreviousCheckpoints(input.previousCheckpoints || input.checkpoints || opts.previousCheckpoints || [], input),
    storage: {
      scopeId: input.storageScopeId || input.storage_scope_id || input.scopeDbId || input.scope_db_id || null,
    },
  };
  return {
    ...base,
    inputHash: hashSnapshot(base),
  };
}

function promptSafeSynthesisInput(synthesisInput = {}) {
  const transcript = synthesisInput.transcript && typeof synthesisInput.transcript === 'object'
    ? {
        ...synthesisInput.transcript,
        transcriptHash: undefined,
      }
    : synthesisInput.transcript;
  const out = {
    ...synthesisInput,
    inputHash: undefined,
    storage: undefined,
    transcript,
  };
  return JSON.parse(JSON.stringify(out));
}

function buildCheckpointSynthesisPrompt(synthesisInput = {}, opts = {}) {
  if (!synthesisInput || synthesisInput.kind !== 'session_checkpoint_synthesis_input_v1') {
    throw new Error('buildCheckpointSynthesisPrompt requires a checkpoint synthesis input');
  }
  const maxFacts = Math.max(1, Math.min(24, opts.maxFacts || 10));
  const promptInput = promptSafeSynthesisInput(synthesisInput);
  return [
    'You are producing an Aquifer session checkpoint proposal.',
    'Use only the <checkpoint_synthesis_input> block. Do not use hidden tool output, injected context, or debug material.',
    'This checkpoint is producer process material, not active current memory and not final truth.',
    'Choose scope only from scopeEnvelope.slots and keep every item inside targetScope unless the input proves a narrower allowed scope.',
    'Do not include DB ids, raw hashes, secrets, raw tool output, or prompt/debug identifiers in memory candidates.',
    'Return compact JSON with this shape:',
    STRUCTURED_SUMMARY_SHAPE,
    `Keep facts/decisions/open_loops concrete and scoped. Use at most ${maxFacts} facts.`,
    'Preserve the coverage object so handoff can skip only the already-covered transcript range.',
    '',
    '<checkpoint_synthesis_input>',
    stableJson(promptInput),
    '</checkpoint_synthesis_input>',
  ].join('\n');
}

function normalizeCheckpointSynthesisSummary(input = {}) {
  const raw = input && typeof input === 'object'
    ? {
        summaryText: input.summaryText || input.summary || '',
        structuredSummary: input.structuredSummary || input.structured_summary || {},
      }
    : {
        summaryText: '',
        structuredSummary: {},
      };
  const sanitized = sanitizeSummaryResult(raw);
  const coverage = input && typeof input === 'object' && input.coverage && typeof input.coverage === 'object'
    ? input.coverage
    : null;
  return {
    summary: sanitized.summaryResult || raw,
    coverage,
    safetyGate: sanitized.meta || {},
  };
}

function buildCheckpointRunInputFromSynthesis(synthesisInput = {}, synthesisSummary = {}, opts = {}) {
  if (!synthesisInput || synthesisInput.kind !== 'session_checkpoint_synthesis_input_v1') {
    throw new Error('checkpoint run input requires a checkpoint synthesis input');
  }
  const { summary, coverage, safetyGate } = normalizeCheckpointSynthesisSummary(synthesisSummary);
  const summaryText = String(summary.summaryText || summary.summary || '').trim();
  const structuredSummary = summary.structuredSummary || {};
  if (!summaryText && Object.keys(structuredSummary).length === 0) {
    throw new Error('checkpoint run input requires summaryText or structuredSummary');
  }
  const range = normalizeFinalizationRange(synthesisInput.range || {});
  const scopeId = requiredPositiveInteger(
    opts.storageScopeId || opts.scopeId || synthesisInput.storage?.scopeId,
    'storageScopeId'
  );
  const status = opts.status || 'processing';
  const targetScope = synthesisInput.targetScope || {};
  const checkpointPayload = {
    kind: 'session_checkpoint_proposal_v1',
    policyVersion: synthesisInput.policyVersion || DEFAULT_POLICY_VERSION,
    inputHash: synthesisInput.inputHash || hashSnapshot(synthesisInput),
    promotionGate: 'operator_required',
    checkpointRole: 'handoff_process_material',
    triggerKind: synthesisInput.triggerKind || 'manual',
    summaryText,
    structuredSummary,
    coverage: coverage || synthesisInput.coverage || {},
    targetScope,
    safetyGate,
  };
  return {
    scopeId,
    checkpointKey: opts.checkpointKey || undefined,
    status,
    fromFinalizationIdExclusive: range.fromFinalizationIdExclusive,
    toFinalizationIdInclusive: range.toFinalizationIdInclusive,
    scopeSnapshot: {
      scopeKind: targetScope.scopeKind || null,
      scopeKey: targetScope.scopeKey || null,
      targetScopeEnvelopeId: targetScope.envelopeId || null,
      policyVersion: synthesisInput.scopeEnvelope?.policyVersion || 'scope_envelope_v1',
    },
    checkpointText: summaryText || null,
    checkpointPayload,
    metadata: {
      source: 'session_checkpoint_producer',
      inputHash: checkpointPayload.inputHash,
      triggerKind: checkpointPayload.triggerKind,
      policyVersion: checkpointPayload.policyVersion,
    },
  };
}

module.exports = {
  stableJson,
  hashSnapshot,
  buildCheckpointCoverageFromView,
  buildCheckpointSynthesisInput,
  buildCheckpointSynthesisPrompt,
  promptSafeSynthesisInput,
  normalizeCheckpointSynthesisSummary,
  buildCheckpointRunInputFromSynthesis,
};
