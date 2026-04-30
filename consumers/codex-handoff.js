'use strict';

const crypto = require('crypto');

const {
  buildFinalizationPrompt,
  finalizeTranscriptView,
  resolveCurrentMemoryForFinalization,
  compactCurrentMemorySnapshot,
} = require('./codex');
const { buildFinalizationReview } = require('../core/finalization-review');

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function comparableText(value) {
  return normalizeText(value).replace(/[。.!?！？]+$/g, '').toLowerCase();
}

function addUniqueByText(out, item, text) {
  const key = comparableText(text);
  if (!key) return;
  if (out.some(existing => comparableText(existing.item || existing.decision || existing.conclusion || existing.note || existing.summary) === key)) return;
  out.push(item);
}

function normalizeDecision(item) {
  if (typeof item === 'string') {
    const decision = normalizeText(item);
    return decision ? { decision } : null;
  }
  const decision = normalizeText(item && (item.decision || item.summary || item.text));
  if (!decision) return null;
  const reason = normalizeText(item && item.reason);
  return reason ? { decision, reason } : { decision };
}

function normalizeOpenLoop(item) {
  if (typeof item === 'string') {
    const text = normalizeText(item);
    return text ? { item: text, owner: 'unknown' } : null;
  }
  const text = normalizeText(item && (item.item || item.summary || item.text));
  if (!text || ['none', 'n/a', 'na', 'done', '無'].includes(text.toLowerCase())) return null;
  return {
    item: text,
    owner: normalizeText(item && item.owner) || 'unknown',
  };
}

function buildHandoffMetadata(payload = {}) {
  const title = normalizeText(payload.title);
  const overview = normalizeText(payload.overview);
  const lastStep = normalizeText(payload.lastStep || payload.last_step);
  const next = normalizeText(payload.next);
  const handoffText = normalizeText(payload.handoffText || payload.handoff_text);
  const decisions = [];
  const openLoops = [];

  for (const item of normalizeList(payload.decisions)) {
    const decision = normalizeDecision(item);
    if (decision) addUniqueByText(decisions, decision, decision.decision);
  }
  for (const item of normalizeList(payload.decided)) {
    const decision = normalizeDecision(item);
    if (decision) addUniqueByText(decisions, decision, decision.decision);
  }
  if (next && next !== '無') {
    addUniqueByText(openLoops, { item: next, owner: 'unknown', source: 'handoff_next' }, next);
  }
  for (const item of normalizeList(payload.openLoops || payload.open_loops)) {
    const loop = normalizeOpenLoop(item);
    if (loop) addUniqueByText(openLoops, loop, loop.item);
  }
  for (const item of normalizeList(payload.todoNew || payload.todo_new)) {
    const loop = normalizeOpenLoop({ item, owner: 'unknown' });
    if (loop) addUniqueByText(openLoops, { ...loop, source: 'todo_new' }, loop.item);
  }

  return {
    source: 'codex_handoff',
    handoff: {
      title,
      overview,
      status: normalizeText(payload.status),
      stopReason: normalizeText(payload.stopReason || payload.stop_reason),
      lastStep,
      next,
      handoffText,
      topics: normalizeList(payload.topics),
      decisions,
      openLoops,
      focus: normalizeList(payload.focus).map(normalizeText).filter(Boolean),
      todoNew: normalizeList(payload.todoNew || payload.todo_new).map(normalizeText).filter(Boolean),
      todoDone: normalizeList(payload.todoDone || payload.todo_done).map(normalizeText).filter(Boolean),
    },
  };
}

function resolveHandoffSummary(payload = {}, opts = {}) {
  const synthesisSummary = opts.synthesisSummary
    || opts.handoffSynthesisSummary
    || payload.synthesisSummary
    || payload.handoffSynthesisSummary
    || null;
  if (synthesisSummary) {
    return {
      summary: synthesisSummary,
      candidates: Array.isArray(synthesisSummary.candidates) ? synthesisSummary.candidates : undefined,
      usedSynthesis: true,
    };
  }
  return {
    summary: opts.summary || payload.summary || {
      summaryText: opts.summaryText || payload.summaryText,
      structuredSummary: opts.structuredSummary || payload.structuredSummary,
    },
    candidates: Array.isArray(opts.candidates) ? opts.candidates : undefined,
    usedSynthesis: false,
  };
}

