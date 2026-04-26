'use strict';

const TYPE_LABELS = {
  state: '狀態',
  decision: '決策',
  fact: '事實',
  preference: '偏好',
  constraint: '限制',
  entity_note: '註記',
  open_loop: '未完成',
  conclusion: '判斷',
};

const MEMORY_KEYS = [
  'summary',
  'title',
  'decision',
  'item',
  'conclusion',
  'statement',
  'fact',
  'preference',
  'constraint',
  'state',
  'note',
  'text',
  'value',
];

const STRUCTURED_FIELDS = [
  ['states', 'state'],
  ['state', 'state'],
  ['decisions', 'decision'],
  ['important_facts', 'fact'],
  ['facts', 'fact'],
  ['preferences', 'preference'],
  ['constraints', 'constraint'],
  ['conclusions', 'conclusion'],
  ['entity_notes', 'entity_note'],
  ['open_loops', 'open_loop'],
];

const DEFAULT_OMIT = [
  '整段逐字稿、工具輸出、debug 訊息',
  'DB row id、hash、message count 這類 audit 欄位',
  '已作廢、隔離、錯誤或 superseded 的記憶',
];

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function sanitizeHumanText(value) {
  return normalizeText(value)
    .replace(/\bDB Write Plan\b/g, 'DB 寫入計畫')
    .replace(/\bLegacy Continuity Text\b/g, '舊 handoff 包裝文字')
    .replace(/\bStructured Summary\b/g, 'structured summary 原始欄位')
    .replace(/\braw JSON\b/gi, '原始 JSON');
}

function stripTerminalPunctuation(value) {
  return normalizeText(value).replace(/[。.!?！？]+$/g, '');
}

function comparable(value) {
  return stripTerminalPunctuation(value).toLowerCase();
}

function firstText(value) {
  if (typeof value === 'string') return normalizeText(value);
  if (!value || typeof value !== 'object') return '';
  for (const key of MEMORY_KEYS) {
    const text = normalizeText(value[key]);
    if (text) return text;
  }
  const payload = value.payload && typeof value.payload === 'object' ? value.payload : null;
  if (payload) return firstText(payload);
  return '';
}

function memoryTypeOf(value) {
  if (!value || typeof value !== 'object') return 'memory';
  return value.memoryType || value.memory_type || value.type || 'memory';
}

function labelFor(type) {
  return TYPE_LABELS[type] || TYPE_LABELS[String(type || '').toLowerCase()] || '記憶';
}

function pushUnique(out, text) {
  const normalized = sanitizeHumanText(text);
  if (!normalized) return;
  const key = comparable(normalized);
  if (!key || out.some(item => comparable(item) === key)) return;
  out.push(normalized);
}

function asLine(type, text, suffix = '') {
  const body = normalizeText(text);
  if (!body) return '';
  return `${labelFor(type)}：${body}${suffix}`;
}

