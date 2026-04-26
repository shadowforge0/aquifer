'use strict';

/**
 * Codex CLI adapter — maps Codex rollout JSONL entries into the same
 * intermediate shape used by the shared normalize pipeline.
 */

const { MAX_NARRATION_CHARS } = require('../constants');
const { parseTimestamp } = require('../timestamp');

function extractCodexText(content) {
    if (!Array.isArray(content)) return '';
    return content
        .filter(item => item && item.type === 'output_text' && typeof item.text === 'string')
        .map(item => item.text.trim())
        .filter(Boolean)
        .join('\n\n');
}

function codexToolName(entry) {
    const payload = entry?.payload || {};
    if (entry?.type === 'response_item' && payload.type === 'function_call') {
        return payload.name || payload.call_id || 'function_call';
    }
    return null;
}

function nextCodexEntryIsTool(rawEntries, idx) {
    for (let j = idx + 1; j < rawEntries.length; j++) {
        const toolName = codexToolName(rawEntries[j]);
        if (toolName) return true;
        const payload = rawEntries[j]?.payload || {};
        if (rawEntries[j]?.type === 'event_msg' && payload.type === 'user_message') return false;
        if (
            rawEntries[j]?.type === 'response_item'
            && payload.type === 'message'
            && payload.role === 'assistant'
            && payload.phase === 'final_answer'
        ) return false;
    }
    return false;
}

module.exports = {
    name: 'codex',

    detect(entry) {
        return entry?.type === 'session_meta'
            || entry?.type === 'turn_context'
            || entry?.type === 'event_msg'
            || entry?.type === 'response_item';
    },

    toIntermediate(entry, ctx) {
        const { idx, rawEntries } = ctx;
        const payload = entry?.payload || {};

        if (entry?.type === 'event_msg' && payload.type === 'user_message') {
            const text = String(payload.message || '').trim();
            return {
                idx,
                role: 'user',
                text,
                timestamp: parseTimestamp(entry),
                toolNames: [],
                commandName: null,
                isInterrupt: false,
                adapterSkip: null,
            };
        }

        const toolName = codexToolName(entry);
        if (toolName) return { idx, toolNames: [toolName], adapterSkip: 'toolOnly' };

        if (entry?.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
            const text = extractCodexText(payload.content);
            const toolNames = [];
            if (!text) return { idx, toolNames, adapterSkip: 'empty' };

            if (
                payload.phase === 'commentary'
                && text.length < MAX_NARRATION_CHARS
                && nextCodexEntryIsTool(rawEntries, idx)
            ) {
                return { idx, toolNames, adapterSkip: 'narration' };
            }

            return {
                idx,
                role: 'assistant',
                text,
                timestamp: parseTimestamp(entry),
                toolNames,
                commandName: null,
                isInterrupt: false,
                adapterSkip: null,
            };
        }

        return { idx, toolNames: [], adapterSkip: 'nonMessage' };
    },

    routinePatterns: [],

    skipCommands: [],
};
