'use strict';

// ---------------------------------------------------------------------------
// Miranda persona layer.
//
// This is a PERSONA, not a host adapter. It wraps a host (OpenClaw gateway,
// Claude Code afterburn) with Miranda's six-section prompt, zh-TW daily log,
// workspace file artifacts, and consolidation lifecycle — but leaves the
// actual hook plumbing (before_reset, before_prompt_build, MCP tool registry)
// to the host.
//
// Entry points:
//   mountOnOpenClaw(api, opts)     — gateway plugin wiring
//   mountOnClaudeCode(cc, opts)    — CC afterburn wiring (see consumers/claude-code.js)
//   buildPostProcess(opts)         — low-level: returns the enrich postProcess
//                                    fn; host calls it directly if neither
//                                    mount helper fits.
// ---------------------------------------------------------------------------

const { runIngest } = require('../shared/ingest');
const { parseEntitySection } = require('../shared/entity-parser');

const instance = require('./instance');
const { callLlm, resolveModel, loadConfig } = require('./llm');
const summary = require('./prompts/summary');
const dailyEntries = require('./daily-entries');
const workspaceFiles = require('./workspace-files');
const contextInject = require('./context-inject');
const mirandaRecallFormat = require('./recall-format');

// ---------------------------------------------------------------------------
// summaryFn / entityParseFn factories — shared by gateway + CC
// ---------------------------------------------------------------------------

function buildSummaryFn({ agentId, now, dailyContext, runtime = 'gateway', logger = console }) {
    return async function summaryFn(_normalized) {
        // _normalized is the cleaned messages from Aquifer; Miranda wants the
        // reconstructed conversation text for the six-section prompt.
        const conversationText = extractConversationText(_normalized);
        if (!conversationText) throw new Error('empty conversation text');

        const prompt = summary.buildSummaryPrompt({ conversationText, agentId, now, dailyContext });
        if (logger.info) logger.info(`[miranda] calling LLM (${runtime})`);
        const output = await callLlm(prompt, { runtime });
        if (!output) throw new Error('LLM returned empty');

        const sections = summary.parseSummaryOutput(output);
        const recap = summary.parseRecapLines(sections.recap || '');
        const workingFacts = summary.parseWorkingFacts(sections.working_facts || '');
        if (!recap.title) throw new Error('LLM recap missing title');

        return {
            summaryText: recap.overview || '',
            structuredSummary: { ...recap, raw_sections: sections },
            entityRaw: sections.entities || null,
            extra: { sections, recap, workingFacts },
        };
    };
}

function buildEntityParseFn() {
    return function entityParseFn(text) {
        const parsed = parseEntitySection(text);
        return parsed.entities;  // already has { name, normalizedName, aliases, type }
    };
}

