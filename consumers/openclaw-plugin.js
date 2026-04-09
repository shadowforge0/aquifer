'use strict';

/**
 * Aquifer Memory — OpenClaw Plugin
 *
 * Auto-captures sessions on before_reset and provides session_recall tool.
 * Install: add to openclaw.json plugins or extensions directory.
 *
 * Config via plugin config, environment variables, or aquifer.config.json.
 */

const { createAquiferFromConfig } = require('./shared/factory');

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

function formatRecallResults(results) {
  if (results.length === 0) return 'No matching sessions found.';

  return results.map((r, i) => {
    const ss = r.structuredSummary || {};
    const title = ss.title || r.summaryText?.slice(0, 60) || '(untitled)';
    const date = r.startedAt
      ? new Date(r.startedAt).toISOString().slice(0, 10)
      : 'unknown';

    const lines = [`### ${i + 1}. ${title} (${date}, ${r.agentId || 'default'})`];
    if (ss.overview || r.summaryText) {
      lines.push((ss.overview || r.summaryText).slice(0, 300));
    }
    if (r.matchedTurnText) {
      lines.push(`Matched: ${r.matchedTurnText.slice(0, 200)}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = {
  id: 'aquifer-memory',
  name: 'Aquifer Memory',

  register(api) {
    const pluginConfig = api.pluginConfig || {};
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

      const dedupKey = `${agentId}:${sessionId}`;
      if (recentlyProcessed.has(dedupKey) || inFlight.has(dedupKey)) return;

      const rawEntries = coerceRawEntries(event?.messages || []);
      if (rawEntries.length < 3) {
        api.logger.info(`[aquifer-memory] skip: ${sessionId} only ${rawEntries.length} msgs`);
        return;
      }

      inFlight.add(dedupKey);
      api.logger.info(`[aquifer-memory] capturing ${sessionId} (${rawEntries.length} entries)`);

      (async () => {
        try {
          const norm = normalizeEntries(rawEntries);
          if (norm.userCount === 0) {
            api.logger.info(`[aquifer-memory] skip: no user messages in ${sessionId}`);
            return;
          }

          // Commit
          await aquifer.commit(sessionId, norm.messages, {
            agentId,
            source: 'openclaw',
            sessionKey,
            model: norm.model,
            tokensIn: norm.tokensIn,
            tokensOut: norm.tokensOut,
            startedAt: norm.startedAt,
            lastMessageAt: norm.lastMessageAt,
          });
          api.logger.info(`[aquifer-memory] committed ${sessionId}`);

          // Enrich (if enough messages)
          if (norm.userCount >= minUserMessages) {
            try {
              const result = await aquifer.enrich(sessionId, { agentId });
              api.logger.info(`[aquifer-memory] enriched ${sessionId} (${result.turnsEmbedded} turns, ${result.entitiesFound} entities)`);
            } catch (enrichErr) {
              api.logger.warn(`[aquifer-memory] enrich failed for ${sessionId}: ${enrichErr.message}`);
            }
          }

          recentlyProcessed.set(dedupKey, Date.now());
        } catch (err) {
          api.logger.warn(`[aquifer-memory] capture failed for ${sessionId}: ${err.message}`);
        } finally {
          inFlight.delete(dedupKey);
          // Evict old entries
          if (recentlyProcessed.size > 200) {
            const cutoff = Date.now() - 30 * 60 * 1000;
            for (const [k, ts] of recentlyProcessed) {
              if (ts < cutoff) recentlyProcessed.delete(k);
            }
          }
        }
      })();
    });

    // --- session_recall tool ---

    api.registerTool((ctx) => {
      if ((ctx?.sessionKey || '').includes('subagent')) return null;

      return {
        name: 'session_recall',
        description: 'Search stored sessions by keyword, returning ranked summaries and matched conversation turns.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results (default 5, max 20)' },
            agentId: { type: 'string', description: 'Filter by agent ID' },
            source: { type: 'string', description: 'Filter by source' },
            dateFrom: { type: 'string', description: 'Start date YYYY-MM-DD' },
            dateTo: { type: 'string', description: 'End date YYYY-MM-DD' },
          },
          required: ['query'],
        },
        async execute(_toolCallId, params) {
          try {
            const limit = Math.max(1, Math.min(20, parseInt(params?.limit ?? 5, 10) || 5));
            const results = await aquifer.recall(params.query, {
              limit,
              agentId: params.agentId || undefined,
              source: params.source || undefined,
              dateFrom: params.dateFrom || undefined,
              dateTo: params.dateTo || undefined,
            });

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

    api.logger.info('[aquifer-memory] registered (before_reset + session_recall)');
  },
};
