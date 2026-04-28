'use strict';

const crypto = require('crypto');
const { extractCandidatesFromStructuredSummary, createMemoryPromotion } = require('./memory-promotion');
const { createMemoryRecords } = require('./memory-records');

const ALLOWED_CADENCES = new Set(['session', 'daily', 'weekly', 'monthly', 'manual']);
const OPERATOR_CADENCES = new Set(['manual', 'daily', 'weekly', 'monthly']);
const DEFAULT_CLAIM_LEASE_SECONDS = 600;
const DEFAULT_OPERATOR_SNAPSHOT_LIMIT = 1000;
const MAX_OPERATOR_SNAPSHOT_LIMIT = 5000;

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

function advisoryLockKeys(namespace, value) {
  const digest = crypto.createHash('sha256').update(`${namespace}:${value}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function canonicalInstant(value) {
  const t = timeMs(value);
  return t === null ? String(value || '') : new Date(t).toISOString();
}

function timeMs(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

function normalizeClaimLeaseSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CLAIM_LEASE_SECONDS;
  return Math.max(10, Math.floor(n));
}

function requirePeriod(opts = {}) {
  const cadence = opts.cadence || 'manual';
  if (!ALLOWED_CADENCES.has(cadence)) {
    throw new Error(`memory.consolidation.plan invalid cadence: ${cadence}`);
  }
  const periodStart = opts.periodStart || opts.from || null;
  const periodEnd = opts.periodEnd || opts.to || null;
  if (!periodStart || !periodEnd) {
    throw new Error('memory.consolidation.plan requires periodStart and periodEnd');
  }
  const startMs = timeMs(periodStart);
  const endMs = timeMs(periodEnd);
  if (startMs === null || endMs === null) {
    throw new Error('memory.consolidation.plan requires valid periodStart and periodEnd');
  }
  if (endMs <= startMs) {
    throw new Error('memory.consolidation.plan requires periodEnd after periodStart');
  }
  return { cadence, periodStart, periodEnd, startMs, endMs };
}

function utcDayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function utcWeekStart(ms) {
  const dayStart = utcDayStart(ms);
  const d = new Date(dayStart);
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  return dayStart - (mondayOffset * 86400000);
}

function utcMonthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function resolveOperatorCadence(value) {
  const cadence = String(value || 'manual').trim().toLowerCase();
  if (!OPERATOR_CADENCES.has(cadence)) {
    throw new Error(`memory.consolidation.job invalid cadence: ${cadence}`);
  }
  return cadence;
}

function resolveOperatorAnchorMs(input = {}) {
  const value = input.anchorTime || input.now || input.asOf || input.snapshotAsOf || Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error('memory.consolidation.job requires a valid anchorTime');
}

function resolveOperatorWindow(input = {}) {
  const cadence = resolveOperatorCadence(input.cadence);
  const hasExplicitWindow = Boolean(input.periodStart || input.periodEnd || input.from || input.to);

  if (cadence === 'manual' || hasExplicitWindow) {
    const period = requirePeriod({
      cadence,
      periodStart: input.periodStart || input.from || null,
      periodEnd: input.periodEnd || input.to || null,
    });
    return {
      cadence,
      periodStart: canonicalInstant(period.periodStart),
      periodEnd: canonicalInstant(period.periodEnd),
    };
  }

  const anchorMs = resolveOperatorAnchorMs(input);
  let periodStartMs;
  let periodEndMs;

  if (cadence === 'daily') {
    periodEndMs = utcDayStart(anchorMs);
    periodStartMs = periodEndMs - 86400000;
  } else if (cadence === 'weekly') {
    periodEndMs = utcWeekStart(anchorMs);
    periodStartMs = periodEndMs - (7 * 86400000);
  } else if (cadence === 'monthly') {
    periodEndMs = utcMonthStart(anchorMs);
    const d = new Date(periodEndMs);
    periodStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  } else {
    throw new Error(`memory.consolidation.job invalid cadence: ${cadence}`);
  }

  return {
    cadence,
    periodStart: new Date(periodStartMs).toISOString(),
    periodEnd: new Date(periodEndMs).toISOString(),
  };
}

function normalizeOperatorSnapshotLimit(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_OPERATOR_SNAPSHOT_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_OPERATOR_SNAPSHOT_LIMIT;
  return Math.max(1, Math.min(MAX_OPERATOR_SNAPSHOT_LIMIT, Math.floor(n)));
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function recordKey(record) {
  return String(record.canonicalKey || record.canonical_key || record.id || record.memory_id || '');
}

function normalizeRecordId(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (Number.isSafeInteger(number) && number > 0 && String(number) === String(value)) return number;
  return value;
}

function normalizeRecord(record) {
  return {
    id: normalizeRecordId(record.id || record.memory_id),
    memoryType: record.memoryType || record.memory_type || null,
    canonicalKey: recordKey(record),
    status: record.status || null,
    scopeKind: record.scopeKind || record.scope_kind || null,
    scopeKey: record.scopeKey || record.scope_key || null,
    contextKey: record.contextKey || record.context_key || null,
    topicKey: record.topicKey || record.topic_key || null,
    summary: record.summary || '',
    validFrom: record.validFrom || record.valid_from || null,
    validTo: record.validTo || record.valid_to || null,
    staleAfter: record.staleAfter || record.stale_after || null,
    acceptedAt: record.acceptedAt || record.accepted_at || null,
  };
}

function aggregateCandidateCadence(cadence) {
  return cadence === 'daily' || cadence === 'weekly' || cadence === 'monthly';
}

function safeKeyPart(value, fallback) {
  const text = String(value || fallback || '').trim().toLowerCase();
  return text.replace(/\s+/g, '-').replace(/[^a-z0-9:._/-]/g, '-');
}

function compactSummary(record) {
  const summary = String(record.summary || '').trim().replace(/\s+/g, ' ');
  if (!summary) return record.canonicalKey;
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function buildAggregateCandidates(normalized, statusUpdates, opts) {
  const { cadence, periodStart, periodEnd } = opts;
  if (!aggregateCandidateCadence(cadence)) return [];

  const staleIds = new Set(statusUpdates.map(update => String(update.memoryId)));
  const staleKeys = new Set(statusUpdates.map(update => String(update.canonicalKey || '')));
  const active = normalized.filter(record => {
    if (record.status !== 'active') return false;
    if (record.id !== null && staleIds.has(String(record.id))) return false;
    if (staleKeys.has(record.canonicalKey)) return false;
    return Boolean(record.canonicalKey);
  });
  if (active.length === 0) return [];

  const tenantId = opts.tenantId || 'default';
  const policyVersion = opts.policyVersion || 'v1';
  const windowStart = canonicalInstant(periodStart);
  const windowEnd = canonicalInstant(periodEnd);
  const groups = new Map();

  for (const record of active) {
    const scopeKind = record.scopeKind || 'unspecified';
    const scopeKey = record.scopeKey || 'unspecified';
    const contextKey = record.contextKey || null;
    const topicKey = record.topicKey || null;
    const groupKey = stableJson({ scopeKind, scopeKey, contextKey, topicKey });
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        scopeKind,
        scopeKey,
        contextKey,
        topicKey,
        records: [],
      });
    }
    groups.get(groupKey).records.push(record);
  }

  const candidates = [];
  const sortedGroups = [...groups.values()].sort((a, b) => {
    const aKey = stableJson({ scopeKind: a.scopeKind, scopeKey: a.scopeKey, contextKey: a.contextKey, topicKey: a.topicKey });
    const bKey = stableJson({ scopeKind: b.scopeKind, scopeKey: b.scopeKey, contextKey: b.contextKey, topicKey: b.topicKey });
    return aKey.localeCompare(bKey);
  });

  for (const group of sortedGroups) {
    const records = group.records.sort((a, b) => {
      if (a.memoryType !== b.memoryType) return String(a.memoryType).localeCompare(String(b.memoryType));
      if (a.canonicalKey !== b.canonicalKey) return a.canonicalKey.localeCompare(b.canonicalKey);
      return String(a.id).localeCompare(String(b.id));
    });
    const sourceMemoryIds = records.map(record => record.id).filter(id => id !== null);
    const sourceCanonicalKeys = records.map(record => record.canonicalKey);
    const subject = [
      `tenant:${safeKeyPart(tenantId, 'default')}`,
      `scope:${safeKeyPart(group.scopeKey, 'unspecified')}`,
      `context:${safeKeyPart(group.contextKey, 'none')}`,
      `topic:${safeKeyPart(group.topicKey, 'none')}`,
      `cadence:${cadence}`,
    ].join('|');
    const aspect = [
      'aggregate',
      `policy:${safeKeyPart(policyVersion, 'v1')}`,
      `window:${safeKeyPart(windowStart, 'start')}_${safeKeyPart(windowEnd, 'end')}`,
    ].join('|');
    const canonicalKey = [
      'conclusion',
      safeKeyPart(group.scopeKey, 'unspecified'),
      subject,
      aspect,
    ].join(':');
    const candidateHash = hashSnapshot({
      canonicalKey,
      cadence,
      policyVersion,
      periodStart: windowStart,
      periodEnd: windowEnd,
      sourceMemoryIds,
      sourceCanonicalKeys,
    });
    const title = `${cadence} memory rollup candidate for ${group.scopeKey}`;
    const summary = [
      `${cadence} rollup candidate for ${group.scopeKind}:${group.scopeKey} covering ${records.length} active curated memories from ${windowStart} to ${windowEnd}.`,
      ...records.map(record => `- ${record.memoryType}:${record.canonicalKey}: ${compactSummary(record)}`),
    ].join('\n');

    candidates.push({
      memoryType: 'conclusion',
      status: 'candidate',
      canonicalKey,
      scopeKind: group.scopeKind,
      scopeKey: group.scopeKey,
      contextKey: group.contextKey,
      topicKey: group.topicKey,
      inheritanceMode: cadence === 'daily' ? 'defaultable' : 'additive',
      title,
      summary,
      candidateHash,
      payload: {
        kind: 'compaction_rollup',
        synthesisKind: 'timer_current_memory_synthesis_v1',
        currentMemoryRole: `${cadence}_timer_synthesis_candidate`,
        promotionGate: 'operator_required',
        cadence,
        policyVersion,
        periodStart: windowStart,
        periodEnd: windowEnd,
        candidateHash,
        sourceMemoryIds,
        sourceCanonicalKeys,
        sourceRecordCount: records.length,
      },
      authority: 'system',
      evidenceRefs: records.map(record => ({
        sourceKind: 'external',
        sourceRef: record.id !== null
          ? `memory_record:${record.id}`
          : `memory_record:${record.canonicalKey}`,
        relationKind: 'derived_from',
        metadata: {
          compaction: true,
          cadence,
          periodStart: windowStart,
          periodEnd: windowEnd,
          canonicalKey: record.canonicalKey,
        },
      })),
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
  }

  return candidates;
}

function buildTimerSynthesisInput(normalized, statusUpdates, candidates, opts) {
  const { cadence, periodStart, periodEnd } = opts;
  if (!aggregateCandidateCadence(cadence)) return null;

  const staleIds = new Set(statusUpdates.map(update => String(update.memoryId)));
  const staleKeys = new Set(statusUpdates.map(update => String(update.canonicalKey || '')));
  const sourceCurrentMemory = normalized
    .filter(record => record.status === 'active')
    .filter(record => record.id === null || !staleIds.has(String(record.id)))
    .filter(record => !staleKeys.has(record.canonicalKey))
    .filter(record => Boolean(record.canonicalKey))
    .map(record => ({
      memoryId: record.id,
      memoryType: record.memoryType,
      canonicalKey: record.canonicalKey,
      scopeKind: record.scopeKind,
      scopeKey: record.scopeKey,
      contextKey: record.contextKey,
      topicKey: record.topicKey,
      summary: compactSummary(record),
      acceptedAt: record.acceptedAt,
      validFrom: record.validFrom,
      validTo: record.validTo,
      staleAfter: record.staleAfter,
    }))
    .sort((a, b) => {
      if (a.canonicalKey !== b.canonicalKey) return a.canonicalKey.localeCompare(b.canonicalKey);
      return String(a.memoryId).localeCompare(String(b.memoryId));
    });

  const windowStart = canonicalInstant(periodStart);
  const windowEnd = canonicalInstant(periodEnd);
  return {
    kind: 'timer_current_memory_synthesis_v1',
    sourceOfTruth: 'memory_records',
    cadence,
    policyVersion: opts.policyVersion || 'v1',
    periodStart: windowStart,
    periodEnd: windowEnd,
    promotion: {
      default: 'candidate_only',
      requires: 'apply=true and promoteCandidates=true',
    },
    guards: {
      rawTranscriptExcluded: true,
      sessionSummariesExcluded: true,
      nonActiveMemoryExcluded: true,
      stalePlannedMemoryExcluded: true,
    },
    sourceCurrentMemory,
    statusUpdates: statusUpdates
      .map(update => ({
        memoryId: update.memoryId,
        canonicalKey: update.canonicalKey,
        status: update.status,
        reason: update.reason,
      }))
      .sort((a, b) => {
        if (a.canonicalKey !== b.canonicalKey) return String(a.canonicalKey).localeCompare(String(b.canonicalKey));
        return String(a.memoryId).localeCompare(String(b.memoryId));
      }),
    candidateProposals: candidates
      .map(candidate => ({
        candidateHash: candidate.candidateHash,
        memoryType: candidate.memoryType,
        canonicalKey: candidate.canonicalKey,
        scopeKind: candidate.scopeKind,
        scopeKey: candidate.scopeKey,
        contextKey: candidate.contextKey,
        topicKey: candidate.topicKey,
        summary: compactSummary(candidate),
        sourceMemoryIds: candidate.payload?.sourceMemoryIds || [],
        sourceCanonicalKeys: candidate.payload?.sourceCanonicalKeys || [],
      }))
      .sort((a, b) => {
        if (a.canonicalKey !== b.canonicalKey) return String(a.canonicalKey).localeCompare(String(b.canonicalKey));
        return String(a.candidateHash).localeCompare(String(b.candidateHash));
      }),
  };
}

function buildCoverage(normalized, statusUpdates, candidates) {
  const active = normalized.filter(record => record.status === 'active');
  const activeOpenLoops = active.filter(record => record.memoryType === 'open_loop');
  return {
    sourceCoverage: {
      recordCount: normalized.length,
      activeCount: active.length,
      activeOpenLoopCount: activeOpenLoops.length,
    },
    outputCoverage: {
      candidateCount: candidates.length,
      statusUpdateCount: statusUpdates.length,
    },
  };
}

function createApplySummary(statusUpdates) {
  return {
    applied: 0,
    skipped: 0,
    unsupported: 0,
    statusUpdates: statusUpdates.length,
  };
}

async function applyStatusUpdatesWithRecords(statusUpdates, targetRecords, tenantId, summary) {
  for (const update of statusUpdates) {
    if (update.status !== 'stale') {
      summary.unsupported++;
      summary.skipped++;
      continue;
    }
    const row = await targetRecords.updateMemoryStatusIfCurrent({
      tenantId,
      memoryId: update.memoryId,
      fromStatus: 'active',
      status: 'stale',
      validTo: update.validTo || null,
    });
    if (row) summary.applied++;
    else summary.skipped++;
  }
  return summary;
}

function summarizePromotionResults(results = []) {
  const summary = {
    candidates: results.length,
    planned: 0,
    promoted: 0,
    quarantined: 0,
    skipped: 0,
    errored: 0,
    reasons: {},
  };
  for (const result of results) {
    const action = result && result.action ? result.action : 'error';
    const reason = result && result.reason ? result.reason : 'unknown';
    if (action === 'planned') summary.planned++;
    else if (action === 'promote') summary.promoted++;
    else if (action === 'quarantine') summary.quarantined++;
    else if (action === 'error') summary.errored++;
    else summary.skipped++;
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
  }
  return summary;
}

function normalizeCandidateLineage(candidate = {}) {
  const payload = candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : {};
  const sourceCanonicalKeys = Array.isArray(payload.sourceCanonicalKeys)
    ? payload.sourceCanonicalKeys.map(key => String(key || '')).filter(Boolean)
    : [];
  const rawSourceMemoryIds = Array.isArray(payload.sourceMemoryIds) ? payload.sourceMemoryIds : [];
  const sourceMemoryIds = rawSourceMemoryIds
    .filter(id => id !== null && id !== undefined)
    .map(id => Number(id));

  if (sourceMemoryIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('memory.consolidation.compaction_candidates requires positive integer sourceMemoryIds');
  }
  if (sourceMemoryIds.length !== sourceCanonicalKeys.length) {
    throw new Error('memory.consolidation.compaction_candidates requires one sourceMemoryId for each sourceCanonicalKey');
  }

  return { payload, sourceMemoryIds, sourceCanonicalKeys };
}

function classifySkippedRun(existingRun, plan) {
  if (!existingRun) return 'claim_not_acquired';
  const sameSnapshot = existingRun.input_hash === plan.inputHash;
  if (sameSnapshot && existingRun.status === 'applied') return 'already_applied';
  if (sameSnapshot && existingRun.status === 'applying') return 'already_claimed';
  if (existingRun.status === 'applied' || existingRun.status === 'applying') return 'window_winner_exists';
  return 'claim_not_acquired';
}

function planCompaction(records = [], opts = {}) {
  const { cadence, periodStart, periodEnd, endMs } = requirePeriod(opts);
  const normalized = records.map(normalizeRecord).sort((a, b) => {
    if (a.canonicalKey !== b.canonicalKey) return a.canonicalKey.localeCompare(b.canonicalKey);
    return String(a.id).localeCompare(String(b.id));
  });
  const inputHash = hashSnapshot({
    cadence,
    periodStart,
    periodEnd,
    policyVersion: opts.policyVersion || 'v1',
    records: normalized,
  });

  const statusUpdates = [];
  for (const record of normalized) {
    if (record.status !== 'active') continue;
    if (record.memoryType !== 'open_loop') continue;
    const validTo = timeMs(record.validTo);
    const staleAfter = timeMs(record.staleAfter);
    if ((validTo !== null && validTo <= endMs) || (staleAfter !== null && staleAfter <= endMs)) {
      statusUpdates.push({
        memoryId: record.id,
        canonicalKey: record.canonicalKey,
        status: 'stale',
        reason: validTo !== null && validTo <= endMs ? 'valid_to_elapsed' : 'stale_after_elapsed',
      });
    }
  }
  const candidates = buildAggregateCandidates(normalized, statusUpdates, {
    ...opts,
    cadence,
    periodStart,
    periodEnd,
  });
  const synthesisInput = buildTimerSynthesisInput(normalized, statusUpdates, candidates, {
    ...opts,
    cadence,
    periodStart,
    periodEnd,
  });
  const coverage = buildCoverage(normalized, statusUpdates, candidates);

  return {
    cadence,
    periodStart,
    periodEnd,
    policyVersion: opts.policyVersion || 'v1',
    inputHash,
    candidates,
    synthesisInput,
    statusUpdates,
    sourceCoverage: coverage.sourceCoverage,
    outputCoverage: coverage.outputCoverage,
    meta: {
      activeConflictRate: 0,
      deterministic: true,
      recordCount: normalized.length,
      synthesisInput,
      sourceCoverage: coverage.sourceCoverage,
      outputCoverage: coverage.outputCoverage,
    },
  };
}

function distillArchiveSnapshot(snapshot = {}, opts = {}) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const candidates = [];
  for (const session of sessions) {
    const structuredSummary = session.structuredSummary || session.structured_summary || {};
    const sessionId = session.sessionId || session.session_id || session.id || null;
    const sourceRef = session.archiveRef || session.sourceRef || sessionId || 'archive';
    const extracted = extractCandidatesFromStructuredSummary({
      structuredSummary,
      sessionId,
      scopeKind: session.scopeKind || opts.scopeKind || 'session',
      scopeKey: session.scopeKey || (sessionId ? `session:${sessionId}` : opts.scopeKey || 'archive'),
      contextKey: session.contextKey || opts.contextKey || null,
      topicKey: session.topicKey || opts.topicKey || null,
      authority: opts.authority || 'raw_transcript',
      evidenceRefs: [{
        sourceKind: 'external',
        sourceRef,
        relationKind: 'imported_from',
        metadata: { archive: true },
      }],
    });
    for (const candidate of extracted) {
      candidates.push({
        ...candidate,
        status: 'candidate',
        visibleInBootstrap: false,
        visibleInRecall: false,
      });
    }
  }
  return {
    inputHash: hashSnapshot(snapshot),
    candidates: candidates.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey)),
    meta: {
      candidateCount: candidates.length,
      bypassedPromotion: false,
    },
  };
}

function createMemoryConsolidation({ pool, schema, defaultTenantId, records = null }) {
  function makeApplyToken() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
  }

  async function recordRunWith(queryable, input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    const plan = input.plan || input;
    const sourceCoverage = input.sourceCoverage || plan.sourceCoverage || plan.meta?.sourceCoverage || {};
    const outputCoverage = input.outputCoverage || plan.outputCoverage || plan.meta?.outputCoverage || {};
    const result = await queryable.query(
      `INSERT INTO ${schema}.compaction_runs (
         tenant_id, cadence, period_start, period_end, input_hash,
         policy_version, status, output, error, applied_at,
         source_coverage, output_coverage
       )
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'v1'),COALESCE($7,'planned'),COALESCE($8::jsonb,'{}'::jsonb),$9,$10,
               COALESCE($11::jsonb,'{}'::jsonb),COALESCE($12::jsonb,'{}'::jsonb))
       ON CONFLICT (tenant_id, cadence, period_start, period_end, input_hash, policy_version)
       DO UPDATE SET
         status = CASE
           WHEN compaction_runs.status IN ('applying','applied')
             AND EXCLUDED.status <> compaction_runs.status
           THEN compaction_runs.status
           ELSE EXCLUDED.status
         END,
         output = CASE
           WHEN compaction_runs.status IN ('applying','applied')
             AND EXCLUDED.status <> compaction_runs.status
           THEN compaction_runs.output
           ELSE EXCLUDED.output
         END,
         error = CASE
           WHEN compaction_runs.status IN ('applying','applied')
             AND EXCLUDED.status <> compaction_runs.status
           THEN compaction_runs.error
           ELSE EXCLUDED.error
         END,
         applied_at = CASE
           WHEN compaction_runs.status IN ('applying','applied')
             AND EXCLUDED.status <> compaction_runs.status
           THEN compaction_runs.applied_at
           ELSE EXCLUDED.applied_at
         END,
         source_coverage = CASE
           WHEN compaction_runs.status IN ('applying','applied')
             AND EXCLUDED.status <> compaction_runs.status
           THEN compaction_runs.source_coverage
           ELSE EXCLUDED.source_coverage
         END,
         output_coverage = CASE
           WHEN compaction_runs.status IN ('applying','applied')
             AND EXCLUDED.status <> compaction_runs.status
           THEN compaction_runs.output_coverage
           ELSE EXCLUDED.output_coverage
         END
       RETURNING *`,
      [
        tenantId,
        plan.cadence,
        plan.periodStart,
        plan.periodEnd,
        plan.inputHash,
        plan.policyVersion || 'v1',
        input.status || plan.status || 'planned',
        JSON.stringify(input.output || plan),
        input.error || null,
        input.appliedAt || null,
        JSON.stringify(sourceCoverage),
        JSON.stringify(outputCoverage),
      ]
    );
    return result.rows[0] || null;
  }

  async function recordRun(input = {}) {
    return recordRunWith(pool, input);
  }

  async function claimRunWith(queryable, input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    const plan = input.plan || input;
    const workerId = input.workerId || 'aquifer';
    const applyToken = input.applyToken || makeApplyToken();
    const claimLeaseSeconds = normalizeClaimLeaseSeconds(input.claimLeaseSeconds ?? input.staleAfterSeconds);
    const [lockKey1, lockKey2] = advisoryLockKeys(
      'aquifer.compaction_runs.claim_window',
      `${schema}:${tenantId}:${plan.cadence}:${canonicalInstant(plan.periodStart)}:${canonicalInstant(plan.periodEnd)}:${plan.policyVersion || 'v1'}`,
    );

    await queryable.query('SELECT pg_advisory_xact_lock($1, $2)', [lockKey1, lockKey2]);

    if (input.reclaimStaleClaims !== false) {
      await queryable.query(
        `UPDATE ${schema}.compaction_runs
            SET status = 'failed',
                error = COALESCE(error, 'claim lease expired before finalize'),
                reclaimed_at = transaction_timestamp(),
                reclaimed_by_worker_id = $6
          WHERE tenant_id = $1
            AND cadence = $2
            AND period_start = $3
            AND period_end = $4
            AND policy_version = $5
            AND status = 'applying'
            AND lease_expires_at < transaction_timestamp()
          RETURNING *`,
        [
          tenantId,
          plan.cadence,
          plan.periodStart,
          plan.periodEnd,
          plan.policyVersion || 'v1',
          workerId,
        ]
      );
    }

    await recordRunWith(queryable, {
      tenantId,
      plan,
      status: 'planned',
      output: input.output || plan,
      sourceCoverage: input.sourceCoverage || plan.sourceCoverage || plan.meta?.sourceCoverage || {},
      outputCoverage: input.outputCoverage || plan.outputCoverage || plan.meta?.outputCoverage || {},
    });

    const result = await queryable.query(
      `UPDATE ${schema}.compaction_runs AS cr
          SET status = 'applying',
              claimed_at = transaction_timestamp(),
              lease_expires_at = transaction_timestamp() + ($7::int * interval '1 second'),
              worker_id = $8,
              apply_token = $9
        WHERE cr.tenant_id = $1
          AND cr.cadence = $2
          AND cr.period_start = $3
          AND cr.period_end = $4
          AND cr.input_hash = $5
          AND cr.policy_version = $6
          AND cr.status = 'planned'
          AND NOT EXISTS (
            SELECT 1
              FROM ${schema}.compaction_runs other
             WHERE other.tenant_id = cr.tenant_id
               AND other.cadence = cr.cadence
               AND other.period_start = cr.period_start
               AND other.period_end = cr.period_end
               AND other.policy_version = cr.policy_version
               AND other.status IN ('applying','applied')
               AND other.id <> cr.id
          )
        RETURNING *`,
      [
        tenantId,
        plan.cadence,
        plan.periodStart,
        plan.periodEnd,
        plan.inputHash,
        plan.policyVersion || 'v1',
        claimLeaseSeconds,
        workerId,
        applyToken,
      ]
    );
    return result.rows[0] || null;
  }

  async function claimRun(input = {}) {
    if (pool && typeof pool.connect === 'function') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const claim = await claimRunWith(client, input);
        await client.query('COMMIT');
        return claim;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    return claimRunWith(pool, input);
  }

  async function finalizeClaimWith(queryable, input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    const plan = input.plan || input;
    const claim = input.claim || {};
    const status = input.status || 'applied';
    const sourceCoverage = input.sourceCoverage || plan.sourceCoverage || plan.meta?.sourceCoverage || {};
    const outputCoverage = input.outputCoverage || plan.outputCoverage || plan.meta?.outputCoverage || {};
    const result = await queryable.query(
      `UPDATE ${schema}.compaction_runs
          SET status = $4,
              output = COALESCE($5::jsonb,'{}'::jsonb),
              error = $6,
              applied_at = $7,
              source_coverage = COALESCE($8::jsonb,'{}'::jsonb),
              output_coverage = COALESCE($9::jsonb,'{}'::jsonb)
        WHERE tenant_id = $1
          AND id = $2
          AND apply_token = $3
          AND status = 'applying'
        RETURNING *`,
      [
        tenantId,
        claim.id,
        claim.apply_token || claim.applyToken || input.applyToken,
        status,
        JSON.stringify(input.output || plan),
        input.error || null,
        status === 'applied' ? (input.appliedAt || new Date().toISOString()) : null,
        JSON.stringify(sourceCoverage),
        JSON.stringify(outputCoverage),
      ]
    );
    return result.rows[0] || null;
  }

  async function recordCompactionCandidateResultsWith(queryable, input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    const run = input.run || input.claim || {};
    const candidates = input.candidates || [];
    const results = input.results || [];
    const rows = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i] || {};
      const result = results[i] || {};
      const { payload, sourceMemoryIds, sourceCanonicalKeys } = normalizeCandidateLineage(candidate);
      const candidateHash = candidate.candidateHash || payload.candidateHash || hashSnapshot(candidate);
      const inserted = await queryable.query(
        `INSERT INTO ${schema}.compaction_candidates (
           tenant_id, compaction_run_id, candidate_index, candidate_hash,
           action, reason, memory_type, canonical_key, scope_kind, scope_key,
           context_key, topic_key, summary, payload, source_memory_ids,
           source_canonical_keys, memory_record_id, fact_assertion_id
         )
         VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::jsonb,'{}'::jsonb),
           COALESCE($15::bigint[], ARRAY[]::bigint[]), COALESCE($16::jsonb,'[]'::jsonb), $17,$18
         )
         ON CONFLICT (tenant_id, compaction_run_id, candidate_index)
         DO UPDATE SET
           candidate_hash = EXCLUDED.candidate_hash,
           action = EXCLUDED.action,
           reason = EXCLUDED.reason,
           memory_type = EXCLUDED.memory_type,
           canonical_key = EXCLUDED.canonical_key,
           scope_kind = EXCLUDED.scope_kind,
           scope_key = EXCLUDED.scope_key,
           context_key = EXCLUDED.context_key,
           topic_key = EXCLUDED.topic_key,
           summary = EXCLUDED.summary,
           payload = EXCLUDED.payload,
           source_memory_ids = EXCLUDED.source_memory_ids,
           source_canonical_keys = EXCLUDED.source_canonical_keys,
           memory_record_id = COALESCE(EXCLUDED.memory_record_id, ${schema}.compaction_candidates.memory_record_id),
           fact_assertion_id = COALESCE(EXCLUDED.fact_assertion_id, ${schema}.compaction_candidates.fact_assertion_id),
           updated_at = now()
         RETURNING *`,
        [
          tenantId,
          run.id,
          i,
          candidateHash,
          result.action || 'error',
          result.reason || null,
          candidate.memoryType || candidate.memory_type || null,
          candidate.canonicalKey || candidate.canonical_key || null,
          candidate.scopeKind || candidate.scope_kind || null,
          candidate.scopeKey || candidate.scope_key || null,
          candidate.contextKey || candidate.context_key || null,
          candidate.topicKey || candidate.topic_key || null,
          candidate.summary || null,
          JSON.stringify(payload),
          sourceMemoryIds,
          JSON.stringify(sourceCanonicalKeys),
          result.memory ? result.memory.id : null,
          result.backingFact ? result.backingFact.id : null,
        ]
      );
      rows.push(inserted.rows[0] || null);
    }
    return rows;
  }

  async function applyPlan(input = {}) {
    const plan = input.plan || input;
    const tenantId = input.tenantId || defaultTenantId;
    const statusUpdates = Array.isArray(plan.statusUpdates) ? plan.statusUpdates : [];
    const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
    const appliedAt = input.appliedAt || new Date().toISOString();
    const summary = createApplySummary(statusUpdates);

    const applyWithRecords = async targetRecords => {
      return applyStatusUpdatesWithRecords(statusUpdates, targetRecords, tenantId, summary);
    };

    if (!records || typeof records.updateMemoryStatusIfCurrent !== 'function') {
      throw new Error('memory.consolidation.applyPlan requires records.updateMemoryStatusIfCurrent');
    }

    const runInput = status => {
      const output = {
        ...plan,
        applyResult: summary,
      };
      const outputCoverage = {
        ...(plan.outputCoverage || plan.meta?.outputCoverage || {}),
        appliedStatusUpdateCount: summary.applied,
        skippedStatusUpdateCount: summary.skipped,
        unsupportedStatusUpdateCount: summary.unsupported,
        plannedCandidateCount: candidates.length,
      };
      return {
        tenantId,
        plan,
        status,
        output,
        sourceCoverage: plan.sourceCoverage || plan.meta?.sourceCoverage || {},
        outputCoverage,
        appliedAt: status === 'applied' ? appliedAt : null,
      };
    };

    if (pool && typeof pool.connect === 'function') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const claim = await claimRunWith(client, {
          tenantId,
          plan,
          workerId: input.workerId,
          applyToken: input.applyToken,
          claimLeaseSeconds: input.claimLeaseSeconds,
          staleAfterSeconds: input.staleAfterSeconds,
          reclaimStaleClaims: input.reclaimStaleClaims,
        });
        if (!claim) {
          summary.skipped += statusUpdates.length;
          await client.query('COMMIT');
          return { status: 'skipped', run: null, claim: null, plan, applyResult: summary };
        }
        const txRecords = createMemoryRecords({
          pool: client,
          schema,
          defaultTenantId,
          inTransaction: true,
        });
        await applyWithRecords(txRecords);
        const candidateRows = candidates.length > 0
          ? await recordCompactionCandidateResultsWith(client, {
              tenantId,
              run: claim,
              candidates,
              results: candidates.map(candidate => ({
                candidate,
                action: 'planned',
                reason: 'promotion_not_requested',
              })),
            })
          : [];
        const status = summary.applied > 0 ? 'applied' : 'skipped';
        const run = await finalizeClaimWith(client, {
          ...runInput(status),
          claim,
        });
        if (!run) {
          throw new Error('memory.consolidation.applyPlan failed to finalize claimed run');
        }
        await client.query('COMMIT');
        return { status, run, claim, plan, applyResult: summary, candidateRows };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    if (typeof records.withTransaction === 'function') {
      await records.withTransaction(txRecords => applyWithRecords(txRecords));
    } else {
      await applyWithRecords(records);
    }

    const status = summary.applied > 0 ? 'applied' : 'skipped';
    const run = await recordRun(runInput(status));
    return { status, run, plan, applyResult: summary };
  }

  async function executePlan(input = {}) {
    const plan = input.plan || input;
    const tenantId = input.tenantId || defaultTenantId;
    const statusUpdates = Array.isArray(plan.statusUpdates) ? plan.statusUpdates : [];
    const candidates = Array.isArray(input.candidates) ? input.candidates : (Array.isArray(plan.candidates) ? plan.candidates : []);
    const appliedAt = input.appliedAt || new Date().toISOString();
    const promoteCandidates = input.promoteCandidates === true;
    const summary = createApplySummary(statusUpdates);

    if (!records || typeof records.updateMemoryStatusIfCurrent !== 'function') {
      throw new Error('memory.consolidation.executePlan requires records.updateMemoryStatusIfCurrent');
    }
    if (!pool || typeof pool.connect !== 'function') {
      throw new Error('memory.consolidation.executePlan requires DB pool transaction support');
    }

    const runInput = (status, promotionResult, outputCandidates) => {
      const output = {
        ...plan,
        candidates: outputCandidates,
        applyResult: summary,
        promotionResult,
      };
      const outputCoverage = {
        ...(plan.outputCoverage || plan.meta?.outputCoverage || {}),
        appliedStatusUpdateCount: summary.applied,
        skippedStatusUpdateCount: summary.skipped,
        unsupportedStatusUpdateCount: summary.unsupported,
        promotionCandidateCount: promotionResult.candidates,
        plannedCandidateCount: promotionResult.planned,
        promotedCandidateCount: promotionResult.promoted,
        quarantinedCandidateCount: promotionResult.quarantined,
        erroredCandidateCount: promotionResult.errored,
      };
      return {
        tenantId,
        plan,
        status,
        output,
        sourceCoverage: plan.sourceCoverage || plan.meta?.sourceCoverage || {},
        outputCoverage,
        appliedAt: status === 'applied' ? appliedAt : null,
      };
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claim = await claimRunWith(client, {
        tenantId,
        plan,
        workerId: input.workerId,
        applyToken: input.applyToken,
        claimLeaseSeconds: input.claimLeaseSeconds,
        staleAfterSeconds: input.staleAfterSeconds,
        reclaimStaleClaims: input.reclaimStaleClaims,
      });
      if (!claim) {
        summary.skipped += statusUpdates.length;
        await client.query('COMMIT');
        return {
          status: 'skipped',
          run: null,
          claim: null,
          plan,
          applyResult: summary,
          promotionResult: summarizePromotionResults([]),
          candidateRows: [],
        };
      }

      const txRecords = createMemoryRecords({
        pool: client,
        schema,
        defaultTenantId,
        inTransaction: true,
      });
      await applyStatusUpdatesWithRecords(statusUpdates, txRecords, tenantId, summary);

      const promotion = promoteCandidates ? createMemoryPromotion({ records: txRecords }) : null;
      const promotionResults = promoteCandidates && candidates.length > 0
        ? await promotion.promote(candidates, {
            tenantId,
            acceptedAt: input.acceptedAt || appliedAt,
            createdByCompactionRunId: claim.id,
          })
        : candidates.map(candidate => ({
            candidate,
            action: 'planned',
            reason: 'promotion_not_requested',
          }));
      const candidateRows = await recordCompactionCandidateResultsWith(client, {
        tenantId,
        run: claim,
        candidates,
        results: promotionResults,
      });
      const promotionResult = summarizePromotionResults(promotionResults);
      const status = summary.applied > 0 || promotionResult.promoted > 0 || promotionResult.planned > 0
        ? 'applied'
        : 'skipped';
      const run = await finalizeClaimWith(client, {
        ...runInput(status, promotionResult, candidates),
        claim,
      });
      if (!run) {
        throw new Error('memory.consolidation.executePlan failed to finalize claimed run');
      }
      await client.query('COMMIT');
      return {
        status,
        run,
        claim,
        plan,
        applyResult: summary,
        promotionResult,
        promotionResults,
        candidateRows,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadActiveSnapshot(input = {}) {
    if (!records || typeof records.listActive !== 'function') {
      throw new Error('memory.consolidation.runJob requires records.listActive');
    }

    const tenantId = input.tenantId || defaultTenantId;
    const scopeKeys = normalizeStringList(
      input.scopeKeys
      || input.scopeKey
      || input.activeScopeKey
      || input.activeScopePath
    );
    const limit = normalizeOperatorSnapshotLimit(input.snapshotLimit ?? input.limit);
    const rows = await records.listActive({
      tenantId,
      scopeId: input.scopeId,
      scopeKeys: scopeKeys.length > 0 ? scopeKeys : undefined,
      asOf: input.snapshotAsOf || input.asOf || undefined,
      limit,
    });
    return {
      rows,
      scopeKeys,
      snapshotAsOf: input.snapshotAsOf || input.asOf || null,
      snapshotLimit: limit,
      snapshotTruncated: rows.length >= limit,
    };
  }

  async function findExistingRun(input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    const plan = input.plan || input;
    const result = await pool.query(
      `SELECT *
         FROM ${schema}.compaction_runs
        WHERE tenant_id = $1
          AND cadence = $2
          AND period_start = $3
          AND period_end = $4
          AND policy_version = $5
        ORDER BY CASE
                   WHEN input_hash = $6 AND status = 'applied' THEN 0
                   WHEN status = 'applied' THEN 1
                   WHEN input_hash = $6 AND status = 'applying' THEN 2
                   WHEN status = 'applying' THEN 3
                   WHEN input_hash = $6 AND status = 'planned' THEN 4
                   ELSE 5
                 END,
                 id DESC
        LIMIT 1`,
      [
        tenantId,
        plan.cadence,
        plan.periodStart,
        plan.periodEnd,
        plan.policyVersion || 'v1',
        plan.inputHash,
      ]
    );
    return result.rows[0] || null;
  }

  async function runJob(input = {}) {
    const job = String(input.job || 'compaction').trim().toLowerCase();
    if (job === 'archive-distill') {
      if (input.apply === true || input.promoteCandidates === true) {
        throw new Error('memory.consolidation.runJob archive-distill is dry-run only');
      }
      const archiveSnapshot = input.archiveSnapshot || input.snapshot || null;
      if (!archiveSnapshot || typeof archiveSnapshot !== 'object') {
        throw new Error('memory.consolidation.runJob archive-distill requires archiveSnapshot');
      }
      const distill = distillArchiveSnapshot(archiveSnapshot, input);
      return {
        job,
        status: 'planned',
        dryRun: true,
        inputHash: distill.inputHash,
        candidates: distill.candidates,
        meta: distill.meta,
      };
    }

    const tenantId = input.tenantId || defaultTenantId;
    const window = resolveOperatorWindow(input);
    const snapshot = Array.isArray(input.records)
      ? {
          rows: input.records,
          scopeKeys: normalizeStringList(
            input.scopeKeys
            || input.scopeKey
            || input.activeScopeKey
            || input.activeScopePath
          ),
          snapshotAsOf: input.snapshotAsOf || input.asOf || window.periodEnd,
          snapshotLimit: Array.isArray(input.records) ? input.records.length : null,
          snapshotTruncated: false,
        }
      : await loadActiveSnapshot({
          tenantId,
          scopeId: input.scopeId,
          scopeKeys: input.scopeKeys || input.scopeKey || input.activeScopePath || input.activeScopeKey,
          snapshotAsOf: input.snapshotAsOf || input.asOf || window.periodEnd,
          snapshotLimit: input.snapshotLimit ?? input.limit,
        });
    const plan = planCompaction(snapshot.rows, {
      tenantId,
      cadence: window.cadence,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      policyVersion: input.policyVersion || 'v1',
    });

    if (input.apply !== true) {
      return {
        job,
        status: 'planned',
        dryRun: true,
        plan,
        cadence: plan.cadence,
        periodStart: plan.periodStart,
        periodEnd: plan.periodEnd,
        snapshotCount: snapshot.rows.length,
        snapshotLimit: snapshot.snapshotLimit,
        snapshotTruncated: snapshot.snapshotTruncated,
        snapshotAsOf: snapshot.snapshotAsOf,
        scopeKeys: snapshot.scopeKeys,
      };
    }

    const result = input.promoteCandidates === true
      ? await executePlan({
          plan,
          tenantId,
          workerId: input.workerId,
          applyToken: input.applyToken,
          appliedAt: input.appliedAt,
          promoteCandidates: true,
          claimLeaseSeconds: input.claimLeaseSeconds,
          reclaimStaleClaims: input.reclaimStaleClaims,
        })
      : await applyPlan({
          plan,
          tenantId,
          workerId: input.workerId,
          applyToken: input.applyToken,
          appliedAt: input.appliedAt,
          claimLeaseSeconds: input.claimLeaseSeconds,
          reclaimStaleClaims: input.reclaimStaleClaims,
        });
    const existingRun = result.run || await findExistingRun({ tenantId, plan });
    return {
      ...result,
      job,
      dryRun: false,
      cadence: plan.cadence,
      periodStart: plan.periodStart,
      periodEnd: plan.periodEnd,
      snapshotCount: snapshot.rows.length,
      snapshotLimit: snapshot.snapshotLimit,
      snapshotTruncated: snapshot.snapshotTruncated,
      snapshotAsOf: snapshot.snapshotAsOf,
      scopeKeys: snapshot.scopeKeys,
      existingRun,
      skipReason: result.run ? null : classifySkippedRun(existingRun, plan),
    };
  }

  return {
    plan: planCompaction,
    distillArchiveSnapshot,
    runJob,
    recordRun,
    claimRun,
    applyPlan,
    executePlan,
  };
}

module.exports = {
  stableJson,
  hashSnapshot,
  advisoryLockKeys,
  canonicalInstant,
  normalizeClaimLeaseSeconds,
  resolveOperatorWindow,
  planCompaction,
  buildTimerSynthesisInput,
  distillArchiveSnapshot,
  createMemoryConsolidation,
};
