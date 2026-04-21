'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    createRecallFormatter,
    formatRecallResults,
    truncate,
    formatDateIso,
    formatRelativeZhTw,
} = require('../consumers/shared/recall-format');

const sampleResult = {
    sessionId: 'ses-1',
    agentId: 'main',
    startedAt: '2026-04-18T10:00:00Z',
    summaryText: 'Session body overview text',
    structuredSummary: {
        title: 'Cron audit',
        overview: 'We reviewed all the crons and killed the stale ones.',
    },
    matchedTurnText: 'the discussion about cron timers',
    score: 0.8765,
};

// ---------------------------------------------------------------------------

describe('truncate', () => {
    it('leaves short strings alone', () => {
        assert.equal(truncate('abc', 10), 'abc');
    });
    it('adds ellipsis when over length', () => {
        assert.equal(truncate('abcdefghijk', 5), 'abcde...');
    });
    it('handles null / empty', () => {
        assert.equal(truncate(null, 5), '');
        assert.equal(truncate('', 5), '');
    });
});

describe('formatDateIso', () => {
    it('returns YYYY-MM-DD', () => {
        assert.equal(formatDateIso('2026-04-18T10:00:00Z'), '2026-04-18');
    });
    it('returns "unknown" for null', () => {
        assert.equal(formatDateIso(null), 'unknown');
    });
    it('returns "unknown" for invalid', () => {
        assert.equal(formatDateIso('not a date'), 'unknown');
    });
});

describe('formatRelativeZhTw', () => {
    const now = new Date('2026-04-20T12:00:00Z').getTime();
    const h = 3600000;
    const d = 86400000;

    it('今天 for < 24h', () => {
        assert.equal(formatRelativeZhTw(now - 2 * h, now), '今天');
        assert.equal(formatRelativeZhTw(now - 23 * h, now), '今天');
    });
    it('昨天 for 24-48h', () => {
        assert.equal(formatRelativeZhTw(now - 25 * h, now), '昨天');
        assert.equal(formatRelativeZhTw(now - 47 * h, now), '昨天');
    });
    it('N 天前 for 2-6 days', () => {
        assert.equal(formatRelativeZhTw(now - 3 * d, now), '3 天前');
        assert.equal(formatRelativeZhTw(now - 6 * d - h, now), '6 天前');
    });
    it('N 週前 for 7-29 days', () => {
        assert.equal(formatRelativeZhTw(now - 7 * d, now), '1 週前');
        assert.equal(formatRelativeZhTw(now - 14 * d, now), '2 週前');
        assert.equal(formatRelativeZhTw(now - 29 * d, now), '4 週前');
    });
    it('N 個月前 for 30-364 days', () => {
        assert.equal(formatRelativeZhTw(now - 30 * d, now), '1 個月前');
        assert.equal(formatRelativeZhTw(now - 90 * d, now), '3 個月前');
    });
    it('N 年前 for >= 365 days', () => {
        assert.equal(formatRelativeZhTw(now - 365 * d, now), '1 年前');
        assert.equal(formatRelativeZhTw(now - 800 * d, now), '2 年前');
    });
    it('returns null for null/invalid', () => {
        assert.equal(formatRelativeZhTw(null, now), null);
        assert.equal(formatRelativeZhTw('not a date', now), null);
    });
    it('returns null for future timestamps', () => {
        assert.equal(formatRelativeZhTw(now + d, now), null);
    });
    it('defaults to Date.now() when now omitted', () => {
        // Should not throw, and produce some valid string for an old date
        const result = formatRelativeZhTw('2020-01-01T00:00:00Z');
        assert.ok(result && result.endsWith('年前'));
    });
});

// ---------------------------------------------------------------------------

describe('formatRecallResults — defaults', () => {
    it('empty results with query', () => {
        assert.equal(formatRecallResults([], { query: 'foo' }), 'No results found for "foo".');
    });

    it('empty results without query', () => {
        assert.equal(formatRecallResults([], {}), 'No matching sessions found.');
    });

    it('tolerates non-array input', () => {
        assert.equal(formatRecallResults(null), 'No matching sessions found.');
        assert.equal(formatRecallResults(undefined), 'No matching sessions found.');
    });

    it('shows title/body/matched with no score by default', () => {
        const out = formatRecallResults([sampleResult], { query: 'cron' });
        assert.ok(out.includes('Found 1 result(s) for "cron":'));
        assert.ok(out.includes('### 1. Cron audit (2026-04-18, main)'));
        assert.ok(out.includes('We reviewed all the crons'));
        assert.ok(out.includes('Matched turn:'));
        assert.ok(!out.includes('Score:'));
    });

    it('includes score when showScore: true', () => {
        const out = formatRecallResults([sampleResult], { query: 'cron', showScore: true });
        assert.match(out, /Score: 0\.\d{3}/);
    });

    it('falls back to summaryText when no structuredSummary.title', () => {
        const r = { sessionId: 'x', agentId: 'main', startedAt: null, summaryText: 'Just a summary', structuredSummary: null };
        const out = formatRecallResults([r]);
        assert.ok(out.includes('Just a summary'));
    });

    it('renders "(untitled)" when nothing available', () => {
        const r = { sessionId: 'x', agentId: 'main', startedAt: null, summaryText: '', structuredSummary: null };
        const out = formatRecallResults([r]);
        assert.ok(out.includes('(untitled)'));
    });

    it('numbers multiple results', () => {
        const out = formatRecallResults([sampleResult, sampleResult, sampleResult]);
        assert.ok(out.includes('### 1.'));
        assert.ok(out.includes('### 2.'));
        assert.ok(out.includes('### 3.'));
    });
});

