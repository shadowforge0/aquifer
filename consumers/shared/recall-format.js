'use strict';

// ---------------------------------------------------------------------------
// Shared recall formatter — turns aquifer.recall() rows into human-readable
// text. The default is English and markdown-ish; consumers with a persona
// (Miranda: zh-TW narrative) can override individual renderers.
// ---------------------------------------------------------------------------

function truncate(s, n) {
    if (!s) return '';
    const str = String(s);
    return str.length > n ? `${str.slice(0, n)}...` : str;
}

function formatDateIso(value) {
    if (!value) return 'unknown';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 10);
}

// Default English renderers --------------------------------------------------

const defaultRenderers = {
    header({ results, query }) {
        if (!query) return null;
        return `Found ${results.length} result(s) for "${query}":`;
    },
    empty({ query }) {
        return query ? `No results found for "${query}".` : 'No matching sessions found.';
    },
    title(result, index) {
        const ss = result.structuredSummary || {};
        const title = ss.title || truncate(result.summaryText, 60) || '(untitled)';
        const date = formatDateIso(result.startedAt);
        const agent = result.agentId || 'default';
        return `### ${index + 1}. ${title} (${date}, ${agent})`;
    },
    body(result) {
        const ss = result.structuredSummary || {};
        const text = ss.overview || result.summaryText || '';
        return text ? truncate(text, 300) : null;
    },
    matched(result) {
        return result.matchedTurnText ? `Matched turn: ${truncate(result.matchedTurnText, 200)}` : null;
    },
    score(result, { showScore }) {
        if (!showScore) return null;
        return `Score: ${typeof result.score === 'number' ? result.score.toFixed(3) : '?'}`;
    },
    separator() {
        return '';
    },
};

/**
 * Create a formatter with optional per-renderer overrides.
 *
 * @param {object} [overrides] — renderers to override: header/empty/title/body/matched/score/separator
 * @returns {(results: any[], opts?: object) => string}
 */
function createRecallFormatter(overrides = {}) {
    const r = { ...defaultRenderers, ...overrides };

    return function format(results, opts = {}) {
        const safeResults = Array.isArray(results) ? results : [];
        const ctx = { query: opts.query || null, results: safeResults };

        if (safeResults.length === 0) {
            return r.empty(ctx);
        }

        const lines = [];
        const header = r.header(ctx);
        if (header) { lines.push(header); lines.push(''); }

        for (let i = 0; i < safeResults.length; i++) {
            const res = safeResults[i];
            const title = r.title(res, i, ctx);
            if (title) lines.push(title);
            const body = r.body(res, i, ctx);
            if (body) lines.push(body);
            const matched = r.matched(res, i, ctx);
            if (matched) lines.push(matched);
            const score = r.score(res, { showScore: !!opts.showScore, ...ctx });
            if (score) lines.push(score);
            const sep = r.separator(i, ctx);
            if (sep !== null && sep !== undefined) lines.push(sep);
        }

        // Trim trailing empty separator
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

        return lines.join('\n');
    };
}

// Pre-built default English formatter
const defaultFormatter = createRecallFormatter();

function formatRecallResults(results, opts = {}) {
    return defaultFormatter(results, opts);
}

module.exports = {
    createRecallFormatter,
    formatRecallResults,
    truncate,
    formatDateIso,
    defaultRenderers,
};
