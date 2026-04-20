'use strict';

const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// HTTP helper (same pattern as pipeline/embed.js)
// ---------------------------------------------------------------------------

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const req = transport.request(parsedUrl, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (timer) clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // Truncate error body to avoid leaking prompt content from echo-back proxies
          const safeBody = raw.slice(0, 200).replace(/[\n\r]/g, ' ');
          const err = new Error(`LLM HTTP ${res.statusCode}: ${safeBody}`);
          err.statusCode = res.statusCode;
          finish(reject, err);
          return;
        }
        try {
          finish(resolve, JSON.parse(raw));
        } catch {
          finish(reject, new Error(`Invalid JSON from LLM (${raw.length} bytes)`));
        }
      });
    });

    const timer = options.timeout
      ? setTimeout(() => { req.destroy(); finish(reject, new Error('LLM request timeout')); }, options.timeout)
      : null;

    req.on('error', (e) => { if (timer) clearTimeout(timer); finish(reject, e); });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

const RETRYABLE_CODES = new Set([408, 429, 500, 502, 503, 504]);

async function withRetry(fn, { maxRetries = 3, initialBackoffMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, initialBackoffMs * Math.pow(2, attempt - 1)));
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry non-retryable HTTP errors or timeouts
      if (err.statusCode && !RETRYABLE_CODES.has(err.statusCode)) throw err;
      if (err.message === 'LLM request timeout') throw err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// createLlmFn
// ---------------------------------------------------------------------------

function createLlmFn(config = {}) {
  const baseUrl = config.baseUrl;
  const model = config.model;
  const apiKey = config.apiKey || null;
  const timeoutMs = config.timeoutMs || 60000;
  const maxRetries = config.maxRetries || 3;
  const initialBackoffMs = config.initialBackoffMs || 2000;
  const temperature = config.temperature ?? 0;

  if (!baseUrl) throw new Error('LLM config requires baseUrl');
  if (!model) throw new Error('LLM config requires model');

  const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  return async function llmFn(prompt) {
    const body = JSON.stringify({
      model,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    });

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const data = await withRetry(
      () => httpRequest(endpoint, {
        method: 'POST',
        headers,
        timeout: timeoutMs,
      }, body),
      { maxRetries, initialBackoffMs }
    );

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('LLM response missing choices[0].message.content');
    }
    return content;
  };
}

module.exports = { createLlmFn };
