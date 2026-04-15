'use strict';

const gatewayAdapter = require('./adapters/gateway');
const claudeCodeAdapter = require('./adapters/claude-code');

const ADAPTERS = [gatewayAdapter, claudeCodeAdapter];

/**
 * Auto-detect the client type from raw session entries.
 * Samples the first 5 entries and picks the adapter with the most matches.
 * @param {any[]} rawEntries
 * @returns {string} Client name ('gateway' | 'claude-code')
 * @throws {Error} If entries are empty, no adapter matches, or detection is ambiguous
 */
function detectClient(rawEntries) {
    if (!rawEntries || rawEntries.length === 0) {
        throw new Error('Cannot detect client: empty entries');
    }

    const sample = rawEntries.slice(0, Math.min(5, rawEntries.length));
    const scores = [];

    for (const adapter of ADAPTERS) {
        const count = sample.filter(e => adapter.detect(e)).length;
        scores.push({ name: adapter.name, count });
    }
    scores.sort((a, b) => b.count - a.count);

    if (scores[0].count === 0) {
        throw new Error('Cannot detect session client type. Pass opts.client explicitly.');
    }
    if (scores.length > 1 && scores[0].count === scores[1].count) {
        throw new Error(`Ambiguous client detection (${scores[0].name}=${scores[0].count}, ${scores[1].name}=${scores[1].count}). Pass opts.client explicitly.`);
    }

    return scores[0].name;
}

/**
 * Get adapter by client name.
 * @param {string} clientType
 * @returns {object} Adapter object
 * @throws {Error} If client type is unknown
 */
function getAdapter(clientType) {
    for (const adapter of ADAPTERS) {
        if (adapter.name === clientType) return adapter;
    }
    throw new Error(`Unknown client type: "${clientType}". Known: ${ADAPTERS.map(a => a.name).join(', ')}`);
}

module.exports = { detectClient, getAdapter, ADAPTERS };
