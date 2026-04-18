'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    createRecallFormatter,
    formatRecallResults,
    truncate,
    formatDateIso,
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
