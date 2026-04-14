'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createReranker } = require('../pipeline/rerank');

describe('createReranker', () => {
  it('throws on unknown provider', () => {
    assert.throws(() => createReranker({ provider: 'nope' }), /Unknown rerank provider/);
  });

  it('throws when custom provider missing fn', () => {
    assert.throws(() => createReranker({ provider: 'custom' }), /fn is required/);
  });

  it('throws when jina provider missing apiKey', () => {
    assert.throws(() => createReranker({ provider: 'jina' }), /jinaApiKey is required/);
  });
});

describe('custom reranker', () => {
  it('returns empty array for empty documents', async () => {
    const reranker = createReranker({
      provider: 'custom',
      fn: async () => { throw new Error('should not be called'); },
    });
    const result = await reranker.rerank('query', []);
    assert.deepStrictEqual(result, []);
  });

  it('returns empty array for falsy query', async () => {
    const reranker = createReranker({
      provider: 'custom',
      fn: async () => { throw new Error('should not be called'); },
    });
    const result = await reranker.rerank('', ['doc']);
    assert.deepStrictEqual(result, []);
  });

  it('calls fn with correct args and returns sorted results', async () => {
    let captured;
    const reranker = createReranker({
      provider: 'custom',
      fn: async (args) => {
        captured = args;
        return [
          { index: 0, score: 0.3 },
          { index: 1, score: 0.9 },
          { index: 2, score: 0.6 },
        ];
      },
    });

    const result = await reranker.rerank('test query', ['doc a', 'doc b', 'doc c'], { topN: 2 });

    assert.equal(captured.query, 'test query');
    assert.deepStrictEqual(captured.documents, ['doc a', 'doc b', 'doc c']);
    assert.equal(captured.topN, 2);

    // Should be sorted by score desc
    assert.equal(result[0].index, 1);
    assert.equal(result[0].score, 0.9);
    assert.equal(result[1].index, 2);
    assert.equal(result[1].score, 0.6);
    assert.equal(result[2].index, 0);
    assert.equal(result[2].score, 0.3);
  });

  it('throws if fn returns non-array', async () => {
    const reranker = createReranker({
      provider: 'custom',
      fn: async () => 'not an array',
    });
    await assert.rejects(reranker.rerank('q', ['d']), /must return an array/);
  });

  it('defaults topN to documents.length', async () => {
    let captured;
    const reranker = createReranker({
      provider: 'custom',
      fn: async (args) => { captured = args; return []; },
    });
    await reranker.rerank('q', ['a', 'b', 'c']);
    assert.equal(captured.topN, 3);
  });
});

describe('tei reranker', () => {
  it('creates with default baseUrl', () => {
    const reranker = createReranker({ provider: 'tei' });
    assert.ok(reranker.rerank);
  });

  it('returns empty array for empty documents', async () => {
    const reranker = createReranker({ provider: 'tei' });
    const result = await reranker.rerank('query', []);
    assert.deepStrictEqual(result, []);
  });

  it('returns empty array for falsy query', async () => {
    const reranker = createReranker({ provider: 'tei' });
    const result = await reranker.rerank('', ['doc']);
    assert.deepStrictEqual(result, []);
  });
});

describe('custom reranker validation', () => {
  it('filters out results with missing index', async () => {
    const reranker = createReranker({
      provider: 'custom',
      fn: async () => [
        { score: 0.9 },          // missing index
        { index: 1, score: 0.8 },
        { index: undefined, score: 0.7 }, // undefined index
      ],
    });
    const result = await reranker.rerank('q', ['a', 'b', 'c']);
    assert.equal(result.length, 1);
    assert.equal(result[0].index, 1);
  });

  it('filters out results with NaN score', async () => {
    const reranker = createReranker({
      provider: 'custom',
      fn: async () => [
        { index: 0, score: NaN },
        { index: 1, score: 0.5 },
      ],
    });
    const result = await reranker.rerank('q', ['a', 'b']);
    assert.equal(result.length, 1);
    assert.equal(result[0].index, 1);
  });

  it('handles negative scores correctly', async () => {
    const reranker = createReranker({
      provider: 'custom',
      fn: async () => [
        { index: 0, score: -0.5 },
        { index: 1, score: 0.3 },
      ],
    });
    const result = await reranker.rerank('q', ['a', 'b']);
    assert.equal(result.length, 2);
    assert.equal(result[0].index, 1);  // 0.3 > -0.5
    assert.equal(result[1].index, 0);
  });
});

describe('openrouter reranker', () => {
  it('throws when missing apiKey', () => {
    assert.throws(() => createReranker({ provider: 'openrouter' }), /openrouterApiKey is required/);
  });

  it('creates with apiKey', () => {
    const reranker = createReranker({ provider: 'openrouter', openrouterApiKey: 'test' });
    assert.ok(reranker.rerank);
  });

  it('returns empty array for empty documents', async () => {
    const reranker = createReranker({ provider: 'openrouter', openrouterApiKey: 'test' });
    const result = await reranker.rerank('query', []);
    assert.deepStrictEqual(result, []);
  });

  it('accepts apiKey alias', () => {
    const reranker = createReranker({ provider: 'openrouter', apiKey: 'test' });
    assert.ok(reranker.rerank);
  });
});

describe('jina reranker', () => {
  it('returns empty array for empty documents', async () => {
    const reranker = createReranker({ provider: 'jina', jinaApiKey: 'test-key' });
    const result = await reranker.rerank('query', []);
    assert.deepStrictEqual(result, []);
  });

  it('returns empty array for falsy query', async () => {
    const reranker = createReranker({ provider: 'jina', jinaApiKey: 'test-key' });
    const result = await reranker.rerank('', ['doc']);
    assert.deepStrictEqual(result, []);
  });
});
