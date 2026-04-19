'use strict';

// Miranda daily log renderer — reference implementation for the artifact
// capability (spec §12).
//
// Pulls the canonical state for a date from Aquifer (timeline events + latest
// state + active narrative + latest handoff) and renders it into a single
// markdown file. Pure logic — does not write to disk; returns the rendered
// string plus an artifact record declaration the caller can persist via
// aq.artifacts.record().
//
// Shape deliberately mirrors the historical Miranda daily-log format so the
// downstream consumers (CC, Discord pushes, weekly rollup) see no regression
// during the cutover from render-daily-log.js to this reference impl.

const crypto = require('crypto');

function startOfDayIso(dateStr) {
  return `${dateStr}T00:00:00Z`;
}

function endOfDayIso(dateStr) {
  return `${dateStr}T23:59:59.999Z`;
}

function ensureDate(input) {
  if (!input) throw new Error('date (YYYY-MM-DD) is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error(`date must match YYYY-MM-DD, got: ${input}`);
  }
  return input;
}

function renderSection(title, lines) {
  if (!lines || lines.length === 0) return null;
  return `## ${title}\n\n${lines.join('\n')}\n`;
}

function formatTimelineLine(evt) {
  const ts = new Date(evt.occurredAt).toISOString().slice(11, 16);
  const src = evt.sessionRef ? ` (${evt.sessionRef})` : '';
  return `- \`${ts}\`${src} ${evt.text}`;
}

function formatHandoff(payload) {
  if (!payload) return null;
  const lines = [];
  if (payload.last_step) lines.push(`**Last step.** ${payload.last_step}`);
  if (payload.status) lines.push(`**Status.** ${payload.status}`);
  if (payload.next) lines.push(`**Next.** ${payload.next}`);
  if (Array.isArray(payload.blockers) && payload.blockers.length > 0) {
    lines.push(`**Blockers.**`);
    for (const b of payload.blockers) lines.push(`- ${b}`);
  }
  if (Array.isArray(payload.open_loops) && payload.open_loops.length > 0) {
    lines.push(`**Open loops.**`);
    for (const l of payload.open_loops) lines.push(`- ${l}`);
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : null;
}

function formatState(state) {
  if (!state) return null;
  const lines = [];
  if (state.goal) lines.push(`**Goal.** ${state.goal}`);
  if (Array.isArray(state.active_work) && state.active_work.length > 0) {
    lines.push(`**Active work.**`);
    for (const w of state.active_work) lines.push(`- ${w}`);
  }
  if (state.affect && typeof state.affect === 'object') {
    const bits = [];
    if (state.affect.mood) bits.push(`mood: ${state.affect.mood}`);
    if (state.affect.energy) bits.push(`energy: ${state.affect.energy}`);
    if (state.affect.confidence) bits.push(`confidence: ${state.affect.confidence}`);
    if (bits.length > 0) lines.push(`**Affect.** ${bits.join(', ')}`);
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : null;
}

// -------------------------------------------------------------------------
// Public entry
// -------------------------------------------------------------------------
//
// renderDailyMd({ aquifer, date, agentId, tenantId?, categories? }) returns:
//   {
//     markdown: string,
//     artifact: { producerId, type, format, destination, payload,
//                 idempotencyKey }  // ready for aq.artifacts.record()
//   }
//
// The caller decides whether to persist the artifact record and where the
// rendered file lands. Aquifer itself doesn't touch disk.

async function renderDailyMd({
  aquifer, date, agentId, tenantId, categories,
  destinationTemplate = 'workspace://memory/{date}.md',
  producerId = 'miranda.workspace.daily-log',
}) {
  if (!aquifer) throw new Error('aquifer instance is required');
  if (!agentId) throw new Error('agentId is required');
  const day = ensureDate(date);

  const since = startOfDayIso(day);
  const until = endOfDayIso(day);

  const timelineResult = await aquifer.timeline.list({
    tenantId, agentId, categories, since, until, limit: 500,
  });
  if (!timelineResult.ok) throw new Error(`timeline.list failed: ${timelineResult.error.message}`);

  const stateResult = await aquifer.state.getLatest({ tenantId, agentId });
  if (!stateResult.ok) throw new Error(`state.getLatest failed: ${stateResult.error.message}`);

  const handoffResult = await aquifer.handoff.getLatest({ tenantId, agentId });
  if (!handoffResult.ok) throw new Error(`handoff.getLatest failed: ${handoffResult.error.message}`);

  const narrativeResult = await aquifer.narratives.getLatest({ tenantId, agentId });
  if (!narrativeResult.ok) throw new Error(`narratives.getLatest failed: ${narrativeResult.error.message}`);

  const events = (timelineResult.data.rows || []).slice().sort((a, b) =>
    new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

  // Group timeline by category.
  const grouped = new Map();
  for (const evt of events) {
    if (!grouped.has(evt.category)) grouped.set(evt.category, []);
    grouped.get(evt.category).push(evt);
  }

  const sections = [];
  sections.push(`# ${day}\n`);
  const stateBlock = formatState(stateResult.data.state);
  if (stateBlock) sections.push(`## State\n\n${stateBlock}`);

  if (narrativeResult.data.narrative) {
    sections.push(`## Narrative\n\n${narrativeResult.data.narrative.text}\n`);
  }

  const categoryOrder = ['focus', 'todo', 'mood', 'handoff', 'narrative',
    'organized', 'note', 'stats', 'health', 'garmin', 'weekly', 'monthly', 'cli'];
  const emitted = new Set();
  for (const cat of categoryOrder) {
    if (!grouped.has(cat)) continue;
    const lines = grouped.get(cat).map(formatTimelineLine);
    const sec = renderSection(cat.charAt(0).toUpperCase() + cat.slice(1), lines);
    if (sec) sections.push(sec);
    emitted.add(cat);
  }
  for (const [cat, evts] of grouped) {
    if (emitted.has(cat)) continue;
    const lines = evts.map(formatTimelineLine);
    const sec = renderSection(cat, lines);
    if (sec) sections.push(sec);
  }

  const handoffBlock = formatHandoff(handoffResult.data.handoff);
  if (handoffBlock) sections.push(`## Handoff\n\n${handoffBlock}`);

  const markdown = sections.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const destination = destinationTemplate.replace('{date}', day);
  const idempotencyKey = crypto.createHash('sha256')
    .update(`miranda:daily:${tenantId || 'default'}:${agentId}:${day}`)
    .digest('hex');

  return {
    markdown,
    artifact: {
      producerId,
      type: 'daily-log',
      format: 'markdown',
      destination,
      triggerPhase: 'artifact_dispatch',
      payload: {
        date: day,
        event_count: events.length,
        has_state: !!stateResult.data.state,
        has_handoff: !!handoffResult.data.handoff,
        has_narrative: !!narrativeResult.data.narrative,
      },
      idempotencyKey,
    },
  };
}

module.exports = { renderDailyMd };
