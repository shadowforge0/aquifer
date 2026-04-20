'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatRecallResults } = require('../consumers/miranda/recall-format');

const now = new Date('2026-04-20T12:00:00Z').getTime();
const day = 86400000;

const baseResult = {
    sessionId: 'ses-1',
    agentId: 'main',
    summaryText: '這段 session 在整理 cron 排程。',
    structuredSummary: {
        title: 'Cron 整理',
        overview: '把過期的 cron 收掉，新增 daily 跟 weekly 分層。',
    },
};

describe('miranda recall-format — relative time tag', () => {
    it('renders 今天 for same-day hits', () => {
        const r = { ...baseResult, startedAt: new Date(now - 3600000).toISOString() };
        const out = formatRecallResults([r], { now });
        assert.ok(out.includes('**Date**: 今天（'), `got:\n${out}`);
        assert.ok(out.includes('2026-04-20'));
    });

    it('renders 昨天 for 1-day-old hits', () => {
        const r = { ...baseResult, startedAt: new Date(now - 1.5 * day).toISOString() };
        const out = formatRecallResults([r], { now });
        assert.ok(out.includes('**Date**: 昨天（'), `got:\n${out}`);
    });

    it('renders N 天前 for 2-6 day hits with ISO parenthetical', () => {
        const r = { ...baseResult, startedAt: new Date(now - 3 * day).toISOString() };
        const out = formatRecallResults([r], { now });
        assert.ok(out.includes('**Date**: 3 天前（2026-04-17）'), `got:\n${out}`);
    });

    it('renders N 週前 for 1-4 week hits', () => {
        const r = { ...baseResult, startedAt: new Date(now - 14 * day).toISOString() };
        const out = formatRecallResults([r], { now });
        assert.ok(out.includes('2 週前（'), `got:\n${out}`);
    });

    it('falls back to ISO-only when startedAt invalid', () => {
        const r = { ...baseResult, startedAt: 'not a date' };
        const out = formatRecallResults([r], { now });
        assert.ok(out.includes('**Date**: unknown'), `got:\n${out}`);
        assert.ok(!out.includes('（'), 'no parenthetical when rel is null');
    });

    it('falls back to ISO-only for future timestamps', () => {
        const r = { ...baseResult, startedAt: new Date(now + day).toISOString() };
        const out = formatRecallResults([r], { now });
        assert.ok(out.includes('**Date**: 2026-04-21'));
        assert.ok(!out.includes('（2026-04-21）'), 'no rel prefix for future');
    });

    it('uses Date.now() when ctx.now omitted', () => {
        const r = { ...baseResult, startedAt: new Date(Date.now() - 2 * 3600000).toISOString() };
        const out = formatRecallResults([r]);
        assert.ok(out.includes('**Date**: 今天（'));
    });
});
