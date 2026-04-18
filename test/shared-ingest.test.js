'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runIngest } = require('../consumers/shared/ingest');

// ---------------------------------------------------------------------------
// Fake aquifer that records calls
// ---------------------------------------------------------------------------

function makeFakeAquifer(overrides = {}) {
    const calls = { commit: [], enrich: [], skip: [] };
    return {
        calls,
        async commit(sessionId, messages, opts) {
            calls.commit.push({ sessionId, messages, opts });
            if (overrides.commitThrows) throw overrides.commitThrows;
        },
        async enrich(sessionId, opts) {
            calls.enrich.push({ sessionId, opts });
            if (overrides.enrichThrows) throw overrides.enrichThrows;
            return { turnsEmbedded: 5, entitiesFound: 2, warnings: [], postProcessError: null };
        },
        async skip(sessionId, opts) {
            calls.skip.push({ sessionId, opts });
            if (overrides.skipThrows) throw overrides.skipThrows;
        },
    };
}

function makePreNorm({ userCount = 3, assistantCount = 3 } = {}) {
    const messages = [];
    for (let i = 0; i < userCount; i++) messages.push({ role: 'user', content: `u${i}`, timestamp: null });
    for (let i = 0; i < assistantCount; i++) messages.push({ role: 'assistant', content: `a${i}`, timestamp: null });
    return {
        messages,
        userCount, assistantCount,
        model: null, tokensIn: 0, tokensOut: 0,
        startedAt: null, lastMessageAt: null,
    };
}

const silentLogger = { info() {}, warn() {} };

// ---------------------------------------------------------------------------

describe('runIngest — validation', () => {
    it('throws without aquifer', async () => {
        await assert.rejects(() => runIngest({ sessionId: 's', agentId: 'a' }), /aquifer is required/);
    });
    it('throws without sessionId', async () => {
        const aq = makeFakeAquifer();
        await assert.rejects(() => runIngest({ aquifer: aq, agentId: 'a' }), /sessionId is required/);
    });
    it('throws without agentId', async () => {
        const aq = makeFakeAquifer();
        await assert.rejects(() => runIngest({ aquifer: aq, sessionId: 's' }), /agentId is required/);
    });
    it('throws when preNormalized adapter given without preNormalized payload', async () => {
        const aq = makeFakeAquifer();
        await assert.rejects(
            () => runIngest({ aquifer: aq, sessionId: 's', agentId: 'a', adapter: 'preNormalized', logger: silentLogger }),
            /preNormalized adapter requires/,
        );
    });
});

describe('runIngest — dedup + inFlight', () => {
    it('skips second call with recent dedup hit', async () => {
        const aq = makeFakeAquifer();
        const dedupMap = new Map();
        const r1 = await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized', preNormalized: makePreNorm(),
            dedupMap, logger: silentLogger,
        });
        assert.equal(r1.status, 'ok');
        const r2 = await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized', preNormalized: makePreNorm(),
            dedupMap, logger: silentLogger,
        });
        assert.equal(r2.status, 'dedup');
        assert.equal(aq.calls.commit.length, 1);
    });

    it('refuses concurrent run via inFlight', async () => {
        const aq = makeFakeAquifer();
        const inFlight = new Set(['main:s1']);
        const r = await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized', preNormalized: makePreNorm(),
            inFlight, logger: silentLogger,
        });
        assert.equal(r.status, 'dedup');
        assert.equal(r.skipReason, 'in_flight');
        // The guard should not have consumed our prepopulated inFlight entry
        assert.ok(inFlight.has('main:s1'));
    });

    it('clears inFlight after success', async () => {
        const aq = makeFakeAquifer();
        const inFlight = new Set();
        await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized', preNormalized: makePreNorm(),
            inFlight, logger: silentLogger,
        });
        assert.ok(!inFlight.has('main:s1'));
    });

    it('clears inFlight after commit throw', async () => {
        const aq = makeFakeAquifer({ commitThrows: new Error('bad commit') });
        const inFlight = new Set();
        await assert.rejects(() =>
            runIngest({
                aquifer: aq, sessionId: 's1', agentId: 'main',
                adapter: 'preNormalized', preNormalized: makePreNorm(),
                inFlight, logger: silentLogger,
            }),
            /bad commit/,
        );
        assert.ok(!inFlight.has('main:s1'));
    });
});

