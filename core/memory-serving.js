'use strict';

function splitScopePath(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map(v => v.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function hasEvidenceBoundary(opts = {}) {
  return Boolean(
    opts.agentId
    || (Array.isArray(opts.agentIds) && opts.agentIds.length > 0)
    || opts.source
    || opts.dateFrom
    || opts.dateTo
    || opts.host
    || opts.sessionId
    || opts.allowUnsafeDebug === true
    || opts.unsafeDebug === true
  );
}

function assertCuratedRecallOpts(opts = {}) {
  const unsupported = [];
  for (const key of ['agentId', 'agentIds', 'source', 'dateFrom', 'dateTo', 'entities', 'entityMode', 'weights', 'rerank', 'allowUnsafeDebug', 'unsafeDebug']) {
    if (opts[key] !== undefined && opts[key] !== null) unsupported.push(key);
  }
  if (unsupported.length > 0) {
    throw new Error(`curated memory_recall does not support legacy filters: ${unsupported.join(', ')}. Use activeScopeKey/activeScopePath or historical_recall.`);
  }
}

function assertCuratedBootstrapOpts(opts = {}) {
  const unsupported = [];
  for (const key of ['agentId', 'source', 'lookbackDays', 'dateFrom', 'dateTo']) {
    if (opts[key] !== undefined && opts[key] !== null) unsupported.push(key);
  }
  if (unsupported.length > 0) {
    throw new Error(`curated session_bootstrap does not support legacy filters: ${unsupported.join(', ')}. Use activeScopeKey/activeScopePath.`);
  }
}

function curatedRecallTitle(row = {}) {
  const title = row.title || row.summary || row.canonical_key || row.canonicalKey || row.memory_type || row.memoryType || 'memory';
  return String(title).trim();
}

function curatedRecallSummary(row = {}) {
  const summary = row.summary || row.title || row.canonical_key || row.canonicalKey || '';
  return String(summary).trim();
}

function normalizeCuratedRecallRow(row = {}) {
  const { embedding: _embedding, ...publicRow } = row;
  void _embedding;
  const memoryId = row.memoryId || row.memory_id || row.id || null;
  const canonicalKey = row.canonicalKey || row.canonical_key || null;
  const memoryType = row.memoryType || row.memory_type || null;
  const scopeKey = row.scopeKey || row.scope_key || null;
  const scopeKind = row.scopeKind || row.scope_kind || null;
  const summaryText = curatedRecallSummary(row) || null;
  const title = curatedRecallTitle(row) || null;
  const scoreValue = row.recall_score ?? row.score ?? row.lexical_rank ?? null;
  const score = scoreValue === null ? null : Number(scoreValue);
  return {
    ...publicRow,
    memoryId: memoryId === null ? null : String(memoryId),
    canonicalKey,
    memoryType,
    scopeKey,
    scopeKind,
    title,
    summaryText,
    structuredSummary: {
      title,
      overview: summaryText,
    },
    startedAt: row.acceptedAt || row.accepted_at || row.observedAt || row.observed_at || null,
    score: Number.isFinite(score) ? score : null,
    feedbackTarget: {
      kind: 'memory_feedback',
      memoryId: memoryId === null ? null : String(memoryId),
      canonicalKey,
    },
  };
}

function createMemoryServingRuntime(memoryCfg = {}, env = process.env) {
  const servingMode = memoryCfg.servingMode || env.AQUIFER_MEMORY_SERVING_MODE || 'legacy';
  const defaultActiveScopeKey = memoryCfg.activeScopeKey || null;
  const defaultActiveScopePath = splitScopePath(memoryCfg.activeScopePath || null);

  function resolveMode(opts = {}) {
    const mode = opts.memoryMode || opts.servingMode || servingMode;
    if (mode === 'legacy' || mode === 'evidence') return 'legacy';
    if (mode === 'curated') return 'curated';
    throw new Error(`Invalid memory serving mode: "${mode}". Must be one of: legacy, curated`);
  }

  function withDefaultScope(opts = {}) {
    const next = { ...opts };
    if (!next.activeScopePath && defaultActiveScopePath) next.activeScopePath = defaultActiveScopePath;
    if (Array.isArray(next.activeScopePath) && next.activeScopePath.length > 0) {
      if (!next.activeScopeKey) next.activeScopeKey = next.activeScopePath[next.activeScopePath.length - 1];
      return next;
    }
    if (!next.activeScopeKey && defaultActiveScopeKey) next.activeScopeKey = defaultActiveScopeKey;
    return next;
  }

  return {
    assertCuratedBootstrapOpts,
    assertCuratedRecallOpts,
    defaultActiveScopeKey,
    defaultActiveScopePath,
    hasEvidenceBoundary,
    normalizeCuratedRecallRow,
    resolveMode,
    servingMode,
    withDefaultScope,
  };
}

module.exports = {
  assertCuratedBootstrapOpts,
  assertCuratedRecallOpts,
  createMemoryServingRuntime,
  hasEvidenceBoundary,
  normalizeCuratedRecallRow,
  splitScopePath,
};