// ---------------------------------------------------------------------------

describe('createRecallFormatter — overrides', () => {
    it('can override title renderer (e.g. persona zh-TW)', () => {
        const fmt = createRecallFormatter({
            title: (r, i) => `第 ${i + 1} 筆：${r.structuredSummary?.title || '無題'}`,
            header: () => null,
        });
        const out = fmt([sampleResult]);
        assert.ok(out.includes('第 1 筆：Cron audit'));
        assert.ok(!out.includes('###'));
    });

    it('can hide matched turn', () => {
        const fmt = createRecallFormatter({ matched: () => null });
        const out = fmt([sampleResult]);
        assert.ok(!out.includes('Matched turn'));
    });

    it('can replace empty message', () => {
        const fmt = createRecallFormatter({ empty: () => '找不到。' });
        assert.equal(fmt([]), '找不到。');
    });

    it('can fully replace body (persona narrative style)', () => {
        const fmt = createRecallFormatter({
            body: (r) => r.structuredSummary?.overview ? `⟶ ${r.structuredSummary.overview.slice(0, 50)}` : null,
        });
        const out = fmt([sampleResult]);
        assert.ok(out.includes('⟶ We reviewed all the crons'));
    });

    it('separator: null output omits blank line between items', () => {
        const fmt = createRecallFormatter({ separator: () => null });
        const out = fmt([sampleResult, sampleResult]);
        const lines = out.split('\n');
        const titleIdxs = lines.map((l, i) => l.startsWith('### ') ? i : -1).filter(i => i >= 0);
        assert.equal(titleIdxs.length, 2);
    });

    it('survives when a renderer returns undefined', () => {
        const fmt = createRecallFormatter({ matched: () => undefined, score: () => undefined });
        const out = fmt([sampleResult]);
        assert.ok(out.includes('Cron audit'));
    });
});

describe('explain renderer', () => {
    const resultWithDebug = {
        ...sampleResult,
        _debug: {
            rrf: 0.823,
            timeDecay: 0.714,
            access: 0.12,
            entityScore: 0.45,
            trustScore: 0.55,
            trustMultiplier: 1.05,
            openLoopBoost: 0,
            hybridScore: 0.682,
            rerankScore: null,
            rerankApplied: false,
            rerankReason: 'no_provider_configured',
            rerankFallback: false,
            searchErrors: [],
        },
    };

    it('showExplain=false omits breakdown', () => {
        const out = formatRecallResults([resultWithDebug], { showScore: true, showExplain: false });
        assert.ok(!out.includes('rrf='));
    });

    it('showExplain=true includes breakdown line', () => {
        const out = formatRecallResults([resultWithDebug], { showScore: true, showExplain: true });
        assert.ok(out.includes('rrf=0.823'));
        assert.ok(out.includes('td=0.714'));
        assert.ok(out.includes('entity=0.450'));
        assert.ok(out.includes('trust=0.550'));
        assert.ok(out.includes('hybrid=0.682'));
        assert.ok(out.includes('[rerank: off'));
    });

    it('showExplain=true with rerank applied shows rerank score', () => {
        const rerankResult = {
            ...resultWithDebug,
            _debug: { ...resultWithDebug._debug, rerankApplied: true, rerankScore: 0.91, rerankReason: 'forced' },
        };
        const out = formatRecallResults([rerankResult], { showScore: true, showExplain: true });
        assert.ok(out.includes('rerank=0.910(forced)'));
        assert.ok(!out.includes('[rerank: off'));
    });

    it('showExplain=true with search errors shows error paths', () => {
        const errResult = {
            ...resultWithDebug,
            _debug: { ...resultWithDebug._debug, searchErrors: [{ path: 'fts', message: 'timeout' }] },
        };
        const out = formatRecallResults([errResult], { showScore: true, showExplain: true });
        assert.ok(out.includes('errors: fts'));
    });

    it('no _debug object gracefully returns null', () => {
        const out = formatRecallResults([sampleResult], { showScore: true, showExplain: true });
        assert.ok(!out.includes('rrf='));
    });
});
