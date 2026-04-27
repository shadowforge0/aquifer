'use strict';

const { finalizeTranscriptView } = require('./codex');
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
    addUniqueByText(openLoops, { item: next, owner: 'Miranda', source: 'handoff_next' }, next);
  }
  for (const item of normalizeList(payload.openLoops || payload.open_loops)) {
    const loop = normalizeOpenLoop(item);
    if (loop) addUniqueByText(openLoops, loop, loop.item);
  }
  for (const item of normalizeList(payload.todoNew || payload.todo_new)) {
    const loop = normalizeOpenLoop({ item, owner: 'Miranda' });
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

async function finalizeHandoff(aquifer, payload = {}, opts = {}) {
  const view = opts.view || payload.view;
  if (!view || view.status !== 'ok') {
    throw new Error(`Codex handoff finalization requires an ok normalized transcript view; got ${view && view.status ? view.status : 'missing'}`);
  }
  const summary = opts.summary || payload.summary || {
    summaryText: opts.summaryText || payload.summaryText,
    structuredSummary: opts.structuredSummary || payload.structuredSummary,
  };
  const metadata = {
    ...buildHandoffMetadata(payload),
    ...(opts.metadata || {}),
  };
  const result = await finalizeTranscriptView(aquifer, view, summary, {
    ...opts,
    mode: 'handoff',
    metadataSource: 'codex_handoff',
    metadata,
    authority: opts.authority || 'manual',
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
  finalizeHandoff,
};
