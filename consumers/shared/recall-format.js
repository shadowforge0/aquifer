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

// Humanize a past timestamp into zh-TW relative form (e.g. "3 天前", "昨天").
// Bucketed on raw ms-diff — good enough for model intuition, not calendar-precise.
// Returns null for invalid / future timestamps so callers can fall back.
function formatRelativeZhTw(value, now) {
    if (!value) return null;
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) return null;
    const nowMs = typeof now === 'number' ? now : Date.now();
    const diffMs = nowMs - t;
    if (diffMs < 0) return null;
    const day = 86400000;
    if (diffMs < day) return '今天';
    if (diffMs < 2 * day) return '昨天';
    if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} 天前`;
    if (diffMs < 30 * day) return `${Math.floor(diffMs / (7 * day))} 週前`;
    if (diffMs < 365 * day) return `${Math.floor(diffMs / (30 * day))} 個月前`;
    return `${Math.floor(diffMs / (365 * day))} 年前`;
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
    explain(result, { showExplain }) {
        if (!showExplain) return null;
        const d = result._debug;
        if (!d) return null;
        const f = (v) => typeof v === 'number' ? v.toFixed(3) : '?';
        const parts = [
            `rrf=${f(d.rrf)}`,
            `td=${f(d.timeDecay)}`,
            `access=${f(d.access)}`,
            `entity=${f(d.entityScore)}`,
            `trust=${f(d.trustScore)}(\u00d7${f(d.trustMultiplier)})`,
            `ol=${f(d.openLoopBoost)}`,
            `\u2192 hybrid=${f(d.hybridScore)}`,
        ];
        if (d.rerankApplied) {
            parts.push(`rerank=${f(d.rerankScore)}(${d.rerankReason || '?'})`);
        } else {
            parts.push(`[rerank: off (${d.rerankReason || '?'})]`);
        }
        if (Array.isArray(d.searchErrors) && d.searchErrors.length > 0) {
            parts.push(`errors: ${d.searchErrors.map(e => (e && e.path) || '?').join(',')}`);
        }
        return `  ${parts.join(' ')}`;
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
        const ctx = { query: opts.query || null, results: safeResults, now: opts.now };

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
            const explain = r.explain(res, { showExplain: !!opts.showExplain, ...ctx });
            if (explain) lines.push(explain);
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
    formatRelativeZhTw,
    defaultRenderers,
};
