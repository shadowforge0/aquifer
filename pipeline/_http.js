'use strict';

const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// HTTP helpers (shared by embed.js and rerank.js)
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

module.exports = { httpRequest, withRetry };
