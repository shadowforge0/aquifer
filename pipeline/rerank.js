'use strict';

const { httpRequest, withRetry } = require('./_http');

// ---------------------------------------------------------------------------
// Custom adapter
// ---------------------------------------------------------------------------

function validateResults(results) {
  return results.filter(r =>
    r && typeof r.index === 'number' && Number.isFinite(r.index)
      && typeof r.score === 'number' && Number.isFinite(r.score)
  );
}

function createCustomReranker(config) {
  const fn = config.fn;
  if (!fn) throw new Error('fn is required for custom reranker');

  return {
    async rerank(query, documents, opts = {}) {
      if (!query || !documents || documents.length === 0) return [];
      const topN = opts.topN || documents.length;
      const results = await fn({ query, documents, topN });
      if (!Array.isArray(results)) throw new Error('Custom reranker fn must return an array');
      return validateResults(results).sort((a, b) => b.score - a.score);
    },
  };
}

// ---------------------------------------------------------------------------
// TEI adapter (HuggingFace Text Embeddings Inference)
// ---------------------------------------------------------------------------

function createTEIReranker(config) {
  const baseUrl = (config.teiBaseUrl || config.baseUrl || 'http://localhost:8080').replace(/\/+$/, '');
  const timeout = config.timeout || 2000;
  const maxRetries = config.maxRetries ?? 1;
  const initialBackoffMs = config.initialBackoffMs || 250;

  return {
    async rerank(query, documents, _opts = {}) {
      if (!query || !documents || documents.length === 0) return [];

      const result = await withRetry(
        () => httpRequest(`${baseUrl}/rerank`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout,
        }, { query, texts: documents, raw_scores: false }),
        { maxRetries, initialBackoffMs },
      );

      // TEI returns array of { index, score }
      const arr = Array.isArray(result) ? result : [];
      return validateResults(arr.map(r => ({ index: r.index, score: r.score })))
        .sort((a, b) => b.score - a.score);
    },
  };
}

// ---------------------------------------------------------------------------
// Jina adapter
// ---------------------------------------------------------------------------

function createJinaReranker(config) {
  const apiKey = config.jinaApiKey;
  if (!apiKey) throw new Error('jinaApiKey is required for Jina reranker');

  const model = config.jinaModel || 'jina-reranker-v2-base-multilingual';
  const baseUrl = (config.jinaBaseUrl || 'https://api.jina.ai/v1/rerank').replace(/\/+$/, '');
  const timeout = config.timeout || 2000;
  const maxRetries = config.maxRetries ?? 1;
  const initialBackoffMs = config.initialBackoffMs || 250;

  return {
    async rerank(query, documents, opts = {}) {
      if (!query || !documents || documents.length === 0) return [];
      const topN = opts.topN || documents.length;

      const result = await withRetry(
        () => httpRequest(baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          timeout,
        }, { model, query, documents, top_n: topN }),
        { maxRetries, initialBackoffMs },
      );

      // Jina returns { results: [{ index, relevance_score }] }
      const arr = result.results || [];
      return validateResults(arr.map(r => ({ index: r.index, score: r.relevance_score })))
        .sort((a, b) => b.score - a.score);
    },
  };
}

// ---------------------------------------------------------------------------
// OpenRouter adapter (Cohere rerank etc. via OpenRouter)
// ---------------------------------------------------------------------------

function createOpenRouterReranker(config) {
  const apiKey = config.openrouterApiKey || config.apiKey;
  if (!apiKey) throw new Error('openrouterApiKey is required for OpenRouter reranker');

  const model = config.model || 'cohere/rerank-v3.5';
  const baseUrl = (config.openrouterBaseUrl || 'https://openrouter.ai/api/v1/rerank').replace(/\/+$/, '');
  const timeout = config.timeout || 5000;
  const maxRetries = config.maxRetries ?? 1;
  const initialBackoffMs = config.initialBackoffMs || 250;

  return {
    async rerank(query, documents, opts = {}) {
      if (!query || !documents || documents.length === 0) return [];
      const topN = opts.topN || documents.length;

      const result = await withRetry(
        () => httpRequest(baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          timeout,
        }, { model, query, documents, top_n: topN }),
        { maxRetries, initialBackoffMs },
      );

      // OpenRouter returns { results: [{ index, relevance_score }] }
      const arr = result.results || [];
      return validateResults(arr.map(r => ({ index: r.index, score: r.relevance_score })))
        .sort((a, b) => b.score - a.score);
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createReranker(config = {}) {
  const provider = config.provider || 'custom';

  switch (provider) {
    case 'custom':
      return createCustomReranker(config);
    case 'tei':
      return createTEIReranker(config);
    case 'jina':
      return createJinaReranker(config);
    case 'openrouter':
      return createOpenRouterReranker(config);
    default:
      throw new Error(`Unknown rerank provider: ${provider}`);
  }
}

module.exports = { createReranker };
