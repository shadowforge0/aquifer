'use strict';

const storage = require('./storage');
const checkpointProducer = require('./session-checkpoint-producer');

function qi(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function clampLimit(value, fallback = 6, max = 50) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

function normalizeScopePath(input = {}) {
  const path = Array.isArray(input.activeScopePath)
    ? input.activeScopePath
    : (Array.isArray(input.scopePath) ? input.scopePath : []);
  const out = [];
  for (const value of path) {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  const active = String(input.activeScopeKey || input.scopeKey || '').trim();
  if (active && !out.includes(active)) out.push(active);
  return out;
}

function stableJson(value) {
  return checkpointProducer.stableJson(value);
}

function hashSnapshot(value) {
  return checkpointProducer.hashSnapshot(value);
}

function parsePositiveInt(value, fallback = 10, max = 200) {
  const n = Number(value === undefined || value === null || value === '' ? fallback : value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

function compactStructuredSummary(value = {}) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const key of ['facts', 'decisions', 'open_loops', 'openLoops', 'preferences', 'constraints', 'conclusions', 'entity_notes', 'entityNotes', 'states']) {
    const rows = Array.isArray(value[key]) ? value[key] : [];
    if (rows.length > 0) out[key] = rows.slice(0, 8);
  }
  return out;
}

function compactFinalizationRow(row = {}, index = 0) {
  return {
    index,
    finalizationId: row.id,
    sessionId: row.session_id || row.sessionId || null,
    source: row.source || null,
    agentId: row.agent_id || row.agentId || null,
    mode: row.mode || null,
    finalizedAt: row.finalized_at || row.finalizedAt || null,
    summaryText: String(row.summary_text || row.summaryText || '').replace(/\s+/g, ' ').trim(),
    structuredSummary: compactStructuredSummary(row.structured_summary || row.structuredSummary || {}),
    scopeId: row.scope_id || row.scopeId || null,
    scopeSnapshot: row.scope_snapshot || row.scopeSnapshot || {},
  };
}

function renderFinalizationCheckpointView(rows = [], input = {}) {
  const finalizations = rows.map(compactFinalizationRow);
  const text = finalizations.map((row, index) => {
    const lines = [
      `[finalization ${index + 1}]`,
      `mode: ${row.mode || 'unknown'}`,
      `summary: ${row.summaryText || 'none'}`,
    ];
    const structured = stableJson(row.structuredSummary || {});
    if (structured !== '{}') lines.push(`structuredSummary: ${structured}`);
    return lines.join('\n');
  }).join('\n\n');
  const transcriptHash = hashSnapshot({
    kind: 'checkpoint_finalization_view_v1',
    scopeId: input.scopeId || input.scope_id || null,
    range: {
      from: input.fromFinalizationIdExclusive ?? input.from_finalization_id_exclusive ?? 0,
      to: finalizations.length ? finalizations[finalizations.length - 1].finalizationId : null,
    },
    finalizations: finalizations.map(row => ({
      finalizationId: row.finalizationId,
      summaryText: row.summaryText,
      structuredSummary: row.structuredSummary,
    })),
  });
  return {
    status: 'ok',
    sessionId: input.sessionId || `checkpoint-scope-${input.scopeId || input.scope_id || 'unknown'}`,
    transcriptHash,
    messages: finalizations.map((row, index) => ({
      role: 'assistant',
      content: `[finalization ${index + 1}]\n${row.summaryText || stableJson(row.structuredSummary || {})}`,
    })),
    text,
    charCount: text.length,
    approxPromptTokens: Math.ceil(text.length / 3),
    finalizations,
    metadata: {
      source: 'session_finalizations',
      sourceOfTruth: 'finalized_session_summaries',
    },
  };
}

async function resolveScope(pool, input = {}, { schema, tenantId }) {
  if (input.scopeId || input.scope_id) {
    const result = await pool.query(
      `SELECT *
         FROM ${qi(schema)}.scopes
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1`,
      [tenantId, input.scopeId || input.scope_id],
    );
    const row = result.rows[0] || null;
    if (!row) throw new Error(`checkpoint scope not found: ${input.scopeId || input.scope_id}`);
    return row;
  }
  const scopeKey = String(input.scopeKey || input.scope_key || '').trim();
  if (!scopeKey) throw new Error('scopeId or scopeKey is required for checkpoint planning');
  const params = [tenantId, scopeKey];
  const where = ['tenant_id = $1', 'scope_key = $2'];
  if (input.scopeKind || input.scope_kind) {
    params.push(input.scopeKind || input.scope_kind);
    where.push(`scope_kind = $${params.length}`);
  }
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.scopes
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT 1`,
    params,
  );
  const row = result.rows[0] || null;
  if (!row) throw new Error(`checkpoint scope not found: ${scopeKey}`);
  return row;
}

function buildScopeEnvelopeFromScope(scope = {}) {
  const slotId = ['workspace', 'project', 'repo', 'host_runtime'].includes(scope.scope_kind)
    ? (scope.scope_kind === 'host_runtime' ? 'host' : scope.scope_kind)
    : 'target';
  const slot = {
    id: slotId,
    slot: slotId,
    scopeKind: scope.scope_kind,
    scopeKey: scope.scope_key,
    label: scope.scope_key,
    promotable: true,
    allowedScopeKeys: ['global', scope.scope_key].filter(Boolean),
  };
  return {
    policyVersion: 'scope_envelope_v1',
    activeSlotId: slot.id,
    activeScopeKey: scope.scope_key,
    allowedScopeKeys: slot.allowedScopeKeys,
    slots: [slot],
    scopeById: { [slot.id]: slot },
  };
}

async function findLatestCheckpoint(pool, input = {}, { schema, tenantId }) {
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.checkpoint_runs
      WHERE tenant_id = $1
        AND scope_id = $2
        AND status = ANY($3::text[])
        AND to_finalization_id_inclusive IS NOT NULL
      ORDER BY to_finalization_id_inclusive DESC, id DESC
      LIMIT 1`,
    [tenantId, input.scopeId || input.scope_id, ['processing', 'finalized']],
  );
  return result.rows[0] || null;
}

async function listFinalizationsForCheckpoint(pool, input = {}, { schema, tenantId }) {
  const params = [
    tenantId,
    input.scopeId || input.scope_id,
    input.fromFinalizationIdExclusive ?? input.from_finalization_id_exclusive ?? 0,
  ];
  const where = [
    'tenant_id = $1',
    'scope_id = $2',
    "status = 'finalized'",
    'id > $3',
  ];
  if (input.source) {
    params.push(input.source);
    where.push(`source = $${params.length}`);
  }
  if (input.agentId || input.agent_id) {
    params.push(input.agentId || input.agent_id);
    where.push(`agent_id = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(200, input.limit || 50)));
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.session_finalizations
      WHERE ${where.join(' AND ')}
      ORDER BY id ASC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

function mapCheckpointRun(row = {}) {
  const payload = row.checkpoint_payload && typeof row.checkpoint_payload === 'object'
    ? row.checkpoint_payload
    : {};
  return {
    id: row.id,
    checkpointKey: row.checkpoint_key,
    status: row.status,
    scopeId: row.scope_id,
    scopeKind: row.scope_kind || row.scope_snapshot?.scopeKind || null,
    scopeKey: row.scope_key || row.scope_snapshot?.scopeKey || null,
    fromFinalizationIdExclusive: row.from_finalization_id_exclusive ?? null,
    toFinalizationIdInclusive: row.to_finalization_id_inclusive ?? null,
    topicKey: payload.topicKey || payload.topic_key || row.scope_snapshot?.topicKey || null,
    triggerKind: payload.triggerKind || payload.trigger_kind || row.metadata?.triggerKind || row.metadata?.trigger_kind || null,
    summaryText: row.checkpoint_text || payload.summaryText || payload.summary || '',
    structuredSummary: payload.structuredSummary || payload.structured_summary || {},
    coverage: payload.coverage || {},
    metadata: {
      source: 'checkpoint_runs',
      checkpointKey: row.checkpoint_key,
      status: row.status,
    },
  };
}

function createSessionCheckpoints({ pool, schema, defaultTenantId = 'default' }) {
  async function planFromFinalizations(input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    const scope = await resolveScope(pool, input, { schema, tenantId });
    const minFinalizations = parsePositiveInt(
      input.minFinalizations || input.min_finalizations || input.checkpointEveryFinalizations,
      10,
      100,
    );
    const lastCheckpoint = input.fromFinalizationIdExclusive !== undefined || input.from_finalization_id_exclusive !== undefined
      ? null
      : await findLatestCheckpoint(pool, { scopeId: scope.id }, { schema, tenantId });
    const fromFinalizationIdExclusive = Number(
      input.fromFinalizationIdExclusive
      ?? input.from_finalization_id_exclusive
      ?? lastCheckpoint?.to_finalization_id_inclusive
      ?? 0
    );
    const finalizations = await listFinalizationsForCheckpoint(pool, {
      ...input,
      scopeId: scope.id,
      fromFinalizationIdExclusive,
      limit: Math.max(minFinalizations, parsePositiveInt(input.limit, minFinalizations, 200)),
    }, { schema, tenantId });
    const due = input.force === true || finalizations.length >= minFinalizations;
    const base = {
      status: due ? 'needs_agent_summary' : 'not_ready',
      due,
      triggerKind: input.triggerKind || input.trigger_kind || 'finalization_count',
      minFinalizations,
      sourceFinalizationCount: finalizations.length,
      scope: {
        id: scope.id,
        scopeKind: scope.scope_kind,
        scopeKey: scope.scope_key,
      },
      lastCheckpoint: lastCheckpoint ? mapCheckpointRun(lastCheckpoint) : null,
      fromFinalizationIdExclusive,
      finalizations: finalizations.map(compactFinalizationRow),
    };
    if (!due || finalizations.length === 0) return base;
    const toFinalizationIdInclusive = Number(finalizations[finalizations.length - 1].id);
    const view = renderFinalizationCheckpointView(finalizations, {
      scopeId: scope.id,
      fromFinalizationIdExclusive,
    });
    const scopeEnvelope = buildScopeEnvelopeFromScope(scope);
    const synthesisInput = checkpointProducer.buildCheckpointSynthesisInput({
      view,
      scopeEnvelope,
      targetScopeEnvelopeId: scopeEnvelope.activeSlotId,
      storageScopeId: scope.id,
      fromFinalizationIdExclusive,
      toFinalizationIdInclusive,
      sourceOfTruth: 'finalized_session_summaries',
      triggerKind: base.triggerKind,
      coverage: {
        coordinateSystem: 'checkpoint_finalization_view_v1',
        coveredUntilMessageIndex: Math.max(0, finalizations.length - 1),
        coveredUntilChar: view.text.length,
      },
      currentMemory: input.currentMemory || null,
      previousCheckpoints: lastCheckpoint ? [mapCheckpointRun(lastCheckpoint)] : [],
    }, input);
    return {
      ...base,
      range: {
        fromFinalizationIdExclusive,
        toFinalizationIdInclusive,
      },
      view,
      synthesisInput,
      synthesisPrompt: input.includeSynthesisPrompt === false
        ? undefined
        : checkpointProducer.buildCheckpointSynthesisPrompt(synthesisInput, input),
    };
  }

  async function runProducer(input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    const plan = await planFromFinalizations(input);
    const synthesisSummary = input.synthesisSummary || input.synthesis_summary || null;
    if (!plan.due || !synthesisSummary) return plan;
    const runInput = checkpointProducer.buildCheckpointRunInputFromSynthesis(
      plan.synthesisInput,
      synthesisSummary,
      {
        scopeId: plan.scope.id,
        status: input.finalize === true ? 'finalized' : (input.status || 'processing'),
        checkpointKey: input.checkpointKey || input.checkpoint_key,
      },
    );
    const shouldApply = input.apply === true;
    if (!shouldApply) {
      return {
        ...plan,
        runInput,
        dryRun: true,
      };
    }
    const run = await storage.upsertCheckpointRun(pool, {
      ...runInput,
      tenantId,
    }, { schema, tenantId });
    const sources = await storage.upsertCheckpointRunSources(pool, plan.finalizations.map((row, index) => ({
      finalizationId: row.finalizationId,
      sourceIndex: index,
      finalization: row,
    })), {
      checkpointRunId: run.id,
      tenantId,
    }, { schema, tenantId });
    return {
      ...plan,
      run,
      sources,
      dryRun: false,
    };
  }

  async function listForHandoff(input = {}) {
    const tenantId = input.tenantId || defaultTenantId;
    const limit = clampLimit(input.limit || input.checkpointLimit || input.maxCheckpoints);
    if (input.scopeId || input.scope_id) {
      const rows = await storage.listCheckpointRuns(pool, {
        tenantId,
        scopeId: input.scopeId || input.scope_id,
        status: input.status || 'finalized',
        limit,
      }, { schema, tenantId });
      return rows.map(mapCheckpointRun);
    }

    const scopePath = normalizeScopePath(input);
    if (scopePath.length === 0) return [];
    const result = await pool.query(
      `SELECT c.*, s.scope_kind, s.scope_key
         FROM ${qi(schema)}.checkpoint_runs c
         JOIN ${qi(schema)}.scopes s
           ON s.tenant_id = c.tenant_id
          AND s.id = c.scope_id
        WHERE c.tenant_id = $1
          AND c.status = $2
          AND s.scope_key = ANY($3::text[])
        ORDER BY array_position($3::text[], s.scope_key) DESC NULLS LAST,
                 c.finalized_at DESC NULLS LAST,
                 c.updated_at DESC,
                 c.id DESC
        LIMIT $4`,
      [tenantId, input.status || 'finalized', scopePath, limit]
    );
    return result.rows.map(mapCheckpointRun);
  }

  return {
    upsertRun: (input = {}) => storage.upsertCheckpointRun(pool, input, {
      schema,
      tenantId: input.tenantId || defaultTenantId,
    }),
    updateRunStatus: (input = {}) => storage.updateCheckpointRunStatus(pool, input, {
      schema,
      tenantId: input.tenantId || defaultTenantId,
    }),
    listRuns: (input = {}) => storage.listCheckpointRuns(pool, input, {
      schema,
      tenantId: input.tenantId || defaultTenantId,
    }),
    upsertSources: (rows = [], input = {}) => storage.upsertCheckpointRunSources(pool, rows, input, {
      schema,
      tenantId: input.tenantId || defaultTenantId,
    }),
    listSources: (input = {}) => storage.listCheckpointRunSources(pool, input, {
      schema,
      tenantId: input.tenantId || defaultTenantId,
    }),
    buildSynthesisInput: checkpointProducer.buildCheckpointSynthesisInput,
    buildSynthesisPrompt: checkpointProducer.buildCheckpointSynthesisPrompt,
    buildRunInputFromSynthesis: checkpointProducer.buildCheckpointRunInputFromSynthesis,
    planFromFinalizations,
    runProducer,
    listForHandoff,
    listAcceptedForHandoff: listForHandoff,
  };
}

module.exports = {
  createSessionCheckpoints,
  ...checkpointProducer,
};
