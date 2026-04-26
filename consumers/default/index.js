'use strict';

// ---------------------------------------------------------------------------
// Aquifer default persona — parameterized, host-agnostic.
//
// Entry point:
//   const persona = require('@shadowforge0/aquifer-memory/consumers/default')
//     .createPersona({
//       agentName: 'Dobby',
//       observedOwner: 'evan',
//       schema: 'jenny',
//       scope: 'jenny',
//       dailyTable: 'jenny.daily_entries',  // or null to skip daily writes
//       language: 'zh-TW',                   // or 'en'
//       briefingIntro: '你是 Dobby。以下是現況...',  // optional context-inject preamble
//     });
//
// Returns a persona module with the standard persona adapter shape — host
// can do `AQUIFER_PERSONA=<host-path>` where <host-path>/index.js does:
//   module.exports = require('@shadowforge0/aquifer-memory/consumers/default')
//     .createPersona({ ... });
//
// This is intentionally a minimal persona: summary + optional daily_entries,
// no workspace-files, no consolidation, no Miranda-specific scaffolding.
// Host can extend by composing with Aquifer primitives from consumers/shared.
// ---------------------------------------------------------------------------

const { createAquifer } = require('../../index');
const { runIngest } = require('../shared/ingest');
const { parseEntitySection } = require('../shared/entity-parser');

const summaryModule = require('./prompts/summary');
const dailyEntriesModule = require('./daily-entries');

