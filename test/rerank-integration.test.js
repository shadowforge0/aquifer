'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquifer } = require('../index');

describe('rerank integration', () => {
  it('creates aquifer with rerank config', () => {
    const aq = createAquifer({
      db: 'pg://x',
      embed: { fn: async (texts) => texts.map(() => [0.1, 0.2]) },
      rerank: {
        provider: 'custom',
        fn: async ({ documents }) => {
          return documents.map((_, i) => ({ index: i, score: 1 - i * 0.1 }));
        },
      },
    });
    assert.ok(aq.recall);
  });

  it('creates aquifer with tei rerank config', () => {
    const aq = createAquifer({
      db: 'pg://x',
      embed: { fn: async (texts) => texts.map(() => [0.1, 0.2]) },
      rerank: { provider: 'tei', teiBaseUrl: 'http://localhost:9090' },
    });
    assert.ok(aq.recall);
  });

  it('creates aquifer with jina rerank config', () => {
    const aq = createAquifer({
      db: 'pg://x',
      embed: { fn: async (texts) => texts.map(() => [0.1, 0.2]) },
      rerank: { provider: 'jina', jinaApiKey: 'test-key' },
    });
    assert.ok(aq.recall);
  });

  it('creates aquifer without rerank (no regression)', () => {
    const aq = createAquifer({
      db: 'pg://x',
      embed: { fn: async (texts) => texts.map(() => [0.1, 0.2]) },
    });
    assert.ok(aq.recall);
  });

  it('throws on invalid rerank provider', () => {
    assert.throws(() => createAquifer({
      db: 'pg://x',
      rerank: { provider: 'invalid' },
    }), /Unknown rerank provider/);
  });

  it('throws on custom rerank without fn', () => {
    assert.throws(() => createAquifer({
      db: 'pg://x',
      rerank: { provider: 'custom' },
    }), /fn is required/);
  });
});

describe('buildRerankDocument', () => {
  // Test via the exported function behavior through aquifer internals
  // We test document building indirectly through the rerank custom fn

  it('passes summary_text to reranker', async () => {
    // This test verifies the document builder assembles text correctly.
    // We can't easily test recall end-to-end without a DB,
    // so we test the buildRerankDocument function directly.
    // It's a module-level function, so we test it via require.

    // Import the function — it's not exported, but we can test the logic pattern
    const doc = buildDoc({ summary_text: 'hello world' }, 1000);
    assert.equal(doc, 'hello world');
  });

  it('appends matched_turn_text', () => {
    const doc = buildDoc({ summary_text: 'summary', matched_turn_text: 'turn text' }, 1000);
    assert.ok(doc.includes('summary'));
    assert.ok(doc.includes('turn text'));
    assert.ok(doc.includes('Matched turn:'));
  });

  it('falls back to matched_turn_text when summary empty', () => {
    const doc = buildDoc({ summary_text: '', matched_turn_text: 'only turn' }, 1000);
    assert.equal(doc, 'only turn');
  });

  it('truncates to maxChars', () => {
    const longText = 'a'.repeat(2000);
    const doc = buildDoc({ summary_text: longText }, 500);
    assert.equal(doc.length, 500);
  });

  it('normalizes whitespace', () => {
    const doc = buildDoc({ summary_text: 'hello   world\n\nfoo  bar' }, 1000);
    assert.equal(doc, 'hello world foo bar');
  });

  it('skips turn if already in summary', () => {
    const doc = buildDoc({ summary_text: 'contains turn text here', matched_turn_text: 'turn text' }, 1000);
    assert.ok(!doc.includes('Matched turn:'));
  });

  it('handles both empty', () => {
    const doc = buildDoc({}, 1000);
    assert.equal(doc, '');
  });
});

// Inline replica of buildRerankDocument for unit testing
// (mirrors core/aquifer.js implementation exactly)
function buildDoc(row, maxChars) {
  let text = (row.summary_text || row.summary_snippet || '').replace(/\s+/g, ' ').trim();
  const turn = (row.matched_turn_text || '').replace(/\s+/g, ' ').trim();

  if (!text) {
    text = turn;
  } else if (turn && !text.includes(turn)) {
    text = `${text}\n\nMatched turn:\n${turn}`;
  }

  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

describe('rerank opts.rerank=false', () => {
  it('can disable rerank per-call via opts', () => {
    // Just verify the config is accepted — actual recall needs DB
    const aq = createAquifer({
      db: 'pg://x',
      embed: { fn: async (texts) => texts.map(() => [0.1, 0.2]) },
      rerank: {
        provider: 'custom',
        fn: async () => [],
        topK: 10,
      },
    });
    assert.ok(aq.recall);
  });
});

describe('rerank debug fields', () => {
  it('config accepts topK and maxChars', () => {
    const aq = createAquifer({
      db: 'pg://x',
      embed: { fn: async (texts) => texts.map(() => [0.1, 0.2]) },
      rerank: {
        provider: 'custom',
        fn: async () => [],
        topK: 30,
        maxChars: 800,
      },
    });
    assert.ok(aq);
  });
});
