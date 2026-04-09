'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLlmFn } = require('../consumers/shared/llm');

describe('llm.createLlmFn', () => {
  it('throws if baseUrl missing', () => {
    assert.throws(() => createLlmFn({ model: 'gpt-4o' }), /baseUrl/);
  });

  it('throws if model missing', () => {
    assert.throws(() => createLlmFn({ baseUrl: 'http://localhost' }), /model/);
  });

  it('returns a function', () => {
    const fn = createLlmFn({ baseUrl: 'http://localhost', model: 'test' });
    assert.equal(typeof fn, 'function');
  });

  it('rejects on unreachable host', async () => {
    const fn = createLlmFn({
      baseUrl: 'http://127.0.0.1:19999',
      model: 'test',
      timeoutMs: 2000,
      maxRetries: 1,
    });
    await assert.rejects(() => fn('hello'), /ECONNREFUSED|timeout|socket/i);
  });
});
