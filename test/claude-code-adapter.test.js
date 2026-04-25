'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cc = require('../consumers/claude-code');

function makeFakeAquifer(overrides = {}) {
    const calls = { enrich: [] };
    return {
        calls,
        async enrich(sessionId, opts) {
            calls.enrich.push({ sessionId, opts });
            if (overrides.enrichThrows) throw overrides.enrichThrows;
            return {
                turnsEmbedded: 3,
                entitiesFound: 1,
                warnings: [],
                postProcessError: overrides.postProcessError || null,
            };
        },
        async bootstrap() { return { text: '', sessions: [] }; },
    };
}

const silent = { info() {}, warn() {} };

// ---------------------------------------------------------------------------

describe('runEnrich', () => {
    it('throws on missing aquifer / sessionId / agentId', async () => {
        await assert.rejects(() => cc.runEnrich({ sessionId: 's', agentId: 'a' }), /aquifer is required/);
        await assert.rejects(() => cc.runEnrich({ aquifer: {}, agentId: 'a' }), /sessionId is required/);
        await assert.rejects(() => cc.runEnrich({ aquifer: {}, sessionId: 's' }), /agentId is required/);
    });

    it('delegates to aquifer.enrich with forwarded hooks', async () => {
        const aq = makeFakeAquifer();
        const sf = async () => ({ summaryText: '', structuredSummary: {} });
        const ep = () => [];
        const pp = async () => {};
        await cc.runEnrich({
            aquifer: aq, sessionId: 's1', agentId: 'main',
            summaryFn: sf, entityParseFn: ep, postProcess: pp, logger: silent,
        });
        assert.equal(aq.calls.enrich.length, 1);
        assert.equal(aq.calls.enrich[0].sessionId, 's1');
        assert.equal(aq.calls.enrich[0].opts.agentId, 'main');
        assert.equal(aq.calls.enrich[0].opts.summaryFn, sf);
        assert.equal(aq.calls.enrich[0].opts.entityParseFn, ep);
        assert.equal(aq.calls.enrich[0].opts.postProcess, pp);
    });

    it('returns enrich result including postProcessError', async () => {
        const aq = makeFakeAquifer({ postProcessError: new Error('pp failed') });
        const warnings = [];
        const logger = { info() {}, warn(m) { warnings.push(m); } };
        const r = await cc.runEnrich({ aquifer: aq, sessionId: 's1', agentId: 'main', logger });
        assert.ok(r.postProcessError);
        assert.ok(warnings.some(w => w.includes('postProcess error')));
    });

    it('propagates enrich errors', async () => {
        const aq = makeFakeAquifer({ enrichThrows: new Error('stale claim') });
        await assert.rejects(
            () => cc.runEnrich({ aquifer: aq, sessionId: 's1', agentId: 'main', logger: silent }),
            /stale claim/,
        );
    });
});

describe('runBackfill', () => {
    it('throws on missing params', async () => {
        await assert.rejects(() => cc.runBackfill({}), /aquifer is required/);
        await assert.rejects(() => cc.runBackfill({ aquifer: {} }), /sessionIds must be an array/);
        await assert.rejects(
            () => cc.runBackfill({ aquifer: {}, sessionIds: ['s'] }),
            /buildHooks must be a function/,
        );
    });

    it('iterates sessions and separates successes from failures', async () => {
        const aq = makeFakeAquifer();
        let callCount = 0;
        const buildHooks = () => ({ summaryFn: null });
        // Inject one failure in the middle
        const origEnrich = aq.enrich.bind(aq);
        aq.enrich = async (sid, opts) => {
            callCount++;
            if (callCount === 2) throw new Error('boom');
            return origEnrich(sid, opts);
        };

        const { succeeded, failed } = await cc.runBackfill({
            aquifer: aq,
            sessionIds: ['s1', 's2', 's3'],
            buildHooks,
            agentId: 'main',
            logger: silent,
        });

        assert.equal(succeeded.length, 2);
        assert.equal(failed.length, 1);
        assert.equal(failed[0].sessionId, 's2');
        assert.ok(failed[0].error.includes('boom'));
    });

    it('calls buildHooks with sessionId + agentId for each session', async () => {
        const aq = makeFakeAquifer();
        const seen = [];
        await cc.runBackfill({
            aquifer: aq,
            sessionIds: ['a', 'b'],
            buildHooks: (sid, aid) => { seen.push([sid, aid]); return {}; },
            agentId: 'main',
            logger: silent,
        });
        assert.deepEqual(seen, [['a', 'main'], ['b', 'main']]);
    });
});

describe('runContextInject', () => {
    it('requires a caller-supplied context injector', async () => {
        await assert.rejects(() => cc.runContextInject({ agentId: 'main' }), /contextInjector is required/);
    });

    it('delegates to the supplied context injector', async () => {
        const seen = [];
        const out = await cc.runContextInject({
            agentId: 'main',
            contextInjector: async (opts) => {
                seen.push(opts.agentId);
                return 'context';
            },
        });

        assert.equal(out, 'context');
        assert.deepEqual(seen, ['main']);
    });

    it('supports the legacy computeInjection alias', async () => {
        const seen = [];
        const out = await cc.runContextInject({
            agentId: 'main',
            computeInjection: async (opts) => {
                seen.push(opts.agentId);
                return 'legacy context';
            },
        });

        assert.equal(out, 'legacy context');
        assert.deepEqual(seen, ['main']);
    });
});
