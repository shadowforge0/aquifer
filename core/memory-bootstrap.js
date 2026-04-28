'use strict';

const TYPE_PRIORITY = {
  constraint: 0,
  state: 1,
  open_loop: 2,
  decision: 3,
  preference: 4,
  fact: 5,
  conclusion: 6,
  entity_note: 7,
};

const AUTHORITY_PRIORITY = {
  user_explicit: 0,
  executable_evidence: 1,
  manual: 2,
  system: 3,
  verified_summary: 4,
  llm_inference: 5,
  raw_transcript: 6,
};

function recordId(record) {
  return String(record.memoryId || record.memory_id || record.id || record.canonicalKey || record.canonical_key);
}

function scopeKey(record) {
  return record.scopeKey || record.scope_key || record.scope || '';
}

function inheritanceMode(record) {
  return record.inheritanceMode || record.inheritance_mode || record.scope_inheritance_mode || 'defaultable';
}

function canonicalKey(record) {
  return record.canonicalKey || record.canonical_key || recordId(record);
}

function parseTime(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

function isWithinTime(record, asOf) {
  if (!asOf) return true;
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return true;
  const validFrom = parseTime(record.validFrom || record.valid_from);
  const validTo = parseTime(record.validTo || record.valid_to);
  const staleAfter = parseTime(record.staleAfter || record.stale_after);
  if (validFrom !== null && validFrom > at) return false;
  if (validTo !== null && validTo <= at) return false;
  if (staleAfter !== null && staleAfter <= at) return false;
  return true;
}

function isActiveBootstrap(record, opts = {}) {
  return (record.status || 'candidate') === 'active'
    && (record.visibleInBootstrap ?? record.visible_in_bootstrap) === true
    && isWithinTime(record, opts.asOf);
}

function resolveApplicableRecords(records = [], opts = {}) {
  const activeScopePath = opts.activeScopePath || (opts.activeScopeKey ? [opts.activeScopeKey] : ['global']);
  const activeScope = opts.activeScopeKey || activeScopePath[activeScopePath.length - 1] || null;
  const position = new Map(activeScopePath.map((key, idx) => [key, idx]));
  const additive = [];
  const winners = new Map();

  for (const record of records) {
    const recScope = scopeKey(record);
    const mode = inheritanceMode(record);
    const isExact = activeScope && recScope === activeScope;
    const isInPath = position.has(recScope);
    if (mode === 'non_inheritable' && !isExact) continue;
    if (mode !== 'non_inheritable' && activeScopePath.length > 0 && !isInPath) continue;

    if (mode === 'additive') {
      additive.push(record);
      continue;
    }

    const key = canonicalKey(record);
    const existing = winners.get(key);
    if (!existing) {
      winners.set(key, record);
      continue;
    }

    const currentPos = position.get(recScope) ?? -1;
    const existingPos = position.get(scopeKey(existing)) ?? -1;
    if (currentPos > existingPos) winners.set(key, record);
  }

  return [...winners.values(), ...additive];
}

function sortForBootstrap(a, b, opts = {}) {
  const activeScopePath = opts.activeScopePath || (opts.activeScopeKey ? [opts.activeScopeKey] : ['global']);
  const position = new Map(activeScopePath.map((key, idx) => [key, idx]));
  const aScope = position.get(scopeKey(a)) ?? -1;
  const bScope = position.get(scopeKey(b)) ?? -1;
  if (bScope !== aScope) return bScope - aScope;

  const aType = TYPE_PRIORITY[a.memoryType || a.memory_type] ?? 99;
  const bType = TYPE_PRIORITY[b.memoryType || b.memory_type] ?? 99;
  if (aType !== bType) return aType - bType;

  const aAuth = AUTHORITY_PRIORITY[a.authority] ?? 99;
  const bAuth = AUTHORITY_PRIORITY[b.authority] ?? 99;
  if (aAuth !== bAuth) return aAuth - bAuth;

  const aAccepted = Date.parse(a.acceptedAt || a.accepted_at || '') || 0;
  const bAccepted = Date.parse(b.acceptedAt || b.accepted_at || '') || 0;
  if (aAccepted !== bAccepted) return bAccepted - aAccepted;

  return canonicalKey(a).localeCompare(canonicalKey(b));
}

function lineFor(record) {
  const type = record.memoryType || record.memory_type || 'memory';
  const text = record.summary || record.title || '';
  return `- ${type}: ${String(text).trim()}`;
}

function buildText(records, meta) {
  const lines = records.map(lineFor);
  return [
    `<memory-bootstrap memories="${records.length}" overflow="${meta.overflow}" degraded="${meta.degraded}">`,
    ...lines,
    '</memory-bootstrap>',
  ].join('\n');
}

function buildMemoryBootstrap(records = [], opts = {}) {
  const maxChars = Math.max(120, opts.maxChars || 4000);
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(100, Math.floor(opts.limit))) : null;
  const active = resolveApplicableRecords(
    records.filter(record => isActiveBootstrap(record, opts)),
    opts,
  ).sort((a, b) => sortForBootstrap(a, b, opts));

  const meta = {
    overflow: false,
    degraded: false,
    maxChars,
    count: active.length,
  };

  let selected = limit ? active.slice(0, limit) : active.slice();
  if (limit && active.length > limit) {
    meta.overflow = true;
    meta.degraded = true;
  }
  let text = buildText(selected, meta);
  while (text.length > maxChars && selected.length > 1) {
    selected = selected.slice(0, -1);
    meta.overflow = true;
    meta.degraded = true;
    text = buildText(selected, meta);
  }

  if (text.length > maxChars) {
    meta.overflow = true;
    meta.degraded = true;
  }

  const structured = {
    memories: selected,
    meta: { ...meta, count: selected.length },
  };

  if (opts.format === 'text') return { ...structured, text };
  if (opts.format === 'both' || opts.format === undefined) return { ...structured, text };
  return structured;
}

function createMemoryBootstrap({ records }) {
  async function bootstrap(opts = {}) {
    const requestedLimit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 50;
    const rows = await records.listActive({
      tenantId: opts.tenantId,
      scopeId: opts.scopeId,
      scopeKeys: opts.activeScopePath || (opts.activeScopeKey ? [opts.activeScopeKey] : undefined),
      visibleInBootstrap: true,
      asOf: opts.asOf,
      limit: Math.max(50, Math.min(200, requestedLimit * 4)),
    });
    return buildMemoryBootstrap(rows, opts);
  }

  return { bootstrap };
}

module.exports = {
  buildMemoryBootstrap,
  resolveApplicableRecords,
  createMemoryBootstrap,
};
