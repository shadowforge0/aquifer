'use strict';

/**
 * Gateway adapter — for AI gateway servers that produce type='message' entries.
 * Content blocks combine text + thinking + toolCall in a single entry.
 * Supports channel metadata stripping (Discord, Telegram, etc.).
 */

const { extractContent } = require('../extract');
const { parseTimestamp } = require('../timestamp');

// Channel metadata prefix injected by gateway routing layers
const METADATA_PREFIX_RE = /^(?:Conversation info \(untrusted metadata\):[\s\S]*?```\s*\n\s*)?(?:Sender \(untrusted metadata\):[\s\S]*?```\s*\n\s*)?/;

function stripChannelMetadata(text) {
    const stripped = text.replace(METADATA_PREFIX_RE, '').trim();
    return stripped || text;
}

module.exports = {
    name: 'gateway',

    detect(entry) {
        return entry.type === 'message';
    },

    toIntermediate(entry, ctx) {
        const { idx } = ctx;

        if (entry.type !== 'message') {
            return { idx, toolNames: [], adapterSkip: 'nonMessage' };
        }

        const msg = entry.message;
        const role = msg?.role;

        if (role === 'toolResult') {
            return { idx, toolNames: [], adapterSkip: 'toolResult' };
        }
        if (role !== 'user' && role !== 'assistant') {
            return { idx, role: null, toolNames: [], adapterSkip: 'noRole' };
        }

        const { text, commandName, toolNames } = extractContent(msg);

        let finalText = text;
        const isInterrupt = text.startsWith('[Request interrupted by user');
        if (role === 'user' && finalText && !isInterrupt) {
            finalText = stripChannelMetadata(finalText);
        }

        return {
            idx, role, text: finalText,
            timestamp: parseTimestamp(entry),
            toolNames, commandName, isInterrupt,
            adapterSkip: null,
        };
    },

    routinePatterns: [
        /^HEARTBEAT_OK$/,
        /^THINK_OK$/,
        /^\[Queued messages while agent was busy\]/,
    ],

    skipCommands: [],
};