function truncate(text, max = 220) {
  const normalized = sanitizeHumanText(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function addStructuredItems(out, structuredSummary = {}, filter = null) {
  for (const [field, type] of STRUCTURED_FIELDS) {
    if (filter && !filter(type)) continue;
    const items = Array.isArray(structuredSummary[field]) ? structuredSummary[field] : [];
    for (const item of items) {
      const text = firstText(item);
      if (!text) continue;
      const owner = type === 'open_loop' && item && typeof item === 'object' && normalizeText(item.owner)
        ? `（owner: ${normalizeText(item.owner)}）`
        : '';
      pushUnique(out, asLine(type, text, owner));
    }
  }
}

function promotedMemoryLines(memoryResults = []) {
  const lines = [];
  for (const result of memoryResults || []) {
    if (!result || result.action !== 'promote') continue;
    const memory = result.memory || result.record || result.candidate || {};
    const type = memoryTypeOf(memory);
    if (type === 'open_loop') continue;
    pushUnique(lines, asLine(type, firstText(memory)));
  }
  return lines;
}

function openLoopLines(memoryResults = [], structuredSummary = {}) {
  const lines = [];
  for (const result of memoryResults || []) {
    if (!result || result.action !== 'promote') continue;
    const memory = result.memory || result.record || result.candidate || {};
    const type = memoryTypeOf(memory);
    if (type !== 'open_loop') continue;
    const owner = normalizeText(memory.owner || memory.payload?.owner);
    pushUnique(lines, asLine(type, firstText(memory), owner ? `（owner: ${owner}）` : ''));
  }
  if (lines.length === 0) {
    addStructuredItems(lines, structuredSummary, type => type === 'open_loop');
  }
  return lines;
}

function inactiveLines(memoryResults = [], extraInactive = []) {
  const lines = [];
  for (const result of memoryResults || []) {
    if (!result || result.action === 'promote') continue;
    const candidate = result.candidate || result.memory || result.record || {};
    const text = firstText(candidate);
    const reason = normalizeText(result.reason);
    const action = normalizeText(result.action || 'skipped');
    if (text || reason) {
      pushUnique(lines, `${action}：${text || '未命名候選'}${reason ? `（${reason}）` : ''}`);
    }
  }
  for (const item of extraInactive || []) {
    const text = firstText(item);
    const status = normalizeText(item.status || item.action || 'inactive');
    const reason = normalizeText(item.reason || item.obsoleteReason || item.obsolete_reason);
    if (text || reason) {
      pushUnique(lines, `${status}：${text || '未命名記憶'}${reason ? `（${reason}）` : ''}`);
    }
  }
  return lines;
}

function linesOrNone(lines) {
  if (!lines || lines.length === 0) return '無';
  return lines.map(line => `- ${line}`).join('\n');
}

function buildAuditLines(input = {}) {
  const finalization = input.finalization || {};
  const memoryResult = input.memoryResult || {};
  const audit = input.audit || {};
  const pairs = [
    ['sessionId', audit.sessionId || input.sessionId],
    ['finalizationId', audit.finalizationId || finalization.id],
    ['handoffId', audit.handoffId || input.handoffId],
    ['transcriptHash', audit.transcriptHash || input.transcriptHash],
    ['promoted', memoryResult.promoted],
    ['quarantined', memoryResult.quarantined],
    ['skipped', memoryResult.skipped],
    ['policyVersion', audit.policyVersion || input.policyVersion],
    ['schemaVersion', audit.schemaVersion || input.schemaVersion],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  return pairs.map(([key, value]) => `${key}: ${value}`);
}

function collectRemembered(input = {}) {
  const structuredSummary = input.structuredSummary || input.summary?.structuredSummary || {};
  const memoryResults = input.memoryResults || [];
  const lines = promotedMemoryLines(memoryResults);
  if (lines.length === 0) {
    addStructuredItems(lines, structuredSummary, type => type !== 'open_loop');
  }
  return lines;
}

function buildCarryForwardLines(input = {}) {
  const lines = [];
  for (const line of input.openLoops || openLoopLines(input.memoryResults, input.structuredSummary || input.summary?.structuredSummary || {})) {
    pushUnique(lines, line);
  }
  const next = normalizeText(input.next || input.metadata?.handoff?.next);
  if (next && next !== '無') pushUnique(lines, `下一步：${next}`);
  return lines;
}

function buildFinalizationReview(input = {}, opts = {}) {
  const summary = input.summary || {};
  const structuredSummary = input.structuredSummary || summary.structuredSummary || {};
  const summaryText = input.summaryText || summary.summaryText || input.overview || '';
  const statusLine = truncate(input.currentStatus || summaryText || input.title || '已完成本段 finalization。');
  const remembered = collectRemembered({ ...input, structuredSummary });
  const openLoops = openLoopLines(input.memoryResults || [], structuredSummary);
  const inactive = inactiveLines(input.memoryResults || [], input.inactive || []);
  const carryForward = buildCarryForwardLines({ ...input, structuredSummary, openLoops });
  const omit = [];
  for (const item of opts.omit || input.omit || DEFAULT_OMIT) pushUnique(omit, item);
  const heading = opts.preview ? '準備整理進 DB：' : '已整理進 DB：';
  const lines = [
    heading,
    `目前狀態：\n${linesOrNone([statusLine])}`,
    `已記住：\n${linesOrNone(remembered)}`,
    `未完成：\n${linesOrNone(openLoops)}`,
    `已作廢或隔離：\n${linesOrNone(inactive)}`,
    `下一段只需要帶：\n${linesOrNone(carryForward)}`,
    `不要帶：\n${linesOrNone(omit)}`,
  ];
  if (opts.includeAudit === true) {
    lines.push(`Audit：\n${linesOrNone(buildAuditLines(input))}`);
  }
  return `${lines.join('\n\n')}\n`;
}

function buildSessionStartContext(records = [], opts = {}) {
  const asOf = opts.asOf ? Date.parse(opts.asOf) : null;
  const limit = Math.max(1, Math.min(50, opts.limit || 12));
  const maxChars = Math.max(120, opts.maxChars || 1800);
  const active = [];
  for (const [index, record] of (records || []).entries()) {
    const status = record.status || 'candidate';
    const visible = record.visibleInBootstrap ?? record.visible_in_bootstrap;
    if (status !== 'active' || visible !== true) continue;
    if (Number.isFinite(asOf)) {
      const validFrom = Date.parse(record.validFrom || record.valid_from || '');
      const validTo = Date.parse(record.validTo || record.valid_to || '');
      const staleAfter = Date.parse(record.staleAfter || record.stale_after || '');
      if (Number.isFinite(validFrom) && validFrom > asOf) continue;
      if (Number.isFinite(validTo) && validTo <= asOf) continue;
      if (Number.isFinite(staleAfter) && staleAfter <= asOf) continue;
    }
    active.push({ record, index });
  }

  active.sort((a, b) => {
    const aAccepted = Date.parse(a.record.acceptedAt || a.record.accepted_at || '') || 0;
    const bAccepted = Date.parse(b.record.acceptedAt || b.record.accepted_at || '') || 0;
    if (aAccepted !== bAccepted) return bAccepted - aAccepted;
    return a.index - b.index;
  });

  const lines = [];
  for (const { record } of active.slice(0, limit)) {
    const type = memoryTypeOf(record);
    pushUnique(lines, asLine(type, firstText(record)));
  }
  let selected = lines;
  let text = `下一段只需要帶：\n${linesOrNone(selected)}\n`;
  while (text.length > maxChars && selected.length > 1) {
    selected = selected.slice(0, -1);
    text = `下一段只需要帶：\n${linesOrNone(selected)}\n`;
  }
  return text;
}

module.exports = {
  buildFinalizationReview,
  buildSessionStartContext,
};
