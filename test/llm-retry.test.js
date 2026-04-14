'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createLlmFn } = require('../consumers/shared/llm');

// ---------------------------------------------------------------------------
// Helper: local HTTP server returning controlled responses
// ---------------------------------------------------------------------------

function createTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('llm response parsing', () => {
  it('extracts content from valid OpenAI-format response', async () => {
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'hello from LLM' } }],
      }));
    });

    try {
      const fn = createLlmFn({ baseUrl, model: 'test', maxRetries: 1 });
      const result = await fn('prompt');
      assert.equal(result, 'hello from LLM');
    } finally {
      await closeServer(server);
    }
  });

  it('throws on missing choices[0].message.content', async () => {
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [] }));
    });

    try {
      const fn = createLlmFn({ baseUrl, model: 'test', maxRetries: 1 });
      await assert.rejects(() => fn('prompt'), /missing choices/);
    } finally {
      await closeServer(server);
    }
  });

  it('throws on non-JSON response', async () => {
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json');
    });

    try {
      const fn = createLlmFn({ baseUrl, model: 'test', maxRetries: 1 });
      await assert.rejects(() => fn('prompt'), /Invalid JSON/);
    } finally {
      await closeServer(server);
    }
  });

  it('throws on HTTP error with truncated body', async () => {
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('A'.repeat(500)); // long error body
    });

    try {
      const fn = createLlmFn({ baseUrl, model: 'test', maxRetries: 1 });
      await assert.rejects(() => fn('prompt'), (err) => {
        assert.ok(err.message.includes('400'));
        // Body should be truncated to 200 chars
        assert.ok(err.message.length < 300);
        return true;
      });
    } finally {
      await closeServer(server);
    }
  });
});

describe('llm retry logic', () => {
  it('retries on 500 and succeeds on second attempt', async () => {
    let attempt = 0;
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      attempt++;
      if (attempt === 1) {
        res.writeHead(500);
        res.end('server error');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'retry success' } }] }));
      }
    });

    try {
      const fn = createLlmFn({
        baseUrl, model: 'test',
        maxRetries: 3,
        initialBackoffMs: 50, // fast for testing
      });
      const result = await fn('prompt');
      assert.equal(result, 'retry success');
      assert.equal(attempt, 2);
    } finally {
      await closeServer(server);
    }
  });

  it('retries on 429 (rate limit)', async () => {
    let attempt = 0;
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      attempt++;
      if (attempt <= 2) {
        res.writeHead(429);
        res.end('rate limited');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }
    });

    try {
      const fn = createLlmFn({
        baseUrl, model: 'test',
        maxRetries: 3,
        initialBackoffMs: 50,
      });
      const result = await fn('prompt');
      assert.equal(result, 'ok');
      assert.equal(attempt, 3);
    } finally {
      await closeServer(server);
    }
  });

  it('does NOT retry on 400 (non-retryable)', async () => {
    let attempt = 0;
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      attempt++;
      res.writeHead(400);
      res.end('bad request');
    });

    try {
      const fn = createLlmFn({
        baseUrl, model: 'test',
        maxRetries: 3,
        initialBackoffMs: 50,
      });
      await assert.rejects(() => fn('prompt'), /400/);
      assert.equal(attempt, 1, 'should not retry 400');
    } finally {
      await closeServer(server);
    }
  });

  it('does NOT retry on 401 (auth error)', async () => {
    let attempt = 0;
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      attempt++;
      res.writeHead(401);
      res.end('unauthorized');
    });

    try {
      const fn = createLlmFn({
        baseUrl, model: 'test',
        maxRetries: 3,
        initialBackoffMs: 50,
      });
      await assert.rejects(() => fn('prompt'), /401/);
      assert.equal(attempt, 1);
    } finally {
      await closeServer(server);
    }
  });

  it('gives up after maxRetries exhausted', async () => {
    let attempt = 0;
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      attempt++;
      res.writeHead(503);
      res.end('unavailable');
    });

    try {
      const fn = createLlmFn({
        baseUrl, model: 'test',
        maxRetries: 2,
        initialBackoffMs: 50,
      });
      await assert.rejects(() => fn('prompt'), /503/);
      assert.equal(attempt, 2, 'should try exactly maxRetries times');
    } finally {
      await closeServer(server);
    }
  });

  it('sends correct request body (model, temperature, prompt)', async () => {
    let receivedBody = null;
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    });

    try {
      const fn = createLlmFn({
        baseUrl, model: 'gpt-test', temperature: 0.7,
        maxRetries: 1,
      });
      await fn('my prompt text');
      assert.equal(receivedBody.model, 'gpt-test');
      assert.equal(receivedBody.temperature, 0.7);
      assert.equal(receivedBody.messages[0].role, 'user');
      assert.equal(receivedBody.messages[0].content, 'my prompt text');
    } finally {
      await closeServer(server);
    }
  });

  it('sends Authorization header when apiKey is provided', async () => {
    let receivedHeaders = null;
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });

    try {
      const fn = createLlmFn({
        baseUrl, model: 'test', apiKey: 'sk-test-key',
        maxRetries: 1,
      });
      await fn('prompt');
      assert.equal(receivedHeaders.authorization, 'Bearer sk-test-key');
    } finally {
      await closeServer(server);
    }
  });

  it('does NOT send Authorization header when apiKey is null', async () => {
    let receivedHeaders = null;
    const { server, port, baseUrl } = await createTestServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });

    try {
      const fn = createLlmFn({
        baseUrl, model: 'test',
        maxRetries: 1,
      });
      await fn('prompt');
      assert.equal(receivedHeaders.authorization, undefined);
    } finally {
      await closeServer(server);
    }
  });
});