function formatHandoffContextBlock(metadata = {}) {
  const handoff = metadata.handoff || {};
  const lines = [
    `<handoff_context source="${metadata.source || 'codex_handoff'}">`,
    `title: ${handoff.title || 'untitled'}`,
    `overview: ${handoff.overview || 'none'}`,
    `status: ${handoff.status || 'unknown'}`,
    `lastStep: ${handoff.lastStep || 'none'}`,
    `next: ${handoff.next || 'none'}`,
  ];
  for (const decision of handoff.decisions || []) {
    lines.push(`decision: ${decision.decision}${decision.reason ? ` | ${decision.reason}` : ''}`);
  }
  for (const loop of handoff.openLoops || []) {
    lines.push(`open_loop: ${loop.item}${loop.owner ? ` | owner=${loop.owner}` : ''}`);
  }
  for (const topic of handoff.topics || []) {
    const name = normalizeText(topic && (topic.name || topic.topic || topic.title));
    const summary = normalizeText(topic && (topic.summary || topic.text));
    if (name || summary) lines.push(`topic: ${name || 'topic'}${summary ? ` | ${summary}` : ''}`);
  }
  lines.push('</handoff_context>');
  return lines.join('\n');
}

function normalizeCheckpointItem(item) {
  if (typeof item === 'string') return normalizeText(item);
  return normalizeText(item && (
    item.item
    || item.decision
    || item.state
    || item.constraint
    || item.conclusion
    || item.summary
    || item.text
  ));
}

