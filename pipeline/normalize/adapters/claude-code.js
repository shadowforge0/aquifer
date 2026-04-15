'use strict';

/**
 * Claude Code adapter — for Claude Code CLI sessions.
 * Entry types are 'user'/'assistant' (split format: one content type per entry).
 * Text and tool_use are separate entries, enabling narration detection via look-ahead.
 */

const { extractContent } = require('../extract');
const { parseTimestamp } = require('../timestamp');
const { MAX_NARRATION_CHARS } = require('../constants');

module.exports = {
    name: 'claude-code',

    detect(entry) {
        // Only count entry types that participate in normalize
        return entry.type === 'user' || entry.type === 'assistant';
    },

    toIntermediate(entry, ctx) {
        const { idx, rawEntries } = ctx;
        const entryType = entry.type;

        if (entryType !== 'user' && entryType !== 'assistant') {
            return { idx, toolNames: [], adapterSkip: 'nonMessage' };
        }

        const role = entry.message?.role || entryType;

        if (role === 'toolResult') {
            return { idx, toolNames: [], adapterSkip: 'toolResult' };
        }
        if (role !== 'user' && role !== 'assistant') {
            return { idx, role: null, toolNames: [], adapterSkip: 'noRole' };
        }
        if (entry.isMeta) {
            return { idx, toolNames: [], adapterSkip: 'meta' };
        }

        const { text, commandName, toolNames } = extractContent(entry.message);

        // CLI internal command output tags
        if (text.includes('<local-command-caveat>') || text.includes('<local-command-stdout>') || text.includes('<local-command-stderr>')) {
            return { idx, toolNames, adapterSkip: 'caveat' };
        }

        const isInterrupt = text.startsWith('[Request interrupted by user');

        // Tool-use-only assistant entry (no visible text, only tool calls)
        if (!text && toolNames.length > 0 && role === 'assistant') {
            return { idx, toolNames, adapterSkip: 'toolOnly' };
        }

        // Narration detection: short text entry immediately followed by a tool_use entry.
        // Claude Code splits text and tool_use into separate JSONL entries.
        // A short text before a tool call is narration ("Now reading X...", "Let me check...").
        if (role === 'assistant' && text && text.length < MAX_NARRATION_CHARS) {
            let nextIsTool = false;
            for (let j = idx + 1; j < rawEntries.length && j < idx + 3; j++) {
                const ne = rawEntries[j];
                if (ne.type === 'assistant') {
                    const nc = ne.message?.content;
                    if (Array.isArray(nc) && nc.some(x => x.type === 'tool_use')) nextIsTool = true;
                    break;
                }
            }
            if (nextIsTool) {
                return { idx, toolNames, adapterSkip: 'narration' };
            }
        }

        return {
            idx, role, text,
            timestamp: parseTimestamp(entry),
            toolNames, commandName, isInterrupt,
            adapterSkip: null,
        };
    },

    routinePatterns: [
        /^<task-notification>/,
    ],

    skipCommands: [
        '/model', '/cost', '/memory', '/permissions', '/diff', '/review',
        '/doctor', '/login', '/logout', '/mcp', '/context', '/fast',
        '/think', '/vim', '/exit',
    ],
};
