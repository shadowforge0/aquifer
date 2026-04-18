'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Reset module state between suites so the singleton doesn't bleed across tests
function freshRequire() {
    delete require.cache[require.resolve('../consumers/miranda')];
    delete require.cache[require.resolve('../consumers/miranda/instance')];
    return require('../consumers/miranda');
}

function makeMockPool() {
    const queries = [];
    return {
        queries,
        async query(sql, params) {
            queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
            return { rowCount: 0, rows: [] };
        },
        async connect() {
            return {
                async query(sql, params) {
                    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
                    return { rowCount: 0, rows: [] };
                },
                release() {},
            };
        },
        async end() {},
    };
}

function fakeEmbed(texts) {
    return Promise.resolve((texts || []).map(() => new Array(8).fill(0.1)));
}

// ---------------------------------------------------------------------------

describe('miranda exports', () => {
    it('exposes mount helpers + persona sub-modules', () => {
        const miranda = freshRequire();
        assert.equal(typeof miranda.mountOnOpenClaw, 'function');
        assert.equal(typeof miranda.buildPostProcess, 'function');
        assert.equal(typeof miranda.buildSummaryFn, 'function');
        assert.equal(typeof miranda.buildEntityParseFn, 'function');
        assert.ok(miranda.summary);
        assert.ok(miranda.dailyEntries);
        assert.ok(miranda.workspaceFiles);
        assert.ok(miranda.contextInject);
        assert.ok(miranda.recallFormat);
    });
});

describe('buildSummaryFn', () => {
    it('throws on empty conversation', async () => {
        const miranda = freshRequire();
        const fn = miranda.buildSummaryFn({ agentId: 'main', now: new Date() });
        await assert.rejects(() => fn([]), /empty conversation/);
    });

    it('extractConversationText joins user/assistant turns', () => {
        const miranda = freshRequire();
        const text = miranda.extractConversationText([
            { role: 'user', content: 'hi' },
            { role: 'system', content: 'sys' },
            { role: 'assistant', content: 'hey' },
        ]);
        assert.ok(text.includes('[user] hi'));
        assert.ok(text.includes('[assistant] hey'));
        assert.ok(!text.includes('sys'));
    });
});

describe('buildEntityParseFn', () => {
    it('parses ENTITY/RELATION output into Aquifer-shaped entities', () => {
        const miranda = freshRequire();
        const fn = miranda.buildEntityParseFn();
        const entities = fn('ENTITY: Aquifer | project | -');
        assert.equal(entities.length, 1);
        assert.equal(entities[0].name, 'Aquifer');
        assert.equal(entities[0].type, 'project');
        assert.ok(entities[0].normalizedName);
    });
});

describe('buildPostProcess — validation', () => {
    it('throws without aquifer', () => {
        const miranda = freshRequire();
        assert.throws(() => miranda.buildPostProcess({ pool: makeMockPool(), agentId: 'main' }), /aquifer is required/);
    });
    it('throws without pool', () => {
        const miranda = freshRequire();
        assert.throws(() => miranda.buildPostProcess({ aquifer: {}, agentId: 'main' }), /pool is required/);
    });
    it('throws without agentId', () => {
        const miranda = freshRequire();
        assert.throws(() => miranda.buildPostProcess({ aquifer: {}, pool: makeMockPool() }), /agentId is required/);
    });
    it('returns an async fn', () => {
        const miranda = freshRequire();
        const pp = miranda.buildPostProcess({ aquifer: {}, pool: makeMockPool(), agentId: 'main' });
        assert.equal(typeof pp, 'function');
    });
});

