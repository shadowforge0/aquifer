'use strict';

/**
 * Parse timestamp from a raw session entry.
 * Handles multiple formats: ISO string (outer), epoch ms number (inner).
 * Unified across all adapters to ensure consistent boundary detection.
 * @param {object} entry - Raw session entry
 * @returns {string|null} ISO8601 string or null
 */
function parseTimestamp(entry) {
    // Outer timestamp (ISO string) — common in CLI-based clients
    const outerTs = entry.timestamp;
    if (typeof outerTs === 'string') {
        const d = new Date(outerTs);
        if (!isNaN(d.getTime())) return d.toISOString();
    }

    // Inner timestamp (epoch ms) — common in gateway/server-side clients
    const innerTs = entry.message?.timestamp;
    if (typeof innerTs === 'number') {
        return new Date(innerTs).toISOString();
    }

    // Inner timestamp can also be ISO string
    if (typeof innerTs === 'string') {
        const d = new Date(innerTs);
        if (!isNaN(d.getTime())) return d.toISOString();
    }

    return null;
}

module.exports = { parseTimestamp };
