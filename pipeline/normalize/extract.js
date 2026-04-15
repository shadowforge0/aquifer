'use strict';

// Content extraction utilities shared across adapters

function extractCommandName(content) {
    const match = typeof content === 'string'
        ? content.match(/<command-name>(\/\w+)<\/command-name>/)
        : null;
    return match ? match[1] : null;
}

/**
 * Extract text, command name, and tool names from a message object.
 * Handles both string content and content block arrays.
 * @param {object} msg - Message object with .content field
 * @returns {{ text: string, commandName: string|null, toolNames: string[] }}
 */
function extractContent(msg) {
    if (!msg) return { text: '', commandName: null, toolNames: [] };
    const content = msg.content;
    let commandName = null;
    const toolNames = [];

    if (typeof content === 'string') {
        commandName = extractCommandName(content);
        return { text: content.trim(), commandName, toolNames };
    }

    if (Array.isArray(content)) {
        const texts = [];
        for (const item of content) {
            if (item.type === 'text' && item.text) {
                const cmd = extractCommandName(item.text);
                if (cmd) commandName = cmd;
                texts.push(item.text);
            }
            // tool_use: Claude Code / Anthropic API format
            // toolCall: gateway / OpenAI-style format
            if ((item.type === 'tool_use' || item.type === 'toolCall') && item.name) {
                toolNames.push(item.name);
            }
        }
        return { text: texts.join('\n').trim(), commandName, toolNames };
    }

    return { text: '', commandName, toolNames };
}

module.exports = { extractContent, extractCommandName };
