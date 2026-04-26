'use strict';

// ---------------------------------------------------------------------------
// Shared normalize — turns raw host entries into commit-ready messages plus
// session-level metadata. Wraps pipeline/normalize so consumers don't each
// reinvent their own role/content extraction.
//
// Supported adapters: 'gateway' | 'cc' (alias of 'claude-code') | 'codex'. The OpenCode
// consumer reads from SQLite and constructs the output shape directly; it is
// not expected to route through here.
//
// Output shape is the one commit() + enrich() expect:
//   { messages:[{role,content,timestamp}], userCount, assistantCount,
//     model, tokensIn, tokensOut, startedAt, lastMessageAt,
//     skipStats, boundaries, toolsUsed }
// ---------------------------------------------------------------------------

const { normalizeSession } = require('../../pipeline/normalize');

const ADAPTER_ALIASES = {
    'cc': 'claude-code',
    'claude-code': 'claude-code',
    'gateway': 'gateway',
    'codex': 'codex',
};

function resolveAdapter(adapter) {
    if (!adapter) return null;  // auto-detect
    const name = ADAPTER_ALIASES[adapter];
    if (!name) {
        throw new Error(`Unknown adapter: "${adapter}". Supported: gateway, cc (alias claude-code), codex.`);
    }
    return name;
}

function extractRawMeta(rawEntries) {
    let model = null;
    let tokensIn = 0;
    let tokensOut = 0;

    for (const entry of rawEntries || []) {
        if (!entry || typeof entry !== 'object') continue;

        if (entry.type === 'turn_context' && entry.payload?.model && !model) {
            model = entry.payload.model;
        }
        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
            const usage = entry.payload?.info?.last_token_usage || {};
            tokensIn += usage.input_tokens || usage.input || 0;
            tokensOut += usage.output_tokens || usage.output || 0;
        }

        const msg = entry.message || entry;
        if (msg && typeof msg === 'object') {
            if (msg.model && !model) model = msg.model;
            if (msg.usage) {
                tokensIn += msg.usage.input_tokens || msg.usage.input || 0;
                tokensOut += msg.usage.output_tokens || msg.usage.output || 0;
            }
        }
    }

    return { model, tokensIn, tokensOut };
}

/**
 * Normalize raw host entries to Aquifer-commit shape + session metadata.
 *
 * @param {any[]} rawEntries
 * @param {object} [opts]
 * @param {'gateway'|'cc'|'claude-code'|'codex'} [opts.adapter] — host adapter; auto-detected if omitted
 * @returns {{
 *   messages: {role:string,content:string,timestamp:string|null}[],
 *   userCount: number, assistantCount: number,
 *   model: string|null, tokensIn: number, tokensOut: number,
 *   startedAt: string|null, lastMessageAt: string|null,
 *   skipStats: object, boundaries: object[], toolsUsed: string[]
 * }}
 */
function normalizeMessages(rawEntries, opts = {}) {
    const safeEntries = Array.isArray(rawEntries) ? rawEntries : [];

    if (safeEntries.length === 0) {
        return {
            messages: [],
            userCount: 0,
            assistantCount: 0,
            model: null,
            tokensIn: 0,
            tokensOut: 0,
            startedAt: null,
            lastMessageAt: null,
            skipStats: { total: 0, nonMessage: 0, noRole: 0, meta: 0, caveat: 0,
                empty: 0, toolOnly: 0, narration: 0, toolResult: 0, routine: 0, command: 0 },
            boundaries: [],
            toolsUsed: [],
        };
    }

    const client = resolveAdapter(opts.adapter);
    const { normalized, skipStats, boundaries, toolsUsed } = normalizeSession(
        safeEntries,
        client ? { client } : {},
    );

    const messages = normalized.map(m => ({
        role: m.role,
        content: m.text || '',
        timestamp: m.timestamp || null,
    }));

    let userCount = 0, assistantCount = 0;
    let startedAt = null, lastMessageAt = null;
    for (const m of messages) {
        if (m.role === 'user') userCount++;
        else if (m.role === 'assistant') assistantCount++;
        if (m.timestamp) {
            if (!startedAt) startedAt = m.timestamp;
            lastMessageAt = m.timestamp;
        }
    }

    const { model, tokensIn, tokensOut } = extractRawMeta(safeEntries);

    return {
        messages,
        userCount,
        assistantCount,
        model,
        tokensIn,
        tokensOut,
        startedAt,
        lastMessageAt,
        skipStats,
        boundaries,
        toolsUsed,
    };
}

module.exports = { normalizeMessages, extractRawMeta };