function createPersona(personaOpts = {}) {
  const persona = {
    agentName: personaOpts.agentName || 'Assistant',
    observedOwner: personaOpts.observedOwner || null,
    schema: personaOpts.schema || 'aquifer',
    scope: personaOpts.scope || 'default',
    dailyTable: personaOpts.dailyTable || null,
    language: personaOpts.language || 'en',
    briefingIntro: personaOpts.briefingIntro || null,
    skipEntities: personaOpts.skipEntities === true,
  };

  // ------- primitives -------

  let _instance = null;
  function getAquifer({ pool, embedFn, llmFn, rerankKey } = {}) {
    if (_instance) return _instance;
    // v1.2.0: all four are optional. If omitted, Aquifer core falls back to
    // DATABASE_URL + EMBED_PROVIDER + AQUIFER_LLM_PROVIDER env.
    const cfg = {
      schema: persona.schema,
      tenantId: 'default',
      entities: { enabled: !persona.skipEntities, scope: persona.scope },
    };
    if (pool !== undefined) cfg.db = pool;
    if (embedFn) cfg.embed = { fn: embedFn };
    if (llmFn) cfg.llm = { fn: llmFn };
    if (rerankKey) cfg.rerank = { provider: 'openrouter', openrouterApiKey: rerankKey, topK: 20, maxChars: 1600 };
    _instance = createAquifer(cfg);
    return _instance;
  }
  function resetAquifer() { _instance = null; }

  function extractConversationText(normalized) {
    if (!Array.isArray(normalized)) return '';
    return normalized
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : ''}`)
      .join('\n');
  }

  function buildSummaryFn({ agentId, now, dailyContext, llmFn, logger = console }) {
    if (typeof llmFn !== 'function') {
      throw new Error('default persona buildSummaryFn: llmFn is required');
    }
    return async function summaryFn(normalized) {
      const conversationText = extractConversationText(normalized);
      if (!conversationText) throw new Error('empty conversation text');
      const prompt = summaryModule.buildSummaryPrompt({ conversationText, agentId, now, dailyContext, persona });
      if (logger.info) logger.info(`[default-persona] calling LLM for ${agentId}`);
      const output = await llmFn(prompt);
      if (!output) throw new Error('LLM returned empty');
      const sections = summaryModule.parseSummaryOutput(output);
      const recap = summaryModule.parseRecapLines(sections.recap || '');
      if (!recap.title) throw new Error('LLM recap missing title');
      return {
        summaryText: recap.overview || '',
        structuredSummary: { ...recap, raw_sections: sections },
        entityRaw: sections.entities || null,
        extra: { sections, recap },
      };
    };
  }

  function buildEntityParseFn() {
    return (text) => {
      const parsed = parseEntitySection(text);
      return parsed.entities;
    };
  }

  function buildPostProcess({ pool, agentId, now = null, source = 'afterburn', tag = null, logger = console } = {}) {
    return async function postProcess(ctx) {
      const _now = now || new Date();
      const recap = ctx.extra?.recap || null;
      const sections = ctx.extra?.sections || null;
      const sessionId = ctx.session.sessionId;

      if (persona.dailyTable && (sections || recap)) {
        try {
          await dailyEntriesModule.writeDailyEntries({
            sections: sections || {}, recap, pool, sessionId, agentId, logger,
            source, tag, now: _now, dailyTable: persona.dailyTable,
          });
        } catch (err) {
          if (logger.warn) logger.warn(`[default-persona] daily entries failed: ${err.message}`);
        }
      }
    };
  }

  // ------- OpenClaw mount -------

  function resolveCommon(opts) {
    // v1.2.0: all four are env-driven by default. Host may override any of
    // them via opts. Aquifer core throws with clear guidance if the required
    // env vars are missing, so we do not pre-validate here.
    const aquifer = getAquifer(opts);
    const pool = opts.pool || aquifer.getPool();
    const llmFn = opts.llmFn || aquifer.getLlmFn();
    const embedFn = opts.embedFn || aquifer.getEmbedFn();
    return {
      pool,
      embedFn,
      llmFn,
      defaultAgentId: opts.agentId || 'main',
      minUserMessages: opts.minUserMessages || 3,
      aquifer,
    };
  }

  function registerAfterburn(api, opts = {}) {
    const { pool, llmFn, aquifer, defaultAgentId, minUserMessages } = resolveCommon(opts);
    const recentlyProcessed = new Map();
    const inFlight = new Set();

    api.on('before_reset', (event, ctx) => {
      const sessionId = ctx?.sessionId || event?.sessionId;
      const agentId = ctx?.agentId || defaultAgentId;
      const sessionKey = ctx?.sessionKey || null;

      if (!sessionId) return;
      if ((sessionKey || '').includes('subagent')) return;
      if ((sessionKey || '').includes(':cron:')) return;

      const rawEntries = Array.isArray(event?.messages) ? event.messages : [];
      if (rawEntries.length < 3) {
        api.logger.info(`[default-persona] skip ${sessionId}: only ${rawEntries.length} msgs`);
        return;
      }

      (async () => {
        try {
          const now = new Date();
          const date = dailyEntriesModule.taipeiDateString(now);
          let dailyContext = '';
          try { dailyContext = await dailyEntriesModule.fetchDailyContext(pool, date, agentId, persona.dailyTable); } catch {/* best effort */}
          await runIngest({
            aquifer,
            sessionId,
            agentId,
            source: 'openclaw',
            sessionKey,
            adapter: 'gateway',
            rawEntries,
            minUserMessages,
            dedupMap: recentlyProcessed,
            inFlight,
            summaryFn: buildSummaryFn({ agentId, now, dailyContext, llmFn, logger: api.logger }),
            entityParseFn: persona.skipEntities ? null : buildEntityParseFn(),
            postProcess: buildPostProcess({ pool, agentId, now, logger: api.logger }),
            logger: api.logger,
          });
        } catch (err) {
          api.logger.warn(`[default-persona] capture failed ${sessionId}: ${err.message}`);
        }
      })();
    });

    api.logger.info('[default-persona] registerAfterburn: before_reset hooked');
    return { aquifer };
  }

  function registerContextInject(api, opts = {}) {
    const { aquifer, defaultAgentId } = resolveCommon(opts);
    if (!persona.briefingIntro) {
      api.logger.info('[default-persona] context inject skipped (no briefingIntro configured)');
      return { aquifer };
    }
    api.on('before_prompt_build', async (_event, ctx) => {
      try {
        const agentId = ctx?.agentId || defaultAgentId;
        if ((ctx?.sessionKey || '').includes('subagent')) return;
        const recalled = await aquifer.bootstrap({ agentId, limit: 5, maxChars: 2000, format: 'text' });
        const context = persona.briefingIntro + (recalled ? `\n\n${recalled}` : '');
        if (context.length > 0) return { prependSystemContext: context };
      } catch (err) {
        api.logger.warn(`[default-persona] context injection failed: ${err.message}`);
      }
    });
    api.logger.info('[default-persona] registerContextInject: before_prompt_build hooked');
    return { aquifer };
  }

  function registerRecallTool(api, opts = {}) {
    const { aquifer } = resolveCommon(opts);
    api.registerTool((ctx) => {
      if ((ctx?.sessionKey || '').includes('subagent')) return null;
      return {
        name: 'session_recall',
        description: 'Search Aquifer memory by keyword or natural language. In curated serving mode this searches active curated memory; legacy/evidence lookup is exposed by the MCP stdio evidence_recall tool. Use entities when the user names specific people, projects, files, tools, or concepts; use entity_mode="all" when every named entity must co-occur (default "any" boosts). Use mode to force fts/vector/hybrid (default hybrid).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, description: 'Non-empty keyword or natural-language query' },
            limit: { type: 'number' },
            agent_id: { type: 'string' },
            source: { type: 'string' },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            entities: { type: 'array', items: { type: 'string' }, description: 'Named entities (person/project/tool/file)' },
            entity_mode: { type: 'string', enum: ['any', 'all'], description: '"any" boosts; "all" hard-filters to sessions containing every entity' },
            mode: { type: 'string', enum: ['fts', 'hybrid', 'vector'], description: 'Recall strategy, default hybrid' },
          },
        },
        async execute(_toolCallId, params) {
          try {
            const limit = Math.max(1, Math.min(20, parseInt(params?.limit ?? 5, 10) || 5));
            const recallOpts = {
              agentId: params?.agent_id || ctx?.agentId || undefined,
              source: params?.source || undefined,
              dateFrom: params?.date_from || undefined,
              dateTo: params?.date_to || undefined,
              limit,
            };
            if (Array.isArray(params?.entities) && params.entities.length > 0) {
              recallOpts.entities = params.entities;
              recallOpts.entityMode = params?.entity_mode || 'any';
            }
            if (params?.mode === 'fts' || params?.mode === 'hybrid' || params?.mode === 'vector') {
              recallOpts.mode = params.mode;
            }
            const results = await aquifer.recall(String(params?.query || ''), recallOpts);
            const lines = results.map((r, i) =>
              `${i+1}. ${r.structuredSummary?.title || r.summaryText?.slice(0, 80) || '(untitled)'}`
            );
            return { content: [{ type: 'text', text: lines.join('\n') || 'No matching sessions.' }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `session_recall error: ${err.message}` }], isError: true };
          }
        },
      };
    }, { name: 'session_recall' });
    api.logger.info('[default-persona] registerRecallTool: session_recall registered');
    return { aquifer };
  }

  function mountOnOpenClaw(api, opts = {}) {
    const r = registerAfterburn(api, opts);
    registerContextInject(api, opts);
    registerRecallTool(api, opts);
    return r;
  }

  return {
    persona,
    mountOnOpenClaw,
    registerAfterburn,
    registerContextInject,
    registerRecallTool,
    buildPostProcess,
    buildSummaryFn,
    buildEntityParseFn,
    extractConversationText,
    instance: { getAquifer, resetAquifer },
    summary: summaryModule,
    dailyEntries: dailyEntriesModule,
  };
}

module.exports = { createPersona };
