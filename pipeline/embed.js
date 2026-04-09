'use strict';

const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    // M8 fix: settled flag to prevent double-settle on timeout race
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const req = transport.request(parsedUrl, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (timer) clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(reject, new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
          return;
        }
        try {
          finish(resolve, JSON.parse(raw));
        } catch (e) {
          finish(reject, new Error(`Invalid JSON response: ${raw.slice(0, 200)}`));
        }
      });
    });

    const timer = options.timeout
      ? setTimeout(() => { req.destroy(); finish(reject, new Error('Request timeout')); }, options.timeout)
      : null;

    req.on('error', (err) => { if (timer) clearTimeout(timer); finish(reject, err); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

async function withRetry(fn, { maxRetries = 3, initialBackoffMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        const delay = initialBackoffMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Ollama adapter
// ---------------------------------------------------------------------------

function createOllamaEmbedder(config) {
  const url = config.ollamaUrl || 'http://localhost:11434';
  const model = config.model || 'bge-m3';
  const chunkSize = config.chunkSize || 32;
  const timeout = config.timeout || 120000;
  const maxRetries = config.maxRetries || 3;
  const initialBackoffMs = config.initialBackoffMs || 2000;
  let detectedDim = null;

  async function embedBatchRaw(texts) {
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += chunkSize) {
      const chunk = texts.slice(i, i + chunkSize);
      const result = await withRetry(
        () => httpRequest(
          `${url}/api/embed`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout,
          },
          { model, input: chunk }
        ),
        { maxRetries, initialBackoffMs }
      );

      const embeddings = result.embeddings || [];
      allEmbeddings.push(...embeddings);

      if (!detectedDim && embeddings.length > 0 && embeddings[0]) {
        detectedDim = embeddings[0].length;
      }
    }

    return allEmbeddings;
  }

  return {
    embed: async (text) => {
      const results = await embedBatchRaw([text]);
      return results[0] || [];
    },
    embedBatch: async (texts) => {
      if (!texts || texts.length === 0) return [];
      return embedBatchRaw(texts);
    },
    get dim() { return detectedDim; },
  };
}

// ---------------------------------------------------------------------------
// OpenAI adapter
// ---------------------------------------------------------------------------

function createOpenAIEmbedder(config) {
  const apiKey = config.openaiApiKey;
  if (!apiKey) throw new Error('openaiApiKey is required for OpenAI embedder');

  const model = config.openaiModel || 'text-embedding-3-small';
  const dimensions = config.openaiDimensions || 1536;
  const maxRetries = config.maxRetries || 3;
  const initialBackoffMs = config.initialBackoffMs || 2000;
  const timeout = config.timeout || 120000;

  const chunkSize = config.chunkSize || 100; // M7: batch chunking for OpenAI

  async function embedBatchRaw(texts) {
    const allEmbeddings = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
      const chunk = texts.slice(i, i + chunkSize);
      const result = await withRetry(
        () => httpRequest(
          'https://api.openai.com/v1/embeddings',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            timeout,
          },
          { model, input: chunk, dimensions }
        ),
        { maxRetries, initialBackoffMs }
      );

      const data = result.data || [];
      data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...data.map(d => d.embedding));
    }
    return allEmbeddings;
  }

  return {
    embed: async (text) => {
      const results = await embedBatchRaw([text]);
      return results[0] || [];
    },
    embedBatch: async (texts) => {
      if (!texts || texts.length === 0) return [];
      return embedBatchRaw(texts);
    },
    get dim() { return dimensions; },
  };
}

// ---------------------------------------------------------------------------
// Custom adapter
// ---------------------------------------------------------------------------

function createCustomEmbedder(config) {
  const fn = config.fn;
  if (!fn) throw new Error('fn is required for custom embedder');

  let detectedDim = null;

  return {
    embed: async (text) => {
      const results = await fn([text]);
      const vec = results[0] || [];
      if (!detectedDim && vec.length > 0) detectedDim = vec.length;
      return vec;
    },
    embedBatch: async (texts) => {
      if (!texts || texts.length === 0) return [];
      const results = await fn(texts);
      if (!detectedDim && results.length > 0 && results[0]) {
        detectedDim = results[0].length;
      }
      return results;
    },
    get dim() { return detectedDim; },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createEmbedder(config = {}) {
  const provider = config.provider || 'ollama';

  switch (provider) {
    case 'ollama':
      return createOllamaEmbedder(config);
    case 'openai':
      return createOpenAIEmbedder(config);
    case 'custom':
      return createCustomEmbedder(config);
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createEmbedder };
