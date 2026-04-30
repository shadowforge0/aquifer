'use strict';

const path = require('node:path');

const SLOT_ORDER = ['host', 'workspace', 'project', 'repo', 'session', 'task'];
const PROMOTABLE_SLOT_IDS = new Set(['host', 'workspace', 'project', 'repo']);
const GENERIC_KEYS = new Set([
  '',
  'default',
  'global',
  'main',
  'na',
  'n/a',
  'none',
  'null',
  'unknown',
  'unset',
]);

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function collapseWhitespace(value) {
  const text = normalizeText(value);
  return text ? text.replace(/\s+/g, ' ') : null;
}

function slugify(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const slug = text
    .normalize('NFKD')
    .replace(/[^\w\s:/.-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return slug || null;
}

function isGenericKey(value) {
  const key = slugify(value) || String(value || '').trim().toLowerCase();
  return GENERIC_KEYS.has(key);
}

function toFactObject(value, aliases = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = normalizeText(value);
  if (!text) return null;
  const key = aliases[0] || 'value';
  return { [key]: text };
}

function pickValue(fact, keys = []) {
  if (!fact) return null;
  for (const key of keys) {
    const value = normalizeText(fact[key]);
    if (value) return value;
  }
  return null;
}

function pickLabel(fact, fallback) {
  return collapseWhitespace(pickValue(fact, ['label', 'title', 'name', 'displayName']) || fallback);
}

function normalizePrefixedScope(scopeKey, expectedPrefix) {
  const raw = normalizeText(scopeKey);
  if (!raw) return null;
  const match = raw.match(/^([a-z_]+):(.*)$/i);
  if (!match) return null;
  const [, prefix, rest] = match;
  if (prefix !== expectedPrefix) return null;
  const body = normalizeText(rest);
  if (!body) return null;
  return `${expectedPrefix}:${body}`;
}

function normalizePathScope(prefix, rawPath) {
  const value = normalizeText(rawPath);
  if (!value) return null;
  return `${prefix}:${path.resolve(value)}`;
}

function buildHostScope(rawFact) {
  const fact = toFactObject(rawFact, ['host']);
  if (!fact) return null;
  const fromScopeKey = normalizePrefixedScope(pickValue(fact, ['scopeKey', 'scope_key']), 'host_runtime');
  const key = fromScopeKey
    || (() => {
      const value = pickValue(fact, ['key', 'id', 'host', 'runtime', 'source', 'name', 'label']);
      if (!value || isGenericKey(value)) return null;
      const slug = slugify(value);
      return slug ? `host_runtime:${slug}` : null;
    })();
  if (!key) return null;
  return {
    id: 'host',
    slot: 'host',
    scopeKind: 'host_runtime',
    scopeKey: key,
    label: pickLabel(fact, key.slice('host_runtime:'.length)),
    raw: fact,
  };
}

function buildWorkspaceScope(rawFact) {
  const fact = toFactObject(rawFact, ['path']);
  if (!fact) return null;
  const fromScopeKey = normalizePrefixedScope(pickValue(fact, ['scopeKey', 'scope_key']), 'workspace');
  const key = fromScopeKey || normalizePathScope('workspace', pickValue(fact, ['path', 'workspacePath', 'root', 'id']));
  if (!key) return null;
  const scopePath = key.slice('workspace:'.length);
  return {
    id: 'workspace',
    slot: 'workspace',
    scopeKind: 'workspace',
    scopeKey: key,
    label: pickLabel(fact, scopePath),
    raw: fact,
  };
}

function buildProjectScope(rawFact) {
  const fact = toFactObject(rawFact, ['key']);
  if (!fact) return null;
  const fromScopeKey = normalizePrefixedScope(pickValue(fact, ['scopeKey', 'scope_key']), 'project');
  const key = fromScopeKey
    || (() => {
      const value = pickValue(fact, ['key', 'slug', 'projectKey', 'projectSlug', 'id', 'name', 'label']);
      if (!value || isGenericKey(value)) return null;
      const slug = slugify(value);
      return slug ? `project:${slug}` : null;
    })();
  if (!key) return null;
  return {
    id: 'project',
    slot: 'project',
    scopeKind: 'project',
    scopeKey: key,
    label: pickLabel(fact, key.slice('project:'.length)),
    raw: fact,
  };
}

function buildRepoScope(rawFact) {
  const fact = toFactObject(rawFact, ['path']);
  if (!fact) return null;
  const fromScopeKey = normalizePrefixedScope(pickValue(fact, ['scopeKey', 'scope_key']), 'repo');
  const key = fromScopeKey || normalizePathScope('repo', pickValue(fact, ['path', 'repoPath', 'root', 'repoRoot']));
  if (!key) return null;
  const repoPath = key.slice('repo:'.length);
  return {
    id: 'repo',
    slot: 'repo',
    scopeKind: 'repo',
    scopeKey: key,
    label: pickLabel(fact, path.basename(repoPath) || repoPath),
    raw: fact,
  };
}

function buildSessionScope(rawFact) {
  const fact = toFactObject(rawFact, ['id']);
  if (!fact) return null;
  const fromScopeKey = normalizePrefixedScope(pickValue(fact, ['scopeKey', 'scope_key']), 'session');
  const key = fromScopeKey
    || (() => {
      const value = pickValue(fact, ['id', 'key', 'sessionId', 'sessionKey']);
      return value ? `session:${value}` : null;
    })();
  if (!key) return null;
  return {
    id: 'session',
    slot: 'session',
    scopeKind: 'session',
    scopeKey: key,
    label: pickLabel(fact, key.slice('session:'.length)),
    raw: fact,
  };
}

function buildTaskScope(rawFact) {
  const fact = toFactObject(rawFact, ['id']);
  if (!fact) return null;
  const fromScopeKey = normalizePrefixedScope(pickValue(fact, ['scopeKey', 'scope_key']), 'task');
  const key = fromScopeKey
    || (() => {
      const value = pickValue(fact, ['id', 'key', 'taskId', 'taskKey']);
      return value ? `task:${value}` : null;
    })();
  if (!key) return null;
  return {
    id: 'task',
    slot: 'task',
    scopeKind: 'task',
    scopeKey: key,
    label: pickLabel(fact, key.slice('task:'.length)),
    raw: fact,
  };
}

function buildScopeForSlot(slotId, input) {
  switch (slotId) {
    case 'host':
      return buildHostScope(input.host || input.hostRuntime || input.source);
    case 'workspace':
      return buildWorkspaceScope(input.workspace || input.workspacePath);
    case 'project':
      return buildProjectScope(input.project || input.projectKey || input.projectSlug);
    case 'repo':
      return buildRepoScope(input.repo || input.repoPath);
    case 'session':
      return buildSessionScope(input.session || input.sessionId || input.sessionKey);
    case 'task':
      return buildTaskScope(input.task || input.taskId || input.taskKey);
    default:
      return null;
  }
}

function allowedScopeKeysForSlots(scopes) {
  const seen = new Set(['global']);
  const active = ['global'];
  return scopes.map((scope) => {
    if (PROMOTABLE_SLOT_IDS.has(scope.id) && !seen.has(scope.scopeKey)) {
      seen.add(scope.scopeKey);
      active.push(scope.scopeKey);
    }
    return active.slice();
  });
}

function buildScopeEnvelope(input = {}) {
  const scopes = [];
  const seenIds = new Set();

  for (const slotId of SLOT_ORDER) {
    const scope = buildScopeForSlot(slotId, input);
    if (!scope || seenIds.has(scope.id)) continue;
    seenIds.add(scope.id);
    scopes.push(scope);
  }

  const slotAllowedScopeKeys = allowedScopeKeysForSlots(scopes);
  const allowedScopeKeys = slotAllowedScopeKeys[slotAllowedScopeKeys.length - 1] || ['global'];
  const promotableScopes = scopes.filter(scope => PROMOTABLE_SLOT_IDS.has(scope.id));
  const activeScope = promotableScopes[promotableScopes.length - 1] || null;
  const slots = scopes.map((scope, index) => ({
    ...scope,
    promotable: PROMOTABLE_SLOT_IDS.has(scope.id),
    allowedScopeKeys: slotAllowedScopeKeys[index],
  }));
  const scopeById = Object.fromEntries(slots.map(scope => [scope.id, scope]));

  return {
    policyVersion: 'scope_envelope_v1',
    activeSlotId: activeScope ? activeScope.id : 'global',
    activeScopeKey: activeScope ? activeScope.scopeKey : 'global',
    allowedScopeKeys,
    slots,
    scopeById,
  };
}

function getScopeByEnvelopeId(envelope, id) {
  const scope = envelope && envelope.scopeById ? envelope.scopeById[id] : null;
  if (!scope) throw new Error(`Unknown scope envelope id: ${id}`);
  return scope;
}

module.exports = {
  buildScopeEnvelope,
  getScopeByEnvelopeId,
};
