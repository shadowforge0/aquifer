'use strict';

const { SKIP_COMMANDS, RESET_COMMANDS, MAX_MSG_CHARS } = require('./constants');
const { detectClient, getAdapter } = require('./detect');

/**
 * Normalize raw session entries into effective messages.
 *
 * Accepts raw JSONL entries from any supported client (gateway, Claude Code, etc.)
 * and produces a clean, uniform array of conversational messages suitable for
 * summarization, embedding, and recall.
 *
 * @param {any[]} rawEntries - Raw JSONL entries from a session file
 * @param {object} [opts]
 * @param {string} [opts.client] - Client type: 'gateway' | 'claude-code'. Auto-detected if omitted.
 * @param {number} [opts.idleGapMs] - Idle gap threshold for boundary detection (default: 2 hours)
 * @returns {{ normalized: object[], skipStats: object, boundaries: object[], toolsUsed: string[] }}
 */
function normalizeSession(rawEntries, opts = {}) {
    if (!rawEntries || rawEntries.length === 0) {
        return {
            normalized: [],
            skipStats: { total: 0, nonMessage: 0, noRole: 0, meta: 0, caveat: 0,
                empty: 0, toolOnly: 0, narration: 0, toolResult: 0, routine: 0, command: 0 },
            boundaries: [],
            toolsUsed: [],
        };
    }

    const idleGapMs = opts.idleGapMs || 2 * 60 * 60 * 1000;

    // 1. Select adapter
    const clientType = opts.client || detectClient(rawEntries);
    const adapter = getAdapter(clientType);

    // 2. Merge adapter-specific constants with shared constants
    const allSkipCommands = new Set([...SKIP_COMMANDS, ...(adapter.skipCommands || [])]);
    const allRoutinePatterns = [...(adapter.routinePatterns || [])];

    // 3. Main loop: adapter.toIntermediate → shared filter → collect
    const normalized = [];
    const skipStats = { total: 0, nonMessage: 0, noRole: 0, meta: 0, caveat: 0,
        empty: 0, toolOnly: 0, narration: 0, toolResult: 0, routine: 0, command: 0 };
    const toolsUsed = new Set();

    for (let idx = 0; idx < rawEntries.length; idx++) {
        skipStats.total++;
        const parsed = adapter.toIntermediate(rawEntries[idx], { idx, rawEntries });

        // Collect tool names even from skipped entries
        if (parsed.toolNames?.length) {
            for (const tn of parsed.toolNames) toolsUsed.add(tn);
        }

        // Adapter-determined skip
        if (parsed.adapterSkip) {
            if (!(parsed.adapterSkip in skipStats)) {
                throw new Error(`Unknown adapterSkip reason: "${parsed.adapterSkip}" from ${clientType} adapter`);
            }
            skipStats[parsed.adapterSkip]++;
            continue;
        }

        // Shared: invalid role
        if (!parsed.role || (parsed.role !== 'user' && parsed.role !== 'assistant')) {
            skipStats.noRole++;
            continue;
        }

        // Shared: empty text (but keep interrupts)
        if (!parsed.text && !parsed.isInterrupt) {
            skipStats.empty++;
            continue;
        }

        // Shared: routine patterns
        if (!parsed.isInterrupt && parsed.text && allRoutinePatterns.some(re => re.test(parsed.text.trim()))) {
            skipStats.routine++;
            continue;
        }

        // Shared: skip commands
        if (parsed.commandName && allSkipCommands.has(parsed.commandName)) {
            skipStats.command++;
            continue;
        }

        // Shared: truncate + reset command handling
        const isResetCommand = !!(parsed.commandName && RESET_COMMANDS.has(parsed.commandName));
        let finalText = isResetCommand ? '' : (parsed.text || '');
        if (finalText.length > MAX_MSG_CHARS) {
            finalText = finalText.slice(0, MAX_MSG_CHARS) + '\n[truncated]';
        }

        const msg = {
            idx: parsed.idx,
            role: parsed.role,
            timestamp: parsed.timestamp,
            text: finalText,
            commandName: parsed.commandName || null,
            isResetCommand,
        };
        if (parsed.isInterrupt) msg.isInterrupt = true;

        normalized.push(msg);
    }

    // 4. Boundary detection
    const boundaries = [];
    for (let i = 0; i < normalized.length; i++) {
        const cur = normalized[i];
        const prev = i > 0 ? normalized[i - 1] : null;

        if (cur.isResetCommand) {
            boundaries.push({ type: 'command', at_index: i, reason: cur.commandName });
        }

        if (prev?.timestamp && cur.timestamp) {
            const gapMs = new Date(cur.timestamp).getTime() - new Date(prev.timestamp).getTime();
            if (gapMs > idleGapMs) {
                boundaries.push({ type: 'idle_gap', at_index: i, gap_minutes: Math.round(gapMs / 60000) });
            }
        }
    }

    return { normalized, skipStats, boundaries, toolsUsed: [...toolsUsed] };
}

module.exports = { normalizeSession, detectClient };