describe('buildPostProcess — behavior', () => {
    it('writes daily entries when recap or sections present', async () => {
        const miranda = freshRequire();
        const pool = makeMockPool();
        const aquifer = { async consolidate() {} };
        const pp = miranda.buildPostProcess({ aquifer, pool, agentId: 'main', logger: { info() {}, warn() {} } });

        await pp({
            session: { sessionId: 'ses-1' },
            extra: {
                sections: { session_entries: '- (10:00) 寫完 spec' },
                recap: { title: 'T', overview: 'O' },
                workingFacts: [],
            },
            normalized: [],
        });

        const inserts = pool.queries.filter(q => q.sql.startsWith('INSERT INTO miranda.daily_entries'));
        assert.ok(inserts.length >= 1, 'expected at least one daily_entries INSERT');
    });

    it('calls aquifer.consolidate when workingFacts present', async () => {
        const miranda = freshRequire();
        const pool = makeMockPool();
        const consolidateCalls = [];
        const aquifer = {
            async consolidate(sessionId, opts) { consolidateCalls.push({ sessionId, opts }); return { create: 1 }; },
        };
        const pp = miranda.buildPostProcess({ aquifer, pool, agentId: 'main', logger: { info() {}, warn() {} } });

        await pp({
            session: { sessionId: 'ses-1' },
            extra: {
                sections: {},
                recap: { title: 'T', overview: 'O' },
                workingFacts: [
                    { subject: 'Aquifer', statement: '已補完 pipeline/consolidation' },
                ],
            },
            normalized: [],
        });

        assert.equal(consolidateCalls.length, 1);
        assert.equal(consolidateCalls[0].opts.actions[0].action, 'create');
        assert.equal(consolidateCalls[0].opts.actions[0].subject, 'Aquifer');
    });

    it('skips consolidate when consolidate: false', async () => {
        const miranda = freshRequire();
        const pool = makeMockPool();
        let called = false;
        const aquifer = { async consolidate() { called = true; } };
        const pp = miranda.buildPostProcess({
            aquifer, pool, agentId: 'main', consolidate: false, logger: { info() {}, warn() {} },
        });
        await pp({
            session: { sessionId: 's' },
            extra: { recap: { title: 'T', overview: 'O' }, sections: {}, workingFacts: [{ subject: 'X', statement: 'Y' }] },
            normalized: [],
        });
        assert.equal(called, false);
    });

    it('does not throw when daily entries DAL throws (best-effort)', async () => {
        const miranda = freshRequire();
        const pool = {
            async query() { throw new Error('db down'); },
            async connect() { throw new Error('db down'); },
        };
        const aquifer = { async consolidate() {} };
        const pp = miranda.buildPostProcess({ aquifer, pool, agentId: 'main', logger: { info() {}, warn() {} } });

        // Should resolve, not reject
        await pp({
            session: { sessionId: 'ses-1' },
            extra: { recap: { title: 'T', overview: 'O' }, sections: { session_entries: '- a' }, workingFacts: [] },
            normalized: [],
        });
    });
});

describe('mountOnOpenClaw — hook registration', () => {
    it('registers before_reset, before_prompt_build, and session_recall', () => {
        const miranda = freshRequire();
        const events = [];
        const tools = [];
        const fakeApi = {
            on(evt) { events.push(evt); },
            registerTool(fn) { tools.push(fn); },
            logger: { info() {}, warn() {} },
        };

        miranda.mountOnOpenClaw(fakeApi, { pool: makeMockPool(), embedFn: fakeEmbed });

        assert.ok(events.includes('before_reset'));
        assert.ok(events.includes('before_prompt_build'));
        assert.equal(tools.length, 1);
        // Resolve the tool descriptor (factory takes ctx)
        const descriptor = tools[0]({ sessionKey: 'main:session:123' });
        assert.equal(descriptor.name, 'session_recall');
    });

    it('session_recall factory returns null for subagent sessions', () => {
        const miranda = freshRequire();
        let toolFactory = null;
        const fakeApi = {
            on() {},
            registerTool(fn) { toolFactory = fn; },
            logger: { info() {}, warn() {} },
        };
        miranda.mountOnOpenClaw(fakeApi, { pool: makeMockPool(), embedFn: fakeEmbed });
        assert.equal(toolFactory({ sessionKey: 'main:subagent:xyz' }), null);
    });
});