function extractConversationText(normalized) {
    if (!Array.isArray(normalized)) return '';
    return normalized
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : ''}`)
        .join('\n');
}

// ---------------------------------------------------------------------------
// buildPostProcess — produce the enrich postProcess hook for Miranda
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.aquifer — Aquifer instance
 * @param {object} opts.pool    — pg.Pool (used for daily-entries DAL)
 * @param {string} opts.agentId
 * @param {string} [opts.workspaceDir] — if set, writes emotional-state.md and recap JSON files
 * @param {string} [opts.source='afterburn']
 * @param {string|null} [opts.tag=null] — daily-entry tag (e.g. '[CLI]' for CC runs)
 * @param {Date}  [opts.now]
 * @param {object} [opts.logger]
 * @param {boolean} [opts.consolidate=true]
 */
function buildPostProcess({
    aquifer, pool, agentId, workspaceDir = null,
    source = 'afterburn', tag = null, now = null,
    logger = console, consolidate = true,
} = {}) {
    if (!aquifer) throw new Error('buildPostProcess: aquifer is required');
    if (!pool) throw new Error('buildPostProcess: pool is required');
    if (!agentId) throw new Error('buildPostProcess: agentId is required');

    return async function postProcess(ctx) {
        const _now = now || new Date();
        const recap = ctx.extra?.recap || null;
        const sections = ctx.extra?.sections || null;
        const workingFacts = ctx.extra?.workingFacts || [];
        const sessionId = ctx.session.sessionId;

        // 1. Workspace files (optional — only if persona has a workspace dir)
        if (workspaceDir && (sections || recap)) {
            try {
                await workspaceFiles.writeWorkspaceFiles(sections || {}, recap, workspaceDir, {
                    sessionId,
                    agentId,
                    conversationText: extractConversationText(ctx.normalized || []),
                }, logger);
            } catch (err) {
                if (logger.warn) logger.warn(`[miranda] workspace files failed: ${err.message}`);
            }
        }

        // 2. Daily entries
        if (sections || recap) {
            try {
                await dailyEntries.writeDailyEntries({
                    sections: sections || {}, recap, pool, sessionId, agentId, logger,
                    source, tag, now: _now,
                });
            } catch (err) {
                if (logger.warn) logger.warn(`[miranda] daily entries failed: ${err.message}`);
            }
        }

        // 3. Fact candidates — write to aquifer.${schema}.facts via consolidate 'create'
        //    (We only CREATE here; candidate-lifecycle decisions come from the
        //    consolidation step below.)
        if (consolidate && workingFacts.length > 0) {
            try {
                const { normalizeEntityName } = require('../../index');
                const actions = workingFacts.map(f => ({
                    action: 'create',
                    subject: f.subject,
                    statement: f.statement,
                    importance: 6,
                }));
                await aquifer.consolidate(sessionId, {
                    agentId,
                    actions,
                    normalizeSubject: normalizeEntityName,
                    recapOverview: recap?.overview || '',
                });
            } catch (err) {
                if (logger.warn) logger.warn(`[miranda] fact candidates failed: ${err.message}`);
            }
        }
    };
}

// ---------------------------------------------------------------------------
// mountOnOpenClaw — gateway plugin helper
// ---------------------------------------------------------------------------

/**
 * Register Miranda-flavored hooks on an OpenClaw plugin `api` object:
 *   - before_reset: normalize+commit+enrich with Miranda summaryFn & postProcess
 *   - before_prompt_build: inject Miranda session context
 *   - session_recall tool: zh-TW formatted recall
 *
 * @param {object} api — OpenClaw plugin API (api.on, api.registerTool, api.logger, api.pluginConfig)
 * @param {object} opts
 * @param {object} opts.pool     — pg.Pool
 * @param {function} opts.embedFn
 * @param {function} [opts.llmFn] — defaults to Miranda's callLlm
 * @param {string}  [opts.agentId='main']
 * @param {string}  [opts.workspaceDir]
 * @param {string}  [opts.rerankKey]
 * @param {number}  [opts.minUserMessages=3]
 */
function mountOnOpenClaw(api, opts = {}) {
    const pool = opts.pool;
    const embedFn = opts.embedFn;
    const defaultAgentId = opts.agentId || 'main';
    const workspaceDir = opts.workspaceDir || null;
    const minUserMessages = opts.minUserMessages || 3;

    const aquifer = instance.getAquifer({
        pool, embedFn, llmFn: opts.llmFn, rerankKey: opts.rerankKey,
    });

    const recentlyProcessed = new Map();
    const inFlight = new Set();

    // --- before_reset: capture session ---
    api.on('before_reset', (event, ctx) => {
        const sessionId = ctx?.sessionId || event?.sessionId;
        const agentId = ctx?.agentId || defaultAgentId;
        const sessionKey = ctx?.sessionKey || null;

        if (!sessionId) return;
        if ((sessionKey || '').includes('subagent')) return;
        if ((sessionKey || '').includes(':cron:')) return;

        const rawEntries = Array.isArray(event?.messages) ? event.messages : [];
        if (rawEntries.length < 3) {
            api.logger.info(`[miranda] skip ${sessionId}: only ${rawEntries.length} msgs`);
            return;
        }

        (async () => {
            try {
                const now = new Date();
                const date = dailyEntries.taipeiDateString(now);
                let dailyContext = '';
                try { dailyContext = await dailyEntries.fetchDailyContext(pool, date, agentId); } catch { /* best-effort */ }

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
                    summaryFn: buildSummaryFn({ agentId, now, dailyContext, runtime: 'gateway', logger: api.logger }),
                    entityParseFn: buildEntityParseFn(),
                    postProcess: buildPostProcess({
                        aquifer, pool, agentId, workspaceDir,
                        source: 'afterburn', now, logger: api.logger,
                    }),
                    logger: api.logger,
                });
            } catch (err) {
                api.logger.warn(`[miranda] capture failed ${sessionId}: ${err.message}`);
            }
        })();
    });

    // --- before_prompt_build: inject Miranda briefing ---
    api.on('before_prompt_build', async (event, ctx) => {
        try {
            const agentId = ctx?.agentId || defaultAgentId;
            if ((ctx?.sessionKey || '').includes('subagent')) return;

            const context = await contextInject.computeInjection({
                aquifer, pool, agentId, includeBootstrap: true,
            });
            if (context && context.split('\n').length > 3) {
                api.logger.info(`[miranda] injecting context: ${context.length} chars, agent=${agentId}`);
                return { prependSystemContext: context };
            }
        } catch (err) {
            api.logger.warn(`[miranda] context injection failed: ${err.message}`);
        }
    });

    // --- session_recall tool (zh-TW format) ---
    api.registerTool((ctx) => {
        if ((ctx?.sessionKey || '').includes('subagent')) return null;
        return {
            name: 'session_recall',
            description: '搜尋歷史 session 的摘要和對話記錄。可按關鍵字、日期範圍、agent 搜尋。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '搜尋關鍵字（可空，空時按時間排序）' },
                    date_from: { type: 'string' }, date_to: { type: 'string' },
                    agent_id: { type: 'string' }, source: { type: 'string' },
                    detail: { type: 'string' },
                    limit: { type: 'number' },
                },
            },
            async execute(_toolCallId, params) {
                try {
                    const limit = Math.max(1, Math.min(20, parseInt(params?.limit ?? 5, 10) || 5));
                    const results = await aquifer.recall(String(params?.query || ''), {
                        agentId: params?.agent_id || ctx?.agentId || undefined,
                        source: params?.source || undefined,
                        dateFrom: params?.date_from || undefined,
                        dateTo: params?.date_to || undefined,
                        limit,
                    });
                    const text = mirandaRecallFormat.formatRecallResults(results.map(r => ({
                        sessionId: r.sessionId, agentId: r.agentId, source: r.source,
                        startedAt: r.startedAt, summaryText: r.summaryText,
                        structuredSummary: r.structuredSummary,
                        matchedTurnText: r.matchedTurnText,
                    })));
                    return { content: [{ type: 'text', text }] };
                } catch (err) {
                    return { content: [{ type: 'text', text: `session_recall 錯誤：${err.message}` }], isError: true };
                }
            },
        };
    }, { name: 'session_recall' });

    api.logger.info('[miranda] mounted on OpenClaw (before_reset + before_prompt_build + session_recall)');
    return { aquifer };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    // Persona entry points
    mountOnOpenClaw,
    buildPostProcess,
    buildSummaryFn,
    buildEntityParseFn,

    // Individual modules for advanced wiring
    instance,
    llm: { callLlm, resolveModel, loadConfig },
    summary,
    dailyEntries,
    workspaceFiles,
    contextInject,
    recallFormat: mirandaRecallFormat,

    // Helpers re-exported for convenience
    extractConversationText,
};
