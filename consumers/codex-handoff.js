'use strict';

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

function buildHandoffSynthesisPrompt(payload = {}, view = {}, opts = {}) {
  if (!view || view.status !== 'ok') {
    throw new Error(`Codex handoff synthesis requires an ok normalized transcript view; got ${view && view.status ? view.status : 'missing'}`);
  }
  const metadata = buildHandoffMetadata(payload);
  const basePrompt = buildFinalizationPrompt(view, opts);
  const handoffBlock = [
    formatHandoffContextBlock(metadata),
    '',
    '<handoff_synthesis_rules>',
    'Treat handoff_context as producer process material, not current truth by itself.',
    'Use the sanitized transcript and current_memory to decide what should become current memory candidates.',
    'Do not copy old current_memory unchanged unless this session confirms it should carry forward.',
    'Represent resolved, superseded, revoked, or uncertain items explicitly in structuredSummary payload fields when applicable.',
    'Do not include raw transcript, tool output, debug ids, DB ids, hashes, secrets, or injected context in memory candidates.',
    '</handoff_synthesis_rules>',
  ].join('\n');
  return basePrompt.replace('<sanitized_transcript>', `${handoffBlock}\n\n<sanitized_transcript>`);
}

async function prepareHandoffSynthesis(aquifer, payload = {}, opts = {}) {
  const view = opts.view || payload.view;
  if (!view || view.status !== 'ok') {
    throw new Error(`Codex handoff synthesis requires an ok normalized transcript view; got ${view && view.status ? view.status : 'missing'}`);
  }
  const currentMemory = await resolveCurrentMemoryForFinalization(aquifer, opts);
  return {
    status: 'needs_agent_summary',
    outputSchemaVersion: 'handoff_current_memory_synthesis_v1',
    view,
    currentMemory,
    prompt: buildHandoffSynthesisPrompt(payload, view, { ...opts, currentMemory }),
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
  if (currentMemory) metadata.currentMemory = compactCurrentMemorySnapshot(currentMemory, opts);
  const result = await finalizeTranscriptView(aquifer, view, summary, {
    ...opts,
    mode: 'handoff',
    metadataSource: 'codex_handoff',
    metadata,
    authority: opts.authority || (usedSynthesis ? 'verified_summary' : 'manual'),
    candidates,
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
  prepareHandoffSynthesis,
  resolveHandoffSummary,
  finalizeHandoff,
};
