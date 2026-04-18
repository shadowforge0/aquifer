'use strict';

/**
 * Aquifer Memory — OpenClaw Host Adapter
 *
 * Ingest adapter: auto-captures sessions on before_reset.
 * Tool adapter: exposes session_recall/session_feedback via OpenClaw registerTool().
 *
 * Status: COMPATIBILITY ONLY. The official tool delivery path is mcp.servers.aquifer
 * (see consumers/mcp.js). registerTool() exposure has OpenClaw upstream limitations
 * that prevent reliable tool visibility. This plugin is retained for before_reset
 * session capture; tool registration code is kept for future upstream fixes.
 *
 * Install: add to openclaw.json plugins or extensions directory.
 * Config via plugin config, environment variables, or aquifer.config.json.
 */

const { createAquiferFromConfig } = require('./shared/factory');
const { runIngest } = require('./shared/ingest');
const { formatRecallResults: sharedFormatRecallResults } = require('./shared/recall-format');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceRawEntries(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    if (item.role) return [item];
    if (item.message?.role) return [item.message];
    return [];
  });
}

function normalizeEntries(rawEntries) {
  const normalized = [];
  let userCount = 0, assistantCount = 0;
  let model = null, tokensIn = 0, tokensOut = 0;
  let startedAt = null, lastMessageAt = null;

  for (const entry of rawEntries) {
    if (!entry) continue;
    const msg = entry.message || entry;
    if (!msg || !msg.role) continue;
    if (!['user', 'assistant', 'system'].includes(msg.role)) continue;

    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text || '')
        .join('\n');
    }

    const ts = entry.timestamp || msg.timestamp || null;
    if (ts && !startedAt) startedAt = ts;
    if (ts) lastMessageAt = ts;

    if (msg.role === 'user') userCount++;
    if (msg.role === 'assistant') assistantCount++;
    if (msg.model && !model) model = msg.model;
    if (msg.usage) {
      tokensIn += msg.usage.input_tokens || msg.usage.input || 0;
      tokensOut += msg.usage.output_tokens || msg.usage.output || 0;
    }

    normalized.push({ role: msg.role, content, timestamp: ts });
  }

  return {
    messages: normalized,
    userCount,
    assistantCount,
    model,
    tokensIn,
    tokensOut,
    startedAt,
    lastMessageAt,
  };
}

// Thin adapter over the shared formatter. OpenClaw's tool output historically
// used "Matched:" instead of "Matched turn:" and joined with blank lines, so
// we supply a pair of renderer overrides to preserve that shape.
const formatRecallResults = (function () {
  const { createRecallFormatter } = require('./shared/recall-format');
  const _fmt = createRecallFormatter({
    header: () => null,
    matched: (r) => r.matchedTurnText ? `Matched: ${String(r.matchedTurnText).slice(0, 200)}` : null,
    separator: () => '',
  });
  return (results) => {
    if (!results || results.length === 0) return 'No matching sessions found.';
    return _fmt(results);
  };
})();
// Re-export the shared formatter too for callers that want the default shape.
formatRecallResults.shared = sharedFormatRecallResults;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function buildPlugin() {
  return {
    id: 'aquifer-memory',
    name: 'Aquifer Memory',
    register,
  };
}

module.exports = buildPlugin();
// Expose helpers for unit testing. Not part of the plugin's OpenClaw-visible
// contract; OpenClaw reads { id, name, register } only.
module.exports.normalizeEntries = normalizeEntries;
module.exports.coerceRawEntries = coerceRawEntries;

