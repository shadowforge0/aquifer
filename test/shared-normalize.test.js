'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMessages, extractRawMeta } = require('../consumers/shared/normalize');

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function gatewayEntry({ role, content, timestamp = null, model = null, usage = null }) {
    return {
        type: 'message',
        timestamp,
        message: { role, content, ...(model ? { model } : {}), ...(usage ? { usage } : {}) },
    };
}

function ccEntry({ role, content, timestamp = null, model = null, usage = null }) {
    return {
        type: role,
        timestamp,
        message: { role, content, ...(model ? { model } : {}), ...(usage ? { usage } : {}) },
    };
}

// ---------------------------------------------------------------------------

describe('normalizeMessages — empty input', () => {
    it('returns zeroed shape for null', () => {
        const out = normalizeMessages(null);
        assert.equal(out.messages.length, 0);
        assert.equal(out.userCount, 0);
        assert.equal(out.assistantCount, 0);
        assert.equal(out.model, null);
        assert.equal(out.tokensIn, 0);
        assert.equal(out.tokensOut, 0);
        assert.equal(out.startedAt, null);
        assert.equal(out.lastMessageAt, null);
    });

    it('returns zeroed shape for empty array', () => {
        const out = normalizeMessages([]);
        assert.equal(out.messages.length, 0);
    });

    it('tolerates non-array input', () => {
        const out = normalizeMessages('not an array');
        assert.equal(out.messages.length, 0);
    });
});

describe('normalizeMessages — adapter selection', () => {
    it('throws on unknown adapter name', () => {
        assert.throws(
            () => normalizeMessages([gatewayEntry({ role: 'user', content: 'hi' })], { adapter: 'bogus' }),
            /Unknown adapter/,
        );
    });

    it('accepts adapter alias "cc" as claude-code', () => {
        const entries = [
            ccEntry({ role: 'user', content: 'hi', timestamp: '2026-04-18T10:00:00Z' }),
            ccEntry({ role: 'assistant', content: 'hello', timestamp: '2026-04-18T10:00:05Z' }),
        ];
        const out = normalizeMessages(entries, { adapter: 'cc' });
        assert.equal(out.userCount, 1);
        assert.equal(out.assistantCount, 1);
    });

    it('accepts explicit "gateway" adapter', () => {
        const entries = [
            gatewayEntry({ role: 'user', content: 'hi' }),
            gatewayEntry({ role: 'assistant', content: 'hey' }),
        ];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.equal(out.messages.length, 2);
    });

    it('auto-detects when adapter omitted', () => {
        const entries = [
            gatewayEntry({ role: 'user', content: 'hi' }),
            gatewayEntry({ role: 'assistant', content: 'hey' }),
        ];
        const out = normalizeMessages(entries);
        assert.equal(out.messages.length, 2);
    });
});

