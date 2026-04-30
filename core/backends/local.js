'use strict';

const fs = require('fs/promises');
const path = require('path');
const { backendCapabilities, unsupportedCapabilityError } = require('./capabilities');

function emptyStore() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    nextId: 1,
    sessions: [],
  };
}

async function readStore(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...emptyStore(),
      ...parsed,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      nextId: Number.isInteger(parsed.nextId) && parsed.nextId > 0 ? parsed.nextId : 1,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyStore();
    throw err;
  }
}

async function writeStore(filePath, store) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const next = {
    ...store,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await fs.rename(tmp, filePath);
  return next;
}

function normalizeMessagesPayload(messages, opts = {}) {
  return opts.rawMessages || { normalized: messages };
}

function normalizedMessages(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.normalized)) return payload.normalized;
  if (Array.isArray(payload.messages)) return payload.messages;
  return [];
}

function messageText(message) {
  const content = message?.content ?? message?.text ?? '';
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function sessionText(session) {
  return normalizedMessages(session.messages)
    .map(messageText)
    .filter(Boolean)
    .join('\n');
}

function firstMatchingTurn(session, queryTerms) {
  const messages = normalizedMessages(session.messages);
  for (const message of messages) {
    const text = messageText(message);
    const lower = text.toLowerCase();
    if (queryTerms.some(term => lower.includes(term))) return text;
  }
  return messages.length > 0 ? messageText(messages[0]) : '';
}

function tokenizeQuery(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map(s => s.trim())
    .filter(Boolean);
}

function lexicalScore(text, query) {
  const lower = text.toLowerCase();
  const phrase = String(query || '').trim().toLowerCase();
  const terms = tokenizeQuery(query);
  if (!phrase && terms.length === 0) return 0;
  let score = phrase && lower.includes(phrase) ? 2 : 0;
  for (const term of terms) {
    let pos = 0;
    while (term && pos < lower.length) {
      const found = lower.indexOf(term, pos);
      if (found === -1) break;
      score += 1;
      pos = found + term.length;
    }
  }
  return score;
}

function inDateRange(session, opts = {}) {
  const started = session.startedAt ? new Date(session.startedAt).getTime() : null;
  if (opts.dateFrom) {
    const from = new Date(`${opts.dateFrom}T00:00:00.000Z`).getTime();
    if (Number.isFinite(from) && Number.isFinite(started) && started < from) return false;
  }
  if (opts.dateTo) {
    const to = new Date(`${opts.dateTo}T23:59:59.999Z`).getTime();
    if (Number.isFinite(to) && Number.isFinite(started) && started > to) return false;
  }
  return true;
}

function matchesSessionFilters(session, opts = {}) {
  if (opts.agentId && session.agentId !== opts.agentId) return false;
  if (Array.isArray(opts.agentIds) && opts.agentIds.length > 0 && !opts.agentIds.includes(session.agentId)) return false;
  if (opts.source && session.source !== opts.source) return false;
  return inDateRange(session, opts);
}

function sessionResult(session, score, queryTerms) {
  const matchedTurnText = firstMatchingTurn(session, queryTerms);
  const title = matchedTurnText || session.sessionId;
  return {
    id: session.id,
    sessionId: session.sessionId,
    agentId: session.agentId,
    source: session.source,
    startedAt: session.startedAt,
    summaryText: title,
    structuredSummary: {
      title: `Local session ${session.sessionId}`,
      overview: title,
    },
    matchedTurnText,
    score,
    backendKind: 'local',
    degraded: true,
  };
}

function bootstrapText(sessions, maxChars) {
  const lines = sessions.flatMap(session => {
    const text = sessionText(session).replace(/\s+/g, ' ').trim();
    return [
      `### ${session.sessionId} (${session.startedAt || 'unknown'}, ${session.agentId || 'agent'})`,
      text || '(no text)',
      '',
    ];
  });
  let text = lines.join('\n').trim();
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[truncated]`;
  return text;
}

function createLocalAquifer(config = {}) {
  const capabilities = backendCapabilities('local');
  const storage = config.storage || {};
  const local = storage.local || {};
  const backendPath = path.resolve(process.cwd(), local.path || '.aquifer/aquifer.local.json');
  const tenantId = config.tenantId || 'default';
  const memoryServingMode = config.memory?.servingMode || 'legacy';

  function unsupported(operation, capability) {
    throw unsupportedCapabilityError('local', capability, operation);
  }

  return {
    async init() {
      const store = await readStore(backendPath);
      await writeStore(backendPath, store);
      return { ready: true, status: 'ok', backend: capabilities, path: backendPath };
    },
    async migrate() {
      return { status: 'skipped', backendKind: 'local', reason: 'local backend has no SQL migrations' };
    },
    async commit(sessionId, messages, opts = {}) {
      if (!sessionId) throw new Error('sessionId is required');
      if (!messages || !Array.isArray(messages)) throw new Error('messages must be an array');
      const agentId = opts.agentId || 'agent';
      const source = opts.source || 'api';
      const now = new Date().toISOString();
      const payload = normalizeMessagesPayload(messages, opts);
      const msgCount = messages.length;
      const userCount = messages.filter(m => m.role === 'user').length;
      const assistantCount = messages.filter(m => m.role === 'assistant').length;
      const store = await readStore(backendPath);
      const idx = store.sessions.findIndex(s => (
        s.tenantId === tenantId && s.agentId === agentId && s.sessionId === sessionId
      ));
      const isNew = idx === -1;
      const previous = isNew ? null : store.sessions[idx];
      const session = {
        id: previous?.id || store.nextId++,
        tenantId,
        sessionId,
        sessionKey: opts.sessionKey || previous?.sessionKey || null,
        agentId,
        source,
        messages: payload,
        msgCount,
        userCount,
        assistantCount,
        model: opts.model || null,
        tokensIn: opts.tokensIn || 0,
        tokensOut: opts.tokensOut || 0,
        startedAt: opts.startedAt || previous?.startedAt || now,
        endedAt: opts.lastMessageAt || now,
        lastMessageAt: opts.lastMessageAt || now,
        processingStatus: 'ready',
      };
      if (isNew) store.sessions.push(session);
      else store.sessions[idx] = session;
      await writeStore(backendPath, store);
      return { id: session.id, sessionId, isNew };
    },
    async enrich(sessionId, opts = {}) {
      const agentId = opts.agentId || 'agent';
      const store = await readStore(backendPath);
      const session = store.sessions.find(s => (
        s.tenantId === tenantId && s.agentId === agentId && s.sessionId === sessionId
      ));
      if (!session) throw new Error(`Session not found: ${sessionId} (agentId=${agentId})`);
      session.processingStatus = 'ready';
      await writeStore(backendPath, store);
      return {
        sessionId,
        turnsEmbedded: 0,
        entitiesFound: 0,
        warnings: ['local backend uses lexical recall only; embeddings are not created'],
        backendKind: 'local',
        degraded: true,
      };
    },
    async recall(query, opts = {}) {
      if (opts.mode === 'vector') unsupported('recall', 'evidenceRecallVectorTurn');
      if (opts.entities) unsupported('recall entities filter', 'curatedRecall');
      const store = await readStore(backendPath);
      const terms = tokenizeQuery(query);
      const limit = Math.max(1, Math.min(20, opts.limit || 5));
      return store.sessions
        .filter(s => s.tenantId === tenantId)
        .filter(s => matchesSessionFilters(s, opts))
        .map(s => ({ session: s, score: lexicalScore(sessionText(s), query) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || String(b.session.startedAt).localeCompare(String(a.session.startedAt)))
        .slice(0, limit)
        .map(item => sessionResult(item.session, item.score, terms));
    },
    async memoryRecall() {
      unsupported('memoryRecall', 'curatedRecall');
    },
    async historicalRecall(query, opts = {}) {
      return this.recall(query, opts);
    },
    async evidenceRecall(query, opts = {}) {
      return this.recall(query, opts);
    },
    async bootstrap(opts = {}) {
      if (opts.memoryMode === 'curated' || opts.servingMode === 'curated' || memoryServingMode === 'curated') {
        unsupported('bootstrap curated memory', 'curatedBootstrap');
      }
      const limit = Math.max(1, Math.min(20, opts.limit || 5));
      const maxChars = Math.max(200, opts.maxChars || 4000);
      const store = await readStore(backendPath);
      const sessions = store.sessions
        .filter(s => s.tenantId === tenantId)
        .filter(s => matchesSessionFilters(s, opts))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, limit);
      const result = {
        sessions: sessions.map(s => sessionResult(s, 1, [])),
        meta: {
          backendKind: 'local',
          degraded: true,
          maxChars,
        },
      };
      if (opts.format !== 'structured') result.text = bootstrapText(sessions, maxChars);
      return result;
    },
    async memoryBootstrap() {
      unsupported('memoryBootstrap', 'curatedBootstrap');
    },
    async historicalBootstrap(opts = {}) {
      return this.bootstrap(opts);
    },
    async getStats() {
      const store = await readStore(backendPath);
      const sessions = store.sessions.filter(s => s.tenantId === tenantId);
      const counts = {};
      for (const session of sessions) {
        const status = session.processingStatus || 'ready';
        counts[status] = (counts[status] || 0) + 1;
      }
      const dates = sessions.map(s => s.startedAt).filter(Boolean).sort();
      return {
        backendKind: 'local',
        backendProfile: capabilities.profile,
        serving: {
          mode: memoryServingMode,
          activeScopeKey: null,
          activeScopePath: null,
        },
        sessions: counts,
        sessionTotal: sessions.length,
        summaries: 0,
        turnEmbeddings: 0,
        entities: 0,
        memoryRecords: {
          available: false,
          total: 0,
          active: 0,
          visibleInBootstrap: 0,
          visibleInRecall: 0,
          earliest: null,
          latest: null,
        },
        sessionFinalizations: {
          available: false,
          total: 0,
          statuses: {},
          latestFinalizedAt: null,
          latestUpdatedAt: null,
        },
        earliest: dates[0] || null,
        latest: dates[dates.length - 1] || null,
        degraded: true,
        capabilities: capabilities.capabilities,
      };
    },
    async getPendingSessions() {
      return [];
    },
    async exportSessions(opts = {}) {
      const limit = Math.max(1, opts.limit || 1000);
      const store = await readStore(backendPath);
      return store.sessions
        .filter(s => s.tenantId === tenantId)
        .filter(s => matchesSessionFilters(s, opts))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, limit)
        .map(s => ({
          session_id: s.sessionId,
          agent_id: s.agentId,
          source: s.source,
          started_at: s.startedAt,
          msg_count: s.msgCount,
          processing_status: s.processingStatus || 'ready',
          summary_text: null,
          structured_summary: null,
          messages: s.messages,
          backendKind: 'local',
        }));
    },
    async deleteSession(sessionId, opts = {}) {
      const agentId = opts.agentId || 'agent';
      const store = await readStore(backendPath);
      const before = store.sessions.length;
      store.sessions = store.sessions.filter(s => !(
        s.tenantId === tenantId && s.agentId === agentId && s.sessionId === sessionId
      ));
      await writeStore(backendPath, store);
      return { sessionId, deleted: before - store.sessions.length };
    },
    async feedback() {
      unsupported('feedback', 'finalizationLedger');
    },
    async memoryFeedback() {
      unsupported('memoryFeedback', 'curatedRecall');
    },
    async feedbackStats() {
      return {
        totalFeedback: 0,
        helpfulCount: 0,
        unhelpfulCount: 0,
        feedbackSessions: 0,
        totalSessions: (await this.getStats()).sessionTotal,
        trustScoreAvg: null,
        trustScoreMin: null,
        trustScoreMax: null,
      };
    },
    getConfig() {
      return {
        schema: null,
        tenantId,
        memoryServingMode,
        memoryActiveScopeKey: null,
        memoryActiveScopePath: null,
        backendKind: 'local',
        backendProfile: capabilities.profile,
        backendPath,
        capabilities: capabilities.capabilities,
      };
    },
    getCapabilities() {
      return backendCapabilities('local');
    },
    getPool() {
      return null;
    },
    getLlmFn() {
      return null;
    },
    getEmbedFn() {
      return null;
    },
    async close() {},
  };
}

module.exports = { createLocalAquifer };