function register(api) {
    const pluginConfig = api.pluginConfig || {};

    // v1.2.0: delegate to a persona layer if one is configured, otherwise
    // run the generic default path (before_reset + session_recall + feedback).
    const personaPath = pluginConfig.persona || process.env.AQUIFER_PERSONA;
    if (personaPath) {
      try {
        const persona = require(personaPath);
        if (persona && typeof persona.mountOnOpenClaw === 'function') {
          persona.mountOnOpenClaw(api, pluginConfig);
          api.logger.info(`[aquifer-memory] registered via persona: ${personaPath}`);
          return;
        }
        api.logger.warn(`[aquifer-memory] persona at ${personaPath} lacks mountOnOpenClaw; falling back to default`);
      } catch (err) {
        api.logger.warn(`[aquifer-memory] failed to load persona ${personaPath}: ${err.message}; falling back to default`);
      }
    }

    let aquifer;
    try {
      aquifer = createAquiferFromConfig(pluginConfig);
    } catch (err) {
      api.logger.warn(`[aquifer-memory] disabled: ${err.message}`);
      return;
    }

    const minUserMessages = pluginConfig.minUserMessages || 3;
    const recentlyProcessed = new Map();
    const inFlight = new Set();

    // --- before_reset: auto-capture sessions ---

    api.on('before_reset', (event, ctx) => {
      const sessionId = ctx?.sessionId || event?.sessionId;
      const agentId = ctx?.agentId || pluginConfig.agentId || 'main';
      const sessionKey = ctx?.sessionKey || null;

      if (!sessionId) return;
      if ((sessionKey || '').includes('subagent')) return;
      if ((sessionKey || '').includes(':cron:')) return;

      const rawEntries = coerceRawEntries(event?.messages || []);
      if (rawEntries.length < 3) {
        api.logger.info(`[aquifer-memory] skip: ${sessionId} only ${rawEntries.length} msgs`);
        return;
      }

      api.logger.info(`[aquifer-memory] capturing ${sessionId} (${rawEntries.length} entries)`);

      (async () => {
        try {
          // OpenClaw hands us flat {role, content} entries; normalizeEntries
          // produces the commit-ready shape, which we feed to shared runIngest
          // as 'preNormalized' so commit+enrich+dedup stays host-agnostic.
          const norm = normalizeEntries(rawEntries);
          await runIngest({
            aquifer,
            sessionId,
            agentId,
            source: 'openclaw',
            sessionKey,
            adapter: 'preNormalized',
            preNormalized: norm,
            minUserMessages,
            dedupMap: recentlyProcessed,
            inFlight,
            logger: api.logger,
          });
        } catch (err) {
          api.logger.warn(`[aquifer-memory] capture failed for ${sessionId}: ${err.message}`);
        }
      })();
    });

    // --- session_recall tool ---

    api.registerTool((ctx) => {
      if ((ctx?.sessionKey || '').includes('subagent')) return null;

      return {
        name: 'session_recall',
        description: 'Search stored sessions by keyword. Supports entity intersection for precise multi-entity queries.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results (default 5, max 20)' },
            agentId: { type: 'string', description: 'Filter by agent ID' },
            source: { type: 'string', description: 'Filter by source' },
            dateFrom: { type: 'string', description: 'Start date YYYY-MM-DD' },
            dateTo: { type: 'string', description: 'End date YYYY-MM-DD' },
            entities: { type: 'array', items: { type: 'string' }, description: 'Entity names to match' },
            entityMode: { type: 'string', enum: ['any', 'all'], description: '"any" (default, boost) or "all" (only sessions with every entity)' },
            mode: { type: 'string', enum: ['fts', 'hybrid', 'vector'], description: 'Recall mode: "fts" (keyword only), "hybrid" (default), "vector" (vector only)' },
          },
          required: ['query'],
        },
        async execute(_toolCallId, params) {
          try {
            const limit = Math.max(1, Math.min(20, parseInt(params?.limit ?? 5, 10) || 5));
            const recallOpts = {
              limit,
              agentId: params.agentId || undefined,
              source: params.source || undefined,
              dateFrom: params.dateFrom || undefined,
              dateTo: params.dateTo || undefined,
            };
            if (Array.isArray(params.entities) && params.entities.length > 0) {
              recallOpts.entities = params.entities;
              recallOpts.entityMode = params.entityMode || 'any';
            }
            if (params.mode) recallOpts.mode = params.mode;

            const results = await aquifer.recall(params.query, recallOpts);
            const text = formatRecallResults(results);
            return { content: [{ type: 'text', text }] };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `session_recall error: ${err.message}` }],
              isError: true,
            };
          }
        },
      };
    }, { name: 'session_recall' });

    // --- session_feedback tool ---

    api.registerTool((ctx) => {
      if ((ctx?.sessionKey || '').includes('subagent')) return null;

      return {
        name: 'session_feedback',
        description: 'Record trust feedback on a recalled session. Helpful sessions rank higher in future recalls.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Session ID to give feedback on' },
            verdict: { type: 'string', enum: ['helpful', 'unhelpful'], description: 'Was the recalled session useful?' },
            note: { type: 'string', description: 'Optional reason' },
            agentId: { type: 'string', description: 'Agent ID the session was stored under (e.g. "main"). Defaults to context agent or "agent" if omitted.' },
          },
          required: ['sessionId', 'verdict'],
        },
        async execute(_toolCallId, params) {
          try {
            const resolvedAgentId = params.agentId || ctx?.agentId || undefined;
            const result = await aquifer.feedback(params.sessionId, {
              verdict: params.verdict,
              note: params.note || undefined,
              agentId: resolvedAgentId,
            });
            return {
              content: [{ type: 'text', text: `Feedback: ${result.verdict} (trust ${result.trustBefore.toFixed(2)} → ${result.trustAfter.toFixed(2)})` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `session_feedback error: ${err.message}` }],
              isError: true,
            };
          }
        },
      };
    }, { name: 'session_feedback' });

  api.logger.info('[aquifer-memory] registered (before_reset + session_recall + session_feedback)');
}