describe('normalizeMessages — output shape (gateway)', () => {
    it('produces commit-ready { role, content, timestamp }', () => {
        const entries = [
            gatewayEntry({ role: 'user', content: 'ping', timestamp: '2026-04-18T10:00:00Z' }),
            gatewayEntry({ role: 'assistant', content: 'pong', timestamp: '2026-04-18T10:00:03Z' }),
        ];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.equal(out.messages.length, 2);
        assert.equal(out.messages[0].role, 'user');
        assert.equal(out.messages[0].content, 'ping');
        assert.equal(new Date(out.messages[0].timestamp).toISOString(), '2026-04-18T10:00:00.000Z');
        assert.equal(out.messages[1].role, 'assistant');
        assert.equal(out.messages[1].content, 'pong');
    });

    it('counts users and assistants', () => {
        const entries = [
            gatewayEntry({ role: 'user', content: 'q1' }),
            gatewayEntry({ role: 'assistant', content: 'a1' }),
            gatewayEntry({ role: 'user', content: 'q2' }),
            gatewayEntry({ role: 'assistant', content: 'a2' }),
            gatewayEntry({ role: 'user', content: 'q3' }),
        ];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.equal(out.userCount, 3);
        assert.equal(out.assistantCount, 2);
    });

    it('captures startedAt and lastMessageAt from timestamps', () => {
        const entries = [
            gatewayEntry({ role: 'user', content: 'hi', timestamp: '2026-04-18T09:00:00Z' }),
            gatewayEntry({ role: 'assistant', content: 'hey', timestamp: '2026-04-18T09:00:05Z' }),
            gatewayEntry({ role: 'user', content: 'bye', timestamp: '2026-04-18T09:05:00Z' }),
        ];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.equal(new Date(out.startedAt).toISOString(), '2026-04-18T09:00:00.000Z');
        assert.equal(new Date(out.lastMessageAt).toISOString(), '2026-04-18T09:05:00.000Z');
    });

    it('leaves startedAt/lastMessageAt null when no timestamps', () => {
        const entries = [
            gatewayEntry({ role: 'user', content: 'hi' }),
            gatewayEntry({ role: 'assistant', content: 'hey' }),
        ];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.equal(out.startedAt, null);
        assert.equal(out.lastMessageAt, null);
    });

    it('aggregates model from first message with model set', () => {
        const entries = [
            gatewayEntry({ role: 'user', content: 'hi' }),
            gatewayEntry({ role: 'assistant', content: 'a', model: 'claude-opus-4-7' }),
            gatewayEntry({ role: 'assistant', content: 'b', model: 'claude-opus-4-6' }),
        ];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.equal(out.model, 'claude-opus-4-7');
    });

    it('sums token usage across entries', () => {
        const entries = [
            gatewayEntry({ role: 'assistant', content: 'a', usage: { input_tokens: 10, output_tokens: 5 } }),
            gatewayEntry({ role: 'assistant', content: 'b', usage: { input_tokens: 20, output_tokens: 15 } }),
        ];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.equal(out.tokensIn, 30);
        assert.equal(out.tokensOut, 20);
    });
});

describe('normalizeMessages — output shape (claude-code)', () => {
    it('processes cc entries and produces same shape', () => {
        const entries = [
            ccEntry({ role: 'user', content: 'hi', timestamp: '2026-04-18T10:00:00Z' }),
            ccEntry({ role: 'assistant', content: 'hello', timestamp: '2026-04-18T10:00:05Z' }),
        ];
        const out = normalizeMessages(entries, { adapter: 'cc' });
        assert.equal(out.userCount, 1);
        assert.equal(out.assistantCount, 1);
        assert.equal(out.messages[0].content, 'hi');
        assert.equal(new Date(out.startedAt).toISOString(), '2026-04-18T10:00:00.000Z');
    });
});

describe('normalizeMessages — passes through skipStats / boundaries / toolsUsed', () => {
    it('includes skipStats from pipeline/normalize', () => {
        const entries = [gatewayEntry({ role: 'user', content: 'hi' })];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.equal(typeof out.skipStats, 'object');
        assert.equal(typeof out.skipStats.total, 'number');
    });

    it('toolsUsed is an array', () => {
        const entries = [gatewayEntry({ role: 'user', content: 'hi' })];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.ok(Array.isArray(out.toolsUsed));
    });

    it('boundaries is an array', () => {
        const entries = [gatewayEntry({ role: 'user', content: 'hi' })];
        const out = normalizeMessages(entries, { adapter: 'gateway' });
        assert.ok(Array.isArray(out.boundaries));
    });
});

describe('extractRawMeta', () => {
    it('returns nulls/zeros for empty input', () => {
        const out = extractRawMeta([]);
        assert.equal(out.model, null);
        assert.equal(out.tokensIn, 0);
        assert.equal(out.tokensOut, 0);
    });

    it('tolerates null and non-object entries', () => {
        const out = extractRawMeta([null, 'junk', undefined, 42]);
        assert.equal(out.model, null);
        assert.equal(out.tokensIn, 0);
    });

    it('handles legacy usage field names (input/output)', () => {
        const out = extractRawMeta([
            { message: { usage: { input: 100, output: 50 } } },
        ]);
        assert.equal(out.tokensIn, 100);
        assert.equal(out.tokensOut, 50);
    });
});
