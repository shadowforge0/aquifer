'use strict';

const DEFAULT_SUMMARY_MARKERS = [
  '===SESSION_ENTRIES===',
  '===EMOTIONAL_STATE===',
  '===RECAP===',
  '===ENTITIES===',
  '===WORKING_FACTS===',
  '===HANDOFF===',
];
const SUMMARY_MARKERS = DEFAULT_SUMMARY_MARKERS;

function parseSummaryOutput(output, markers = DEFAULT_SUMMARY_MARKERS) {
  const sections = {};
  for (let i = 0; i < markers.length; i++) {
    const start = output.indexOf(markers[i]);
    if (start === -1) continue;
    const contentStart = start + markers[i].length;
    let end = output.length;
    for (let j = i + 1; j < markers.length; j++) {
      const candidate = output.indexOf(markers[j], contentStart);
      if (candidate !== -1) { end = candidate; break; }
    }
    const key = markers[i].replace(/===/g, '').toLowerCase();
    sections[key] = (end > contentStart ? output.slice(contentStart, end) : output.slice(contentStart)).trim();
  }
  return sections;
}

function normalizeOpenOwner(raw) {
  const owner = (raw || 'unknown').trim().toLowerCase();
  if (['mk', 'agent', 'unknown'].includes(owner)) return owner;
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(owner)) return owner;
  return 'unknown';
}

function parseRecapLines(text) {
  const recap = {
    title: '', overview: '', topics: [], decisions: [], actions_completed: [],
    open_loops: [], files_mentioned: [], important_facts: [], reusable_patterns: [],
    focus_decision: 'keep', focus: '', todo_new: [], todo_done: [],
  };

  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([A-Z_]+):\s*(.*)/);
    if (!match) continue;
    const [, tag, value] = match;

    switch (tag) {
      case 'TITLE': recap.title = value; break;
      case 'OVERVIEW': recap.overview = value; break;
      case 'TOPIC': {
        const p = value.split('|').map(s => s.trim());
        if (p[0]) recap.topics.push({ name: p[0], summary: p[1] || '' });
        break;
      }
      case 'DECISION': {
        const p = value.split('|').map(s => s.trim());
        if (p[0]) recap.decisions.push({ decision: p[0], reason: p[1] || '' });
        break;
      }
      case 'ACTION': {
        const p = value.split('|').map(s => s.trim());
        if (p[0]) recap.actions_completed.push({
          action: p[0],
          status: (p[1] || 'done').toLowerCase() === 'partial' ? 'partial' : 'done',
        });
        break;
      }
      case 'OPEN': {
        const p = value.split('|').map(s => s.trim());
        if (p[0]) recap.open_loops.push({
          item: p[0],
          owner: normalizeOpenOwner(p[1]),
        });
        break;
      }
      case 'FACT': if (value) recap.important_facts.push(value); break;
      case 'PATTERN': {
        const p = value.split('|').map(s => s.trim());
        if (p[0] && p[1]) recap.reusable_patterns.push({
          pattern: p[0], trigger: p[1], action: p[2] || '',
          durability: (p[3] || 'derived').toLowerCase() === 'invariant' ? 'invariant' : 'derived',
        });
        break;
      }
      case 'FOCUS_DECISION':
        recap.focus_decision = value.toLowerCase().trim() === 'update' ? 'update' : 'keep';
        break;
      case 'FOCUS': recap.focus = value; break;
      case 'TODO_NEW': if (value) recap.todo_new.push(value); break;
      case 'TODO_DONE': if (value) recap.todo_done.push(value); break;
    }
  }
  return recap;
}

function parseWorkingFacts(text) {
  if (!text || typeof text !== 'string') return [];
  const facts = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^WFACT:\s*(.+?)\s*\|\s*(.+)/);
    if (!m) continue;
    const subject = m[1].trim().slice(0, 100);
    const statement = m[2].trim().slice(0, 500);
    if (!subject || !statement) continue;
    facts.push({ subject, statement });
    if (facts.length >= 5) break;
  }
  return facts;
}

const VALID_HANDOFF_STATUS = new Set(['in_progress', 'interrupted', 'completed', 'blocked']);
const VALID_STOP_REASON = new Set(['natural', 'interrupted', 'blocked', 'context_full']);

function normalizeEnum(raw, validSet) {
  const v = raw.trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
  return validSet.has(v) ? v : null;
}

function parseHandoffSection(text) {
  if (!text || typeof text !== 'string') return null;
  const handoff = { status: 'completed', lastStep: '', next: '', stopReason: 'natural', decided: '', blocker: '' };
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([A-Z_]+):\s*(.*)/);
    if (!m) continue;
    const [, tag, value] = m;
    switch (tag) {
      case 'STATUS': handoff.status = normalizeEnum(value, VALID_HANDOFF_STATUS) || 'completed'; break;
      case 'LAST_STEP': handoff.lastStep = value.trim().slice(0, 200); break;
      case 'NEXT': handoff.next = value.trim().slice(0, 200); break;
      case 'STOP_REASON': handoff.stopReason = normalizeEnum(value, VALID_STOP_REASON) || 'natural'; break;
      case 'DECIDED': handoff.decided = value.trim().slice(0, 200); break;
      case 'BLOCKER': handoff.blocker = value.trim().slice(0, 200); break;
    }
  }
  if (!handoff.lastStep || !handoff.next) return null;
  return handoff;
}

module.exports = {
  DEFAULT_SUMMARY_MARKERS,
  SUMMARY_MARKERS,
  parseSummaryOutput,
  parseRecapLines,
  parseWorkingFacts,
  parseHandoffSection,
  normalizeOpenOwner,
};