describe('runIngest — userCount gates', () => {
    it('skipped_empty when userCount is 0', async () => {
        const aq = makeFakeAquifer();
        const r = await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized',
            preNormalized: makePreNorm({ userCount: 0, assistantCount: 1 }),
            logger: silentLogger,
        });
        assert.equal(r.status, 'skipped_empty');
        assert.equal(aq.calls.commit.length, 0);
        assert.equal(aq.calls.skip.length, 0);
    });

    it('calls skip() and returns skipped_short when userCount below minUserMessages', async () => {
        const aq = makeFakeAquifer();
        const r = await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized',
            preNormalized: makePreNorm({ userCount: 1, assistantCount: 1 }),
            minUserMessages: 3,
            logger: silentLogger,
        });
        assert.equal(r.status, 'skipped_short');
        assert.equal(aq.calls.commit.length, 1);
        assert.equal(aq.calls.skip.length, 1);
        assert.equal(aq.calls.enrich.length, 0);
    });

    it('calls enrich() when userCount >= minUserMessages', async () => {
        const aq = makeFakeAquifer();
        const r = await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized',
            preNormalized: makePreNorm({ userCount: 3, assistantCount: 3 }),
            minUserMessages: 3,
            logger: silentLogger,
        });
        assert.equal(r.status, 'ok');
        assert.equal(aq.calls.commit.length, 1);
        assert.equal(aq.calls.enrich.length, 1);
        assert.equal(aq.calls.skip.length, 0);
        assert.equal(r.enrichResult.turnsEmbedded, 5);
    });
});

describe('runIngest — callbacks forwarded to enrich', () => {
    it('passes postProcess / summaryFn / entityParseFn', async () => {
        const aq = makeFakeAquifer();
        const pp = async () => {};
        const sf = async () => ({ summaryText: 'x', structuredSummary: {} });
        const ep = () => [];
        await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized', preNormalized: makePreNorm(),
            postProcess: pp, summaryFn: sf, entityParseFn: ep,
            logger: silentLogger,
        });
        assert.equal(aq.calls.enrich[0].opts.postProcess, pp);
        assert.equal(aq.calls.enrich[0].opts.summaryFn, sf);
        assert.equal(aq.calls.enrich[0].opts.entityParseFn, ep);
    });

    it('commit still succeeds even when enrich throws', async () => {
        const aq = makeFakeAquifer({ enrichThrows: new Error('llm down') });
        const r = await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized', preNormalized: makePreNorm(),
            logger: silentLogger,
        });
        assert.equal(r.status, 'ok');
        assert.equal(aq.calls.commit.length, 1);
        assert.equal(r.enrichResult, null);
    });
});

describe('runIngest — commit metadata passthrough', () => {
    it('forwards model/tokens/startedAt/lastMessageAt and source', async () => {
        const aq = makeFakeAquifer();
        const pre = {
            ...makePreNorm(),
            model: 'claude-opus-4-7',
            tokensIn: 100, tokensOut: 50,
            startedAt: '2026-04-18T10:00:00Z', lastMessageAt: '2026-04-18T10:05:00Z',
        };
        await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            source: 'openclaw', sessionKey: 'main:session:s1',
            adapter: 'preNormalized', preNormalized: pre,
            logger: silentLogger,
        });
        const commitOpts = aq.calls.commit[0].opts;
        assert.equal(commitOpts.model, 'claude-opus-4-7');
        assert.equal(commitOpts.tokensIn, 100);
        assert.equal(commitOpts.tokensOut, 50);
        assert.equal(commitOpts.startedAt, '2026-04-18T10:00:00Z');
        assert.equal(commitOpts.lastMessageAt, '2026-04-18T10:05:00Z');
        assert.equal(commitOpts.source, 'openclaw');
        assert.equal(commitOpts.sessionKey, 'main:session:s1');
    });

    it('falls back source to adapter name when not provided', async () => {
        const aq = makeFakeAquifer();
        await runIngest({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            adapter: 'preNormalized', preNormalized: makePreNorm(),
            logger: silentLogger,
        });
        assert.equal(aq.calls.commit[0].opts.source, 'preNormalized');
    });
});