function optionalNonNegativeInteger(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

function compactCheckpointRow(row = {}) {
  const structured = row.structuredSummary || row.structured_summary || row.payload?.structuredSummary || {};
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const coverage = row.coverage || row.coverageMetadata || row.coverage_metadata || row.metadata?.coverage || payload.coverage || {};
  const transcriptCoverage = coverage.transcript && typeof coverage.transcript === 'object'
    ? coverage.transcript
    : {};
  const summary = normalizeText(row.summaryText || row.summary_text || row.summary || row.payload?.summaryText);
  const scopeKey = normalizeText(row.scopeKey || row.scope_key || row.targetScopeKey || row.target_scope_key);
  const topicKey = normalizeText(row.topicKey || row.topic_key || row.topic || row.payload?.topicKey);
  const status = normalizeText(row.status || row.lifecycle || 'accepted_process_material');
  const trigger = normalizeText(row.trigger || row.triggerKind || row.trigger_kind || row.payload?.triggerKind);
  const bucket = {
    scopeKey,
    topicKey,
    status,
    trigger,
    summary,
    decisions: [],
    openLoops: [],
    states: [],
    constraints: [],
    conclusions: [],
    coverage: {
      coveredUntilMessageIndex: optionalNonNegativeInteger(
        coverage.coveredUntilMessageIndex,
        coverage.covered_until_message_index,
        coverage.messageIndex,
        coverage.message_index,
        row.coveredUntilMessageIndex,
        row.covered_until_message_index
      ),
      coveredUntilChar: optionalNonNegativeInteger(
        coverage.coveredUntilChar,
        coverage.coveredUntilCharIndex,
        coverage.covered_until_char,
        coverage.covered_until_char_index,
        row.coveredUntilChar,
        row.covered_until_char
      ),
      coveredUntilLine: optionalNonNegativeInteger(
        coverage.coveredUntilLine,
        coverage.coveredUntilLineIndex,
        coverage.covered_until_line,
        coverage.covered_until_line_index,
        coverage.line,
        coverage.lineIndex,
        coverage.line_index,
        transcriptCoverage.coveredUntilLine,
        transcriptCoverage.covered_until_line,
        transcriptCoverage.line,
        transcriptCoverage.lineIndex,
        transcriptCoverage.line_index,
        row.coveredUntilLine,
        row.covered_until_line
      ),
      coveredUntilLineChar: optionalNonNegativeInteger(
        coverage.coveredUntilLineChar,
        coverage.coveredUntilLineCharIndex,
        coverage.covered_until_line_char,
        coverage.covered_until_line_char_index,
        coverage.char,
        coverage.charIndex,
        coverage.char_index,
        transcriptCoverage.coveredUntilLineChar,
        transcriptCoverage.covered_until_line_char,
        transcriptCoverage.char,
        transcriptCoverage.charIndex,
        transcriptCoverage.char_index,
        row.coveredUntilLineChar,
        row.covered_until_line_char
      ),
    },
  };
  for (const item of normalizeList(structured.decisions || row.decisions)) {
    const text = normalizeCheckpointItem(item);
    if (text) addUniqueByText(bucket.decisions, { item: text }, text);
  }
  for (const item of normalizeList(structured.open_loops || structured.openLoops || row.openLoops || row.open_loops)) {
    const text = normalizeCheckpointItem(item);
    if (text) addUniqueByText(bucket.openLoops, { item: text }, text);
  }
  for (const item of normalizeList(structured.states || row.states)) {
    const text = normalizeCheckpointItem(item);
    if (text) addUniqueByText(bucket.states, { item: text }, text);
  }
  for (const item of normalizeList(structured.constraints || row.constraints)) {
    const text = normalizeCheckpointItem(item);
    if (text) addUniqueByText(bucket.constraints, { item: text }, text);
  }
  for (const item of normalizeList(structured.conclusions || row.conclusions)) {
    const text = normalizeCheckpointItem(item);
    if (text) addUniqueByText(bucket.conclusions, { item: text }, text);
  }
  return bucket;
}

function messageText(message = {}) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(part => typeof part === 'string' ? part : (part && (part.text || part.content) ? String(part.text || part.content) : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}

function renderMessages(messages = []) {
  return messages.map((message) => {
    const role = normalizeText(message.role) || 'message';
    return `[${role}]\n${messageText(message)}`;
  }).join('\n\n');
}

function approxPromptTokens(text) {
  return Math.ceil(String(text || '').length / 3);
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function offsetFromLineChar(text, lineIndex, charIndex) {
  if (typeof text !== 'string') return null;
  if (!Number.isInteger(lineIndex) || lineIndex < 0) return null;
  if (!Number.isInteger(charIndex) || charIndex < 0) return null;
  let offset = 0;
  let currentLine = 0;
  while (currentLine < lineIndex) {
    const lineBreak = text.indexOf('\n', offset);
    if (lineBreak === -1) return null;
    offset = lineBreak + 1;
    currentLine += 1;
  }
  const lineBreak = text.indexOf('\n', offset);
  const lineEnd = lineBreak === -1 ? text.length : lineBreak;
  if (charIndex > (lineEnd - offset)) return null;
  return offset + charIndex;
}

function compactCheckpointSnapshot(checkpoints = [], opts = {}) {
  const maxCheckpoints = Math.max(0, Math.min(12, opts.maxCheckpoints || opts.checkpointLimit || 6));
  const rows = Array.isArray(checkpoints?.checkpoints)
    ? checkpoints.checkpoints
    : (Array.isArray(checkpoints?.items) ? checkpoints.items : checkpoints);
  const compactRows = (Array.isArray(rows) ? rows : [])
    .map(compactCheckpointRow)
    .filter(row => row.summary || row.decisions.length || row.openLoops.length || row.states.length || row.constraints.length || row.conclusions.length)
    .slice(0, maxCheckpoints);
  return {
    checkpoints: compactRows,
    meta: {
      source: checkpoints?.meta?.source || 'checkpoint_runs',
      role: 'handoff_process_material',
      count: compactRows.length,
      truncated: Boolean(checkpoints?.meta?.truncated || (Array.isArray(rows) && rows.length > compactRows.length)),
    },
  };
}

function buildUncoveredTailView(view = {}, checkpoints = null) {
  const snapshot = compactCheckpointSnapshot(checkpoints || []);
  let coveredUntilMessageIndex = null;
  let coveredUntilChar = null;
  let coveredUntilLine = null;
  let coveredUntilLineChar = null;
  for (const row of snapshot.checkpoints) {
    const messageIndex = row.coverage.coveredUntilMessageIndex;
    if (Number.isInteger(messageIndex) && messageIndex >= 0) {
      coveredUntilMessageIndex = Math.max(coveredUntilMessageIndex ?? -1, messageIndex);
    }
    const charIndex = row.coverage.coveredUntilChar;
    if (Number.isInteger(charIndex) && charIndex >= 0) {
      coveredUntilChar = Math.max(coveredUntilChar ?? -1, charIndex);
    }
    const lineIndex = row.coverage.coveredUntilLine;
    const lineChar = row.coverage.coveredUntilLineChar;
    if (Number.isInteger(lineIndex) && lineIndex >= 0 && Number.isInteger(lineChar) && lineChar >= 0) {
      const shouldReplace = coveredUntilLine === null
        || lineIndex > coveredUntilLine
        || (lineIndex === coveredUntilLine && lineChar > coveredUntilLineChar);
      if (shouldReplace) {
        coveredUntilLine = lineIndex;
        coveredUntilLineChar = lineChar;
      }
    }
  }
  let bestTail = null;
  if (Number.isInteger(coveredUntilMessageIndex) && Array.isArray(view.messages)) {
    if (coveredUntilMessageIndex < view.messages.length) {
      const tailMessages = view.messages.slice(coveredUntilMessageIndex + 1);
      const text = renderMessages(tailMessages);
      bestTail = {
        ...view,
        messages: tailMessages,
        text,
        charCount: text.length,
        approxPromptTokens: approxPromptTokens(text),
        checkpointTail: {
          sourceMessageCount: view.messages.length,
          coveredUntilMessageIndex,
          tailMessageCount: tailMessages.length,
        },
      };
    }
  }
  if (Number.isInteger(coveredUntilChar) && typeof view.text === 'string') {
    if (coveredUntilChar <= view.text.length) {
      const text = view.text.slice(coveredUntilChar);
      const candidate = {
        ...view,
        text,
        charCount: text.length,
        approxPromptTokens: approxPromptTokens(text),
        checkpointTail: {
          sourceCharCount: view.text.length,
          coveredUntilChar,
          tailCharCount: text.length,
        },
      };
      if (!bestTail || candidate.text.length < bestTail.text.length) bestTail = candidate;
    }
  }
  if (Number.isInteger(coveredUntilLine) && Number.isInteger(coveredUntilLineChar) && typeof view.text === 'string') {
    const start = offsetFromLineChar(view.text, coveredUntilLine, coveredUntilLineChar);
    if (start !== null) {
      const text = view.text.slice(start);
      const candidate = {
        ...view,
        text,
        charCount: text.length,
        approxPromptTokens: approxPromptTokens(text),
        checkpointTail: {
          sourceCharCount: view.text.length,
          coveredUntilLine,
          coveredUntilLineChar,
          tailCharCount: text.length,
        },
      };
      if (!bestTail || candidate.text.length < bestTail.text.length) bestTail = candidate;
    }
  }
  return bestTail || view;
}

function formatCheckpointContextBlock(checkpoints = null, opts = {}) {
  const snapshot = compactCheckpointSnapshot(checkpoints || [], opts);
  if (snapshot.checkpoints.length === 0) return '';
  const lines = [
    `<checkpoint_context source="${snapshot.meta.source}" role="${snapshot.meta.role}" count="${snapshot.meta.count}" truncated="${snapshot.meta.truncated}">`,
    'Checkpoint context is producer process material, not current truth. Use it only to reduce transcript replay and reconcile against current_memory and the uncovered transcript tail.',
  ];
  for (const row of snapshot.checkpoints) {
    const attrs = [
      row.scopeKey ? `scope=${row.scopeKey}` : null,
      row.topicKey ? `topic=${row.topicKey}` : null,
      row.status ? `status=${row.status}` : null,
      row.trigger ? `trigger=${row.trigger}` : null,
    ].filter(Boolean).join(' ');
    lines.push(`checkpoint${attrs ? ` ${attrs}` : ''}: ${row.summary || 'process material'}`);
    for (const decision of row.decisions) lines.push(`  decision: ${decision.item}`);
    for (const state of row.states) lines.push(`  state: ${state.item}`);
    for (const constraint of row.constraints) lines.push(`  constraint: ${constraint.item}`);
    for (const conclusion of row.conclusions) lines.push(`  conclusion: ${conclusion.item}`);
    for (const loop of row.openLoops) lines.push(`  open_loop: ${loop.item}`);
  }
  lines.push('</checkpoint_context>');
  return lines.join('\n');
}

function compactPreviousBootstrapContext(input = null, opts = {}) {
  const source = input !== undefined && input !== null
    ? input
    : (opts.previousBootstrap !== undefined ? opts.previousBootstrap : null);
  if (!source) return null;
  const rawText = typeof source === 'string'
    ? source
    : normalizeText(source.text || source.context || source.sessionStartText || source.session_start_text || '');
  const memories = Array.isArray(source.memories) ? source.memories : [];
  const renderedMemories = memories
    .map(item => normalizeText(item && (item.summary || item.title || item.text || item.state || item.decision || item.item)))
    .filter(Boolean)
    .slice(0, 12);
  const text = rawText || renderedMemories.map(item => `- ${item}`).join('\n');
  if (!text) return null;
  const maxChars = Math.max(240, Math.min(6000, opts.previousBootstrapMaxChars || 3000));
  const clipped = text.length > maxChars ? text.slice(0, maxChars) : text;
  const meta = source && typeof source === 'object' && source.meta && typeof source.meta === 'object'
    ? source.meta
    : {};
  return {
    text: clipped,
    meta: {
      source: 'previous_bootstrap',
      originalSource: meta.source || source.source || null,
      activeScopePath: Array.isArray(meta.activeScopePath) ? meta.activeScopePath : undefined,
      truncated: text.length > clipped.length,
      hash: hashText(text),
    },
  };
}

function formatPreviousBootstrapContextBlock(previousBootstrap = null, opts = {}) {
  const compact = compactPreviousBootstrapContext(previousBootstrap, opts);
  if (!compact) return '';
  const lines = [
    `<previous_bootstrap_context source="${compact.meta.source}" truncated="${compact.meta.truncated}">`,
    'Previous bootstrap context is producer process material, not current truth. Use it to reconcile what should carry forward, close, supersede, or be dropped.',
    'Treat previous_bootstrap_context as producer process material and reconcile it against current_memory and the transcript before creating candidates.',
    compact.text,
    '</previous_bootstrap_context>',
  ];
  return lines.join('\n');
}

async function resolveCheckpointsForHandoff(aquifer, payload = {}, opts = {}) {
  if (opts.includeCheckpoints === false) return null;
  const provided = opts.checkpoints !== undefined ? opts.checkpoints : payload.checkpoints;
  if (provided !== undefined) return compactCheckpointSnapshot(provided, opts);
  const listFn = aquifer?.checkpoints?.listForHandoff || aquifer?.checkpoints?.listAcceptedForHandoff;
  if (typeof listFn !== 'function') return null;
  try {
    const rows = await listFn.call(aquifer.checkpoints, {
      tenantId: opts.tenantId,
      sessionId: payload.sessionId || opts.sessionId,
      activeScopeKey: opts.activeScopeKey || opts.scopeKey,
      activeScopePath: opts.activeScopePath,
      limit: opts.checkpointLimit || opts.maxCheckpoints || 6,
    });
    return compactCheckpointSnapshot(rows, opts);
  } catch (err) {
    return {
      checkpoints: [],
      meta: {
        source: 'checkpoint_runs',
        role: 'handoff_process_material',
        count: 0,
        truncated: false,
        degraded: true,
        error: err.message,
      },
    };
  }
}

async function resolvePreviousBootstrapForHandoff(aquifer, payload = {}, opts = {}) {
  if (opts.includePreviousBootstrap === false) return null;
  if (opts.previousBootstrap !== undefined) return compactPreviousBootstrapContext(opts.previousBootstrap, opts);
  if (payload.previousBootstrap !== undefined) return compactPreviousBootstrapContext(payload.previousBootstrap, opts);

  const bootstrapFn = typeof aquifer?.memory?.bootstrap === 'function'
    ? aquifer.memory.bootstrap
    : (typeof aquifer?.bootstrap === 'function' ? aquifer.bootstrap : null);
  if (typeof bootstrapFn !== 'function') return null;

  const bootstrapOwner = typeof aquifer?.memory?.bootstrap === 'function' ? aquifer.memory : aquifer;
  const bootstrapOpts = {
    tenantId: opts.tenantId,
    scopeId: opts.scopeId,
    activeScopeKey: opts.activeScopeKey || opts.scopeKey,
    activeScopePath: opts.activeScopePath,
    asOf: opts.previousBootstrapAsOf || opts.asOf,
    limit: opts.previousBootstrapLimit || opts.bootstrapLimit || 20,
    maxChars: opts.previousBootstrapMaxChars || 3000,
    format: 'both',
  };
  if (bootstrapOwner === aquifer) bootstrapOpts.servingMode = 'curated';
  try {
    const result = await bootstrapFn.call(bootstrapOwner, bootstrapOpts);
    return compactPreviousBootstrapContext(result, opts);
  } catch {
    return null;
  }
}

function buildHandoffSynthesisPrompt(payload = {}, view = {}, opts = {}) {
  if (!view || view.status !== 'ok') {
    throw new Error(`Codex handoff synthesis requires an ok normalized transcript view; got ${view && view.status ? view.status : 'missing'}`);
  }
  const metadata = buildHandoffMetadata(payload);
  const checkpoints = opts.checkpoints || payload.checkpoints;
  const previousBootstrap = opts.previousBootstrap !== undefined ? opts.previousBootstrap : payload.previousBootstrap;
  const promptView = buildUncoveredTailView(view, checkpoints);
  const basePrompt = buildFinalizationPrompt(promptView, opts);
  const checkpointBlock = formatCheckpointContextBlock(checkpoints, opts);
  const previousBootstrapBlock = formatPreviousBootstrapContextBlock(previousBootstrap, opts);
  const handoffBlock = [
    checkpointBlock,
    checkpointBlock ? '' : null,
    previousBootstrapBlock,
    previousBootstrapBlock ? '' : null,
    formatHandoffContextBlock(metadata),
    '',
    '<handoff_synthesis_rules>',
    'Treat handoff_context as producer process material, not current truth by itself.',
    'Treat checkpoint_context as producer process material, not current truth by itself.',
    'Treat previous_bootstrap_context as producer process material, not current truth by itself.',
    'Use the sanitized transcript and current_memory to decide what should become current memory candidates.',
    'When checkpoint_context is present, use it to avoid replaying already-covered session ranges, but reconcile it against the transcript tail instead of promoting it directly.',
    'When previous_bootstrap_context is present, use it only to reconcile carry-forward intent; do not copy it directly into current memory candidates.',
    'Do not copy old current_memory unchanged unless this session confirms it should carry forward.',
    'Represent resolved, superseded, revoked, or uncertain items explicitly in structuredSummary payload fields when applicable.',
    'Do not include raw transcript, tool output, debug ids, DB ids, hashes, secrets, or injected context in memory candidates.',
    '</handoff_synthesis_rules>',
  ].filter(line => line !== null && line !== undefined).join('\n');
  return basePrompt.replace('<sanitized_transcript>', `${handoffBlock}\n\n<sanitized_transcript>`);
}

async function prepareHandoffSynthesis(aquifer, payload = {}, opts = {}) {
  const view = opts.view || payload.view;
  if (!view || view.status !== 'ok') {
    throw new Error(`Codex handoff synthesis requires an ok normalized transcript view; got ${view && view.status ? view.status : 'missing'}`);
  }
  const currentMemory = await resolveCurrentMemoryForFinalization(aquifer, opts);
  const checkpoints = await resolveCheckpointsForHandoff(aquifer, payload, opts);
  const previousBootstrap = await resolvePreviousBootstrapForHandoff(aquifer, payload, opts);
  return {
    status: 'needs_agent_summary',
    outputSchemaVersion: 'handoff_current_memory_synthesis_v1',
    view,
    currentMemory,
    checkpoints,
    previousBootstrap,
    prompt: buildHandoffSynthesisPrompt(payload, view, { ...opts, currentMemory, checkpoints, previousBootstrap }),
  };
}

async function finalizeHandoff(aquifer, payload = {}, opts = {}) {
  const view = opts.view || payload.view;
  if (!view || view.status !== 'ok') {
    throw new Error(`Codex handoff finalization requires an ok normalized transcript view; got ${view && view.status ? view.status : 'missing'}`);
  }
  const { summary, candidates, usedSynthesis } = resolveHandoffSummary(payload, opts);
  const metadata = {
    ...buildHandoffMetadata(payload),
    ...(opts.metadata || {}),
  };
  if (usedSynthesis) {
    metadata.handoffSynthesis = {
      kind: 'handoff_current_memory_synthesis_v1',
      source: 'operator_reviewed_summary',
      promotionGate: 'core_finalization',
    };
  }
  const currentMemory = await resolveCurrentMemoryForFinalization(aquifer, opts);
  const checkpoints = await resolveCheckpointsForHandoff(aquifer, payload, opts);
  const previousBootstrap = await resolvePreviousBootstrapForHandoff(aquifer, payload, opts);
  if (currentMemory) metadata.currentMemory = compactCurrentMemorySnapshot(currentMemory, opts);
  if (checkpoints) metadata.checkpoints = checkpoints;
  const candidateEnvelope = usedSynthesis
    ? {
        version: 'handoff_current_memory_synthesis_v1',
        inputContext: {
          previousBootstrap: previousBootstrap ? previousBootstrap.meta : null,
          checkpoints: checkpoints ? checkpoints.meta : null,
          currentMemory: metadata.currentMemory ? metadata.currentMemory.meta : null,
        },
      }
    : opts.candidateEnvelope || null;
  const result = await finalizeTranscriptView(aquifer, view, summary, {
    ...opts,
    mode: 'handoff',
    metadataSource: 'codex_handoff',
    metadata,
    authority: opts.authority || (usedSynthesis ? 'verified_summary' : 'manual'),
    candidates,
    candidateEnvelope,
    coverage: opts.coverage || payload.coverage || null,
    candidatePayload: usedSynthesis
      ? {
          kind: 'handoff_synthesis',
          synthesisKind: 'handoff_current_memory_synthesis_v1',
          currentMemoryRole: 'handoff_synthesis_candidate',
          promotionGate: 'core_finalization',
        }
      : opts.candidatePayload || null,
  });
  const coreResult = result.finalization || {};
  const finalSummary = coreResult.summary || {
    summaryText: summary.summaryText,
    structuredSummary: summary.structuredSummary || {},
  };
  const memoryResult = coreResult.memoryResult || result.memoryResult || {};
  const memoryResults = coreResult.memoryResults || result.memoryResults || [];
  const reviewText = coreResult.humanReviewText || result.humanReviewText || buildFinalizationReview({
    summary: finalSummary,
    memoryResult,
    memoryResults,
    title: payload.title,
    overview: payload.overview,
    next: payload.next,
    sessionId: view.sessionId,
    transcriptHash: view.transcriptHash,
    finalization: coreResult.finalization || result.finalization,
  });
  return {
    ...result,
    finalization: coreResult.finalization || result.finalization,
    memoryResult,
    memoryResults,
    summary: finalSummary || result.summary || null,
    reviewText,
    humanReviewText: reviewText,
    sessionStartText: coreResult.sessionStartText || result.sessionStartText || '',
    structuredSummary: finalSummary.structuredSummary || {},
  };
}

module.exports = {
  buildHandoffMetadata,
  buildHandoffSynthesisPrompt,
  compactCheckpointSnapshot,
  buildUncoveredTailView,
  formatCheckpointContextBlock,
  compactPreviousBootstrapContext,
  formatPreviousBootstrapContextBlock,
  resolvePreviousBootstrapForHandoff,
  prepareHandoffSynthesis,
  resolveHandoffSummary,
  finalizeHandoff,
};
