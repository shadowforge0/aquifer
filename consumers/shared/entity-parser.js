'use strict';

// ---------------------------------------------------------------------------
// Entity section parser — shared across consumers.
//
// Parses LLM output lines of the form:
//   ENTITY: <name> | <type> | <alias1, alias2, ...>
//   RELATION: <src> | <dst>
//
// Returns { entities, relations } ready for Aquifer entityParseFn.
// Dedups, normalizes names via Aquifer's normalizeEntityName, and drops noise
// entities (generic roles, pure-numeric, file paths, CLI flags, etc.).
//
// Consumers that use a different ENTITIES prompt format should write their own
// parser — this one is for the ENTITY:/RELATION: line protocol.
// ---------------------------------------------------------------------------

// Import directly from core/entity to avoid a circular dep with top-level
// index.js, which itself re-exports parseEntitySection from here.
const { normalizeEntityName } = require('../../core/entity');

const VALID_ENTITY_TYPES = new Set([
  'person', 'project', 'concept', 'tool', 'metric',
  'org', 'place', 'event', 'doc', 'task', 'topic', 'other',
]);

const ENTITY_STOPLIST = new Set([
  // Role generics
  '助理', '使用者', '用戶', 'assistant', 'user', 'agent', 'agents', '我',
  // Too broad
  'api', 'db', 'llm', 'cli', 'bash', 'diff', 'bug', 'config',
  'extensions', 'hooks', 'cron', 'manifest', 'index.js', 'node.js',
  // Common noise
  'ok', 'timeout', 'error', 'test', 'cache', 'token',
  '登入狀態', '授權提示', 'chat_id', 'promise.race',
]);

const CODE_EXT_RE = /\.(js|ts|jsx|tsx|mjs|cjs|sh|py|sql|md|json|yml|yaml|css|html|vue|svelte|go|rs|rb|php|java|kt|c|cpp|h|toml|ini|cfg|conf|lock|env|proto)$/i;
const PATH_RE = /^[.\/~].*\//;
const DOTFILE_RE = /^\.[a-z][a-z0-9._-]*$/i;

function isNoiseEntity(normalizedName, rawName) {
  if (ENTITY_STOPLIST.has(normalizedName)) return true;
  if (/^\d+[秒分時天日月年kKgG%]/.test(rawName)) return true;
  if (/^\d{2,}[mM]/.test(rawName)) return true;
  if (/^\d+錯誤/.test(rawName)) return true;
  if (/^\d{10,}$/.test(rawName)) return true;
  if (normalizedName.length < 2) return true;
  if (PATH_RE.test(rawName)) return true;
  if (DOTFILE_RE.test(rawName)) return true;
  if (CODE_EXT_RE.test(rawName)) return true;
  if (/^--?\w/.test(rawName)) return true;
  return false;
}

function splitFields(line) {
  if (line.includes('|')) return line.split('|').map(s => s.trim());
  if (line.includes('\t')) return line.split('\t').map(s => s.trim());
  return [line.trim()];
}

function parseEntitySection(text, opts = {}) {
  if (!text || typeof text !== 'string') return { entities: [], relations: [] };

  const maxEntities = Number.isFinite(opts.maxEntities) ? opts.maxEntities : 10;
  const maxRelations = Number.isFinite(opts.maxRelations) ? opts.maxRelations : 15;

  const entityMap = new Map();
  const relationSet = new Set();
  const relations = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^ENTITY:/i.test(line)) {
      if (entityMap.size >= maxEntities) continue;
      const fields = splitFields(line.replace(/^ENTITY:\s*/i, ''));
      const rawName = (fields[0] || '').trim().slice(0, 200);
      if (!rawName) continue;
      const normalizedName = normalizeEntityName(rawName);
      if (!normalizedName || entityMap.has(normalizedName)) continue;
      if (isNoiseEntity(normalizedName, rawName)) continue;
      const rawType = (fields[1] || '').toLowerCase().trim();
      const type = VALID_ENTITY_TYPES.has(rawType) ? rawType : 'other';
      const rawAliases = fields[2] || '';
      const aliases = (rawAliases && rawAliases !== '-')
        ? rawAliases.split(',').map(a => a.trim().slice(0, 200)).filter(a => a && a !== '-')
        : [];
      entityMap.set(normalizedName, { name: rawName, normalizedName, type, aliases });
    } else if (/^RELATION:/i.test(line)) {
      if (relations.length >= maxRelations) continue;
      const fields = splitFields(line.replace(/^RELATION:\s*/i, ''));
      const src = (fields[0] || '').trim();
      const dst = (fields[1] || '').trim();
      if (!src || !dst) continue;
      const ns = normalizeEntityName(src);
      const nd = normalizeEntityName(dst);
      if (!ns || !nd || ns === nd) continue;
      const pairKey = ns < nd ? `${ns}|||${nd}` : `${nd}|||${ns}`;
      if (relationSet.has(pairKey)) continue;
      relationSet.add(pairKey);
      relations.push({ src, dst });
    }
  }

  const filteredRelations = relations.filter(r =>
    entityMap.has(normalizeEntityName(r.src)) && entityMap.has(normalizeEntityName(r.dst))
  );

  return { entities: [...entityMap.values()], relations: filteredRelations };
}

module.exports = {
  parseEntitySection,
  isNoiseEntity,
  VALID_ENTITY_TYPES,
  ENTITY_STOPLIST,
};
