'use strict';

/**
 * Contract tests for consumers/openclaw-plugin internal helpers.
 *
 * OpenClaw before_reset hands the plugin a heterogeneous message list that can
 * contain tool_use / tool_result / image parts and non-conversation roles.
 * The plugin must only pass user/assistant/system turns with text content down
 * to aquifer.commit(), or downstream enrich/recall counts get polluted.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEntries, coerceRawEntries } = require('../consumers/openclaw-plugin');

describe('openclaw-plugin normalizeEntries role filter', () => {
  it('drops entries whose role is not user/assistant/system', () => {
    const raw = [
      { role: 'user', content: 'hi' },
      { role: 'toolResult', content: 'result payload' },
      { role: 'tool', content: 'tool call' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = normalizeEntries(raw);
    assert.equal(out.messages.length, 2, 'only user+assistant should pass through');
    assert.deepEqual(out.messages.map(m => m.role), ['user', 'assistant']);
    assert.equal(out.userCount, 1);
    assert.equal(out.assistantCount, 1);
  });

  it('strips non-text parts from array content', () => {
    const raw = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 't1', name: 'read', input: {} },
          { type: 'text', text: 'done' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        ],
      },
    ];
    const out = normalizeEntries(raw);
    assert.equal(out.messages.length, 2);
    assert.equal(out.messages[0].content, 'let me check\ndone');
    assert.equal(out.messages[1].content, '',
      'user turn with only tool_result must produce empty string, not crash');
    assert.equal(out.userCount, 1);
    assert.equal(out.assistantCount, 1);
  });

  it('skips entries without a role', () => {
    const raw = [
      { content: 'stray' },
      null,
      { role: 'user', content: 'real' },
    ];
    const out = normalizeEntries(raw);
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].content, 'real');
  });
});

describe('openclaw-plugin coerceRawEntries', () => {
  it('unwraps nested { message: { role, ... } } shape', () => {
    const raw = [
      { role: 'user', content: 'a' },
      { message: { role: 'assistant', content: 'b' } },
      { unrelated: true },
    ];
    const out = coerceRawEntries(raw);
    assert.equal(out.length, 2);
    assert.equal(out[0].content, 'a');
    assert.equal(out[1].content, 'b');
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(coerceRawEntries(null), []);
    assert.deepEqual(coerceRawEntries(undefined), []);
    assert.deepEqual(coerceRawEntries('not an array'), []);
  });
});
