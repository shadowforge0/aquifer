'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const { loadConfig } = require('../consumers/shared/config');
const { createLlmFn } = require('../consumers/shared/llm');
const { main: mcpMain } = require('../consumers/mcp');
const { createAquifer } = require('../core/aquifer');
const {
  upsertEntity,
  upsertEntityRelations,
  searchEntities,
  getEntityRelations,
  resolveEntities,
  normalizeEntityName,
  getSessionsByEntityIntersection,
} = require('../core/entity');
const {
  rrfFusion,
  timeDecay,
  accessScore,
  hybridRank,
} = require('../core/hybrid-rank');
const storage = require('../core/storage');
const {
  markStatus,
  extractUserTurns,
  upsertTurnEmbeddings,
  getMessages,
  recordFeedback,
} = storage;
const indexExports = require('../index');
const { createEmbedder } = require('../pipeline/embed');
const {
  defaultEntityPrompt,
  extractEntities,
} = require('../pipeline/extract-entities');
const {
  summarize,
  extractiveFallback,
} = require('../pipeline/summarize');

const ROOT = path.join(__dirname, '..');

function loadModuleFromSource(relativePath, { exportNames = [], mocks = {}, transformSource } = {}) {
  const filePath = path.join(ROOT, relativePath);
  let source = fs.readFileSync(filePath, 'utf8');
  if (typeof transformSource === 'function') source = transformSource(source);
  if (exportNames.length > 0) {
    source += `\nmodule.exports.__private = { ${exportNames.join(', ')} };\n`;
  }

  const mod = new Module(filePath, module);
  mod.filename = filePath;
  mod.paths = Module._nodeModulePaths(path.dirname(filePath));

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    mod._compile(source, filePath);
    return mod.exports;
  } finally {
    Module._load = originalLoad;
  }
}

async function withPatchedModuleLoad(mocks, fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      const value = mocks[request];
      if (value instanceof Error) throw value;
      return value;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return await fn();
  } finally {
    Module._load = originalLoad;
  }
}

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

async function captureExit(fn) {
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  process.exit = (code) => {
    throw new ExitError(code);
  };

  try {
    await fn();
    assert.fail('Expected process.exit to be called');
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
    return err.code;
  } finally {
    process.exit = originalExit;
    process.exitCode = originalExitCode;
  }
}

function captureConsole(method) {
  const original = console[method];
  const calls = [];
  console[method] = (...args) => {
    calls.push(args.join(' '));
  };
  return {
    calls,
    restore() {
      console[method] = original;
    },
  };
}

async function startServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const cliPrivate = loadModuleFromSource('consumers/cli.js', {
  exportNames: ['cmdRecall', 'cmdBackfill', 'cmdStats', 'cmdExport', 'cmdQuickstart', 'formatDate', 'quoteIdentifier', 'parsePositiveInt'],
  mocks: {
    './shared/factory': { createAquiferFromConfig() { throw new Error('not used in unit tests'); } },
    './shared/config': { loadConfig() { return {}; } },
  },
  transformSource(source) {
    const marker = '\nmain().catch(';
    const idx = source.lastIndexOf(marker);
    return idx === -1 ? source : source.slice(0, idx);
  },
}).__private;

const mcpPrivate = loadModuleFromSource('consumers/mcp.js', {
  exportNames: ['formatResults'],
}).__private;

const openclawPrivate = loadModuleFromSource('consumers/openclaw-plugin.js', {
  exportNames: ['coerceRawEntries', 'normalizeEntries', 'formatRecallResults', 'formatDate'],
  mocks: {
    './shared/factory': { createAquiferFromConfig() { return {}; } },
  },
}).__private;

describe('consumers/cli.js', () => {
  it('cmdRecall falls back to default limit for invalid numeric input', async () => {
    let received = null;
    const aquifer = {
      async recall(query, opts) {
        received = { query, opts };
        return [];
      },
    };

    const log = captureConsole('log');
    try {
      await cliPrivate.cmdRecall(aquifer, {
        _: ['recall', 'edge-case'],
        flags: { limit: 'NaN' },
      });
    } finally {
      log.restore();
    }

    assert.equal(received.query, 'edge-case');
    assert.equal(received.opts.limit, 5);
  });

  it('cmdBackfill clamps invalid or too-small limits to a sane minimum', async () => {
    let received = null;
    const aquifer = {
      async getPendingSessions(opts) {
        received = opts;
        return [];
      },
    };

    const out = captureConsole('log');
    try {
      await cliPrivate.cmdBackfill(aquifer, { flags: { limit: '0' } });
    } finally {
      out.restore();
    }

    assert.equal(received.limit, 1);
  });

  it('cmdRecall exits when query is missing', async () => {
    const err = captureConsole('error');
    try {
      const code = await captureExit(() => cliPrivate.cmdRecall({}, { _: ['recall'], flags: {} }));
      assert.equal(code, 1);
      assert.match(err.calls[0], /Usage: aquifer recall/);
    } finally {
      err.restore();
    }
  });

  it('cmdRecall falls back for malformed startedAt values from recall results', async () => {
    const aquifer = {
      async recall() {
        return [{
          startedAt: 'not-a-date',
          agentId: 'agent-x',
          score: 0.5,
        }];
      },
    };

    const out = captureConsole('log');
    try {
      await cliPrivate.cmdRecall(aquifer, { _: ['recall', 'q'], flags: {} });
      assert.ok(out.calls.some(line => /\(\?, agent-x\)/.test(line)), 'should print fallback date');
    } finally {
      out.restore();
    }
  });

  it('cmdBackfill calls getPendingSessions and logs dry-run output', async () => {
    const out = captureConsole('log');
    try {
      const aquifer = {
        async getPendingSessions() {
          return [{ session_id: 'sid-1', agent_id: 'a1', processing_status: 'pending' }];
        },
      };
      await cliPrivate.cmdBackfill(aquifer, { flags: { 'dry-run': true } });
      assert.ok(out.calls.some(l => /sid-1/.test(l)), 'should log the session_id');
    } finally {
      out.restore();
    }
  });

  it('cmdStats calls getStats and prints session total', async () => {
    const out = captureConsole('log');
    try {
      const aquifer = {
        async getStats() {
          return { sessions: { pending: 3 }, sessionTotal: 3, summaries: 1, turnEmbeddings: 5, entities: 0, earliest: null, latest: null };
        },
      };
      await cliPrivate.cmdStats(aquifer, { flags: {} });
      assert.ok(out.calls.some(l => /Sessions: 3/.test(l)), 'should print session total');
    } finally {
      out.restore();
    }
  });

  it('cmdExport calls exportSessions and writes JSONL to stdout', async () => {
    const out = captureConsole('log');
    try {
      const aquifer = {
        async exportSessions() {
          return [{ session_id: 'sid-x', agent_id: 'a1', source: 'api', started_at: null, msg_count: 2, processing_status: 'succeeded', summary_text: null, structured_summary: null }];
        },
      };
      // cmdExport writes to process.stdout directly, so we just check it resolves without throwing
      await cliPrivate.cmdExport(aquifer, { flags: {} });
    } finally {
      out.restore();
    }
  });

  it('cmdExport falls back to default limit for invalid numeric input', async () => {
    let received = null;
    const aquifer = {
      async exportSessions(opts) {
        received = opts;
        return [];
      },
    };

    const out = captureConsole('log');
    try {
      await cliPrivate.cmdExport(aquifer, { flags: { limit: 'NaN' } });
    } finally {
      out.restore();
    }

    assert.equal(received.limit, 1000);
  });

  it('cmdQuickstart cleans up via parent session delete and closes the pool', async () => {
    const calls = [];
    let ended = false;

    const aquifer = {
      async migrate() {},
      async commit() {},
      async enrich() { return { turnsEmbedded: 1 }; },
      async recall() { return [{ score: 0.9, matchedTurnText: 'hit' }]; },
    };

    const logs = captureConsole('log');
    try {
      await withPatchedModuleLoad({
        './shared/config': { loadConfig() { return { db: { url: 'postgresql://example/test' }, schema: 'aq_test', tenantId: 'tenant-x' }; } },
        pg: {
          Pool: class FakePool {
            async query(sql, params) {
              calls.push({ sql, params });
              return { rows: [] };
            }
            async end() {
              ended = true;
            }
          },
        },
      }, async () => cliPrivate.cmdQuickstart(aquifer));
    } finally {
      logs.restore();
    }

    assert.equal(calls[0].sql, 'BEGIN');
    assert.match(calls[1].sql, /DELETE FROM "aq_test"\.sessions WHERE tenant_id = \$1 AND agent_id = \$2 AND session_id = \$3/);
    assert.deepEqual(calls[1].params, ['tenant-x', 'quickstart', calls[1].params[2]]);
    assert.equal(calls[2].sql, 'COMMIT');
    assert.equal(ended, true);
  });

  it('cmdQuickstart rolls back and closes the pool when cleanup fails', async () => {
    const calls = [];
    let ended = false;

    const aquifer = {
      async migrate() {},
      async commit() {},
      async enrich() { return { turnsEmbedded: 1 }; },
      async recall() { return [{ score: 0.9 }]; },
    };

    await assert.rejects(
      () => withPatchedModuleLoad({
        './shared/config': { loadConfig() { return { db: { url: 'postgresql://example/test' }, schema: 'aq_test', tenantId: 'tenant-x' }; } },
        pg: {
          Pool: class FakePool {
            async query(sql) {
              calls.push(sql);
              if (sql.startsWith('DELETE FROM')) throw new Error('cleanup failed');
              return { rows: [] };
            }
            async end() {
              ended = true;
            }
          },
        },
      }, async () => cliPrivate.cmdQuickstart(aquifer)),
      /cleanup failed/
    );
    assert.deepEqual(calls, ['BEGIN', 'DELETE FROM "aq_test".sessions WHERE tenant_id = $1 AND agent_id = $2 AND session_id = $3', 'ROLLBACK']);
    assert.equal(ended, true);
  });
});

describe('consumers/mcp.js', () => {
  it('formatResults returns a no-results message for empty arrays', () => {
    assert.equal(
      mcpPrivate.formatResults([], '特殊 unicode'),
      'No results found for "特殊 unicode".'
    );
  });

  it('formatResults falls back to unknown/default placeholders for missing fields', () => {
    const text = mcpPrivate.formatResults([{
      summaryText: '',
      structuredSummary: null,
      matchedTurnText: '',
      score: undefined,
      startedAt: null,
      agentId: '',
    }], 'q');

    assert.match(text, /unknown, default/);
    assert.match(text, /Score: \?/);
    assert.match(text, /\(untitled\)/);
  });

  it('formatResults falls back on malformed startedAt values', () => {
    const text = mcpPrivate.formatResults([{ startedAt: 'bad-date', score: 1 }], 'q');
    assert.match(text, /unknown, default/);
  });

  it('main exits with an install hint when optional MCP dependencies are missing', async () => {
    let stderr = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderr += chunk;
      return true;
    };

    try {
      await withPatchedModuleLoad(
        { '@modelcontextprotocol/sdk/server/mcp.js': new Error('missing sdk') },
        async () => {
          const code = await captureExit(() => mcpMain());
          assert.equal(code, 1);
        }
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.match(stderr, /requires @modelcontextprotocol\/sdk and zod/);
    assert.match(stderr, /Install: npm install @modelcontextprotocol\/sdk zod/);
  });

  it('main rethrows non-missing dependency load errors', async () => {
    await assert.rejects(
      () => withPatchedModuleLoad(
        { '@modelcontextprotocol/sdk/server/mcp.js': Object.assign(new Error('sdk exploded'), { code: 'ERR_REQUIRE_ESM' }) },
        async () => mcpMain()
      ),
      /sdk exploded/
    );
  });

  it('formatDate falls back for malformed values', () => {
    assert.equal(cliPrivate.formatDate('not-a-date', '?'), '?');
  });

  it('quoteIdentifier rejects invalid schema names', () => {
    assert.throws(() => cliPrivate.quoteIdentifier('bad-name;drop'), /Invalid schema name/);
  });

  it('parsePositiveInt returns fallback for invalid values and clamps to minimum 1', () => {
    assert.equal(cliPrivate.parsePositiveInt('NaN', 5), 5);
    assert.equal(cliPrivate.parsePositiveInt(undefined, 5), 5);
    assert.equal(cliPrivate.parsePositiveInt('0', 5), 1);
    assert.equal(cliPrivate.parsePositiveInt('-10', 5), 1);
    assert.equal(cliPrivate.parsePositiveInt('7', 5), 7);
  });
});

describe('consumers/openclaw-plugin.js', () => {
  it('coerceRawEntries ignores invalid shapes and unwraps nested message objects', () => {
    const raw = openclawPrivate.coerceRawEntries([
      null,
      undefined,
      0,
      '',
      { role: 'user', content: 'plain' },
      { message: { role: 'assistant', content: 'nested' } },
      { message: null },
      {},
    ]);

    assert.deepEqual(raw, [
      { role: 'user', content: 'plain' },
      { role: 'assistant', content: 'nested' },
    ]);
  });

  it('normalizeEntries ignores invalid roles and aggregates timestamps/tokens safely', () => {
    const result = openclawPrivate.normalizeEntries([
      {
        role: 'user',
        content: 'hello',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'image', url: 'x' },
            { type: 'text', text: 'line 2' },
          ],
          usage: { input_tokens: 0, output_tokens: 2 },
          model: 'gpt-edge',
        },
        timestamp: '2024-01-02T00:00:00.000Z',
      },
      {
        message: {
          role: 'user',
          content: null,
          usage: { input: 3, output: 0 },
          timestamp: '2024-01-03T00:00:00.000Z',
        },
      },
      {
        message: {
          role: 'tool',
          content: 'skip me',
        },
      },
    ]);

    assert.equal(result.userCount, 2);
    assert.equal(result.assistantCount, 1);
    assert.equal(result.model, 'gpt-edge');
    assert.equal(result.tokensIn, 3);
    assert.equal(result.tokensOut, 2);
    assert.equal(result.startedAt, '2024-01-01T00:00:00.000Z');
    assert.equal(result.lastMessageAt, '2024-01-03T00:00:00.000Z');
    assert.deepEqual(result.messages, [
      { role: 'user', content: 'hello', timestamp: '2024-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'line 1\nline 2', timestamp: '2024-01-02T00:00:00.000Z' },
      { role: 'user', content: '', timestamp: '2024-01-03T00:00:00.000Z' },
    ]);
  });

  it('formatRecallResults returns a no-match message for empty results', () => {
    assert.equal(openclawPrivate.formatRecallResults([]), 'No matching sessions found.');
  });

  it('formatRecallResults falls back on malformed startedAt values', () => {
    const text = openclawPrivate.formatRecallResults([{ startedAt: 'bad-date', agentId: '', score: 0.1 }]);
    assert.match(text, /unknown, default/);
  });

  it('formatDate falls back to unknown for malformed values', () => {
    assert.equal(openclawPrivate.formatDate('bad-date'), 'unknown');
  });

  it('register disables the plugin when configuration is invalid', () => {
    const plugin = loadModuleFromSource('consumers/openclaw-plugin.js', {
      mocks: {
        './shared/factory': {
          createAquiferFromConfig() {
            throw new Error('broken config');
          },
        },
      },
    });

    const warns = [];
    const api = {
      pluginConfig: {},
      logger: {
        warn(msg) { warns.push(msg); },
        info() {},
      },
      on() {
        assert.fail('register should stop before adding event listeners');
      },
      registerTool() {
        assert.fail('register should stop before adding tools');
      },
    };

    plugin.register(api);

    assert.equal(warns.length, 1);
    assert.match(warns[0], /\[aquifer-memory\] disabled: broken config/);
  });
});

describe('consumers/shared/config.js', () => {
  it('ignores empty-string env overrides but preserves zero-like values', () => {
    const config = loadConfig({
      cwd: ROOT,
      env: {
        AQUIFER_SCHEMA: '',
        AQUIFER_TENANT_ID: '',
        AQUIFER_DB_MAX: '0',
        AQUIFER_ENTITIES_ENABLED: '',
      },
    });

    assert.equal(config.schema, 'aquifer');
    assert.equal(config.tenantId, 'default');
    assert.equal(config.db.max, 0);
    assert.equal(config.entities.enabled, false);
  });

  it('supports explicit .cjs config files with empty-string and zero values', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquifer-config-'));
    const configPath = path.join(tmpDir, 'aquifer.config.cjs');
    fs.writeFileSync(
      configPath,
      'module.exports = { schema: "edge_schema", defaults: { source: "" }, embed: { chunkSize: 0 } };'
    );

    try {
      const config = loadConfig({
        configPath,
        env: {},
      });

      assert.equal(config.schema, 'edge_schema');
      assert.equal(config.defaults.source, '');
      assert.equal(config.embed.chunkSize, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on malformed JSON config files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquifer-config-'));
    const configPath = path.join(tmpDir, 'aquifer.config.json');
    fs.writeFileSync(configPath, '{"db": {"url": ');

    try {
      assert.throws(
        () => loadConfig({ configPath, env: {} }),
        /Unexpected end of JSON input/
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('coerces invalid numeric env values to NaN', () => {
    const config = loadConfig({
      cwd: ROOT,
      env: {
        AQUIFER_EMBED_DIM: 'not-a-number',
      },
    });

    assert.equal(Number.isNaN(config.embed.dim), true);
  });
});

describe('consumers/shared/factory.js', () => {
  it('strips trailing /v1 from Ollama embed URLs before creating the embedder', () => {
    let embedderConfig = null;
    let poolOptions = null;

    class FakePool {
      constructor(opts) {
        poolOptions = opts;
      }
    }

    const { createAquiferFromConfig } = loadModuleFromSource('consumers/shared/factory.js', {
      mocks: {
        pg: { Pool: FakePool },
        '../../index': {
          createAquifer(config) {
            return { receivedConfig: config };
          },
          createEmbedder(config) {
            embedderConfig = config;
            return { embedBatch: async () => [] };
          },
        },
        './config': {
          loadConfig() {
            return {
              db: { url: 'postgres://example/db', max: 2, idleTimeoutMs: 1234 },
              schema: 'aquifer',
              tenantId: 'tenant-x',
              embed: {
                baseUrl: 'http://ollama.local:11434/v1/',
                model: 'bge-m3',
                chunkSize: 8,
                timeoutMs: 99,
                maxRetries: 1,
                dim: null,
              },
              llm: {},
              entities: { enabled: false, mergeCall: true },
              rank: {},
            };
          },
        },
        './llm': {
          createLlmFn() {
            throw new Error('llm should not be created');
          },
        },
      },
    });

    const aquifer = createAquiferFromConfig();

    assert.equal(poolOptions.connectionString, 'postgres://example/db');
    assert.equal(embedderConfig.provider, 'ollama');
    assert.equal(embedderConfig.ollamaUrl, 'http://ollama.local:11434');
    assert.equal(aquifer.receivedConfig.tenantId, 'tenant-x');
  });

  it('does not create an llm function when llm.model is missing', () => {
    let llmCalls = 0;
    let createAquiferArg = null;

    class FakePool {
      constructor() {}
    }

    const { createAquiferFromConfig } = loadModuleFromSource('consumers/shared/factory.js', {
      mocks: {
        pg: { Pool: FakePool },
        '../../index': {
          createAquifer(config) {
            createAquiferArg = config;
            return {};
          },
          createEmbedder() {
            return { embedBatch: async () => [] };
          },
        },
        './config': {
          loadConfig() {
            return {
              db: { url: 'postgres://example/db', max: 1, idleTimeoutMs: 1000 },
              schema: 'aquifer',
              tenantId: 'default',
              embed: {},
              llm: {
                baseUrl: 'http://localhost:9999',
                model: '',
              },
              entities: { enabled: false, mergeCall: true },
              rank: {},
            };
          },
        },
        './llm': {
          createLlmFn() {
            llmCalls++;
            return async () => '';
          },
        },
      },
    });

    createAquiferFromConfig();

    assert.equal(llmCalls, 0);
    assert.equal(createAquiferArg.llm, null);
  });
});

describe('consumers/shared/llm.js', () => {
  it('rejects malformed JSON responses', async (t) => {
    const svc = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{nope');
    });
    t.after(() => svc.close());

    const llm = createLlmFn({
      baseUrl: svc.url,
      model: 'test-model',
      timeoutMs: 100,
      maxRetries: 1,
    });

    await assert.rejects(() => llm('prompt'), /Invalid JSON from LLM/);
  });

  it('rejects when choices[0].message.content is missing', async (t) => {
    const svc = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: {} }] }));
    });
    t.after(() => svc.close());

    const llm = createLlmFn({
      baseUrl: svc.url,
      model: 'test-model',
      timeoutMs: 100,
      maxRetries: 1,
    });

    await assert.rejects(
      () => llm('prompt'),
      /LLM response missing choices\[0\]\.message\.content/
    );
  });

  it('sanitizes and truncates non-2xx error bodies', async (t) => {
    const noisyBody = `${'x'.repeat(250)}\nsecret-line`;
    const svc = await startServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(noisyBody);
    });
    t.after(() => svc.close());

    const llm = createLlmFn({
      baseUrl: svc.url,
      model: 'test-model',
      timeoutMs: 100,
      maxRetries: 1,
    });

    await assert.rejects(
      () => llm('prompt'),
      (err) => {
        assert.match(err.message, /^LLM HTTP 500:/);
        assert.equal(err.message.includes('\n'), false);
        assert.equal(err.message.includes('secret-line'), false);
        return true;
      }
    );
  });

  it('does not retry non-retryable HTTP errors', async (t) => {
    let requests = 0;
    const svc = await startServer((req, res) => {
      requests++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    });
    t.after(() => svc.close());

    const llm = createLlmFn({
      baseUrl: svc.url,
      model: 'test-model',
      timeoutMs: 100,
      maxRetries: 3,
      initialBackoffMs: 1,
    });

    await assert.rejects(() => llm('prompt'), /LLM HTTP 400/);
    assert.equal(requests, 1);
  });

  it('rejects with a timeout error when the server hangs', async (t) => {
    const svc = await startServer(() => {});
    t.after(() => svc.close());

    const llm = createLlmFn({
      baseUrl: svc.url,
      model: 'test-model',
      timeoutMs: 30,
      maxRetries: 2,
      initialBackoffMs: 1,
    });

    await assert.rejects(() => llm('prompt'), /LLM request timeout/);
  });
});

describe('core/aquifer.js', () => {
  it('commit rejects missing sessionId', async () => {
    const aquifer = createAquifer({ db: {} });
    await assert.rejects(() => aquifer.commit('', []), /sessionId is required/);
  });

  it('commit rejects non-array messages', async () => {
    const aquifer = createAquifer({ db: {} });
    await assert.rejects(() => aquifer.commit('s1', null), /messages must be an array/);
    await assert.rejects(() => aquifer.commit('s1', {}), /messages must be an array/);
  });

  it('recall returns [] for empty queries before embed validation', async () => {
    const aquifer = createAquifer({ db: {} });
    assert.deepEqual(await aquifer.recall(''), []);
    assert.deepEqual(await aquifer.recall(null), []);
    assert.deepEqual(await aquifer.recall(undefined), []);
  });

  it('recall rejects non-empty queries when embed config is missing', async () => {
    const aquifer = createAquifer({ db: {} });
    await assert.rejects(() => aquifer.recall('query'), /Aquifer\.recall\(\) requires config\.embed\.fn/);
  });

  it('enableEntities does not touch the pool before migrate has run', async () => {
    let queryCalls = 0;
    const aquifer = createAquifer({
      db: {
        async query() {
          queryCalls++;
        },
      },
    });

    await aquifer.enableEntities();
    assert.equal(queryCalls, 0);
  });
});

describe('core/entity.js', () => {
  it('upsertEntity rejects NaN in embeddings before any query runs', async () => {
    let queried = false;
    const pool = {
      async query() {
        queried = true;
        return { rows: [] };
      },
    };

    await assert.rejects(
      () => upsertEntity(pool, {
        schema: 'aquifer',
        name: 'Bad Vec',
        normalizedName: 'bad vec',
        embedding: [1, NaN, 3],
      }),
      /Vector contains non-finite value at index 1/
    );

    assert.equal(queried, false);
  });

  it('upsertEntity rejects Infinity in embeddings before any query runs', async () => {
    const pool = {
      async query() {
        assert.fail('query should not run for invalid vectors');
      },
    };

    await assert.rejects(
      () => upsertEntity(pool, {
        schema: 'aquifer',
        name: 'Bad Vec',
        normalizedName: 'bad vec',
        embedding: [Infinity],
      }),
      /Vector contains non-finite value at index 0/
    );
  });

  it('upsertEntityRelations skips empty, missing, and self-referential pairs', async () => {
    let queryCalls = 0;
    const pool = {
      async query() {
        queryCalls++;
      },
    };

    assert.deepEqual(
      await upsertEntityRelations(pool, {
        schema: 'aquifer',
        pairs: [],
      }),
      { upserted: 0 }
    );

    assert.deepEqual(
      await upsertEntityRelations(pool, {
        schema: 'aquifer',
        pairs: [
          { srcEntityId: 1, dstEntityId: 1 },
          { srcEntityId: null, dstEntityId: 2 },
          { srcEntityId: 3, dstEntityId: undefined },
        ],
      }),
      { upserted: 0 }
    );

    assert.equal(queryCalls, 0);
  });

  it('searchEntities returns [] for blank or punctuation-only queries without querying', async () => {
    let queried = false;
    const pool = {
      async query() {
        queried = true;
        return { rows: [] };
      },
    };

    assert.deepEqual(await searchEntities(pool, {
      schema: 'aquifer',
      tenantId: 'default',
      query: '',
    }), []);

    assert.deepEqual(await searchEntities(pool, {
      schema: 'aquifer',
      tenantId: 'default',
      query: '   ',
    }), []);

    assert.deepEqual(await searchEntities(pool, {
      schema: 'aquifer',
      tenantId: 'default',
      query: '---',
    }), []);

    assert.equal(queried, false);
  });

  it('getEntityRelations clamps negative limits to 1', async () => {
    let params = null;
    const pool = {
      async query(sql, p) {
        params = p;
        return { rows: [] };
      },
    };

    const rows = await getEntityRelations(pool, {
      schema: 'aquifer',
      entityId: 42,
      limit: -10,
    });

    assert.deepEqual(rows, []);
    assert.equal(params[1], 1);
  });
});

describe('core/hybrid-rank.js', () => {
  it('rrfFusion supports numeric zero ids via string fallback', () => {
    const scores = rrfFusion([{ id: 0 }], [], []);
    assert.equal(scores.has('0'), true);
  });

  it('timeDecay returns a high finite score for future timestamps', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const score = timeDecay(future);
    assert.equal(Number.isFinite(score), true);
    assert.ok(score > 0.9 && score <= 1);
  });

  it('accessScore returns 0 for invalid lastAccessedAt values', () => {
    assert.equal(accessScore(5, 'not-a-date'), 0);
  });

  it('hybridRank can rank turn-only results using id fallback', () => {
    const result = hybridRank(
      [],
      [],
      [{
        id: 7,
        matched_turn_text: 'edge case turn',
        matched_turn_index: 2,
        started_at: new Date().toISOString(),
      }]
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].session_id, '7');
    assert.equal(result[0].matched_turn_text, 'edge case turn');
    assert.equal(result[0].matched_turn_index, 2);
  });

  it('hybridRank clamps oversized scores to 1', () => {
    const [row] = hybridRank(
      [{ session_id: 's1', started_at: new Date().toISOString() }],
      [],
      [],
      {
        limit: 1,
        weights: { rrf: 10, timeDecay: 10, access: 10, entityBoost: 10 },
        entityScoreBySession: new Map([['s1', 1]]),
      }
    );

    assert.equal(row._score, 1);
  });

  it('hybridRank returns [] when limit is zero', () => {
    const rows = hybridRank(
      [{ session_id: 's1', started_at: new Date().toISOString() }],
      [],
      [],
      { limit: 0 }
    );

    assert.deepEqual(rows, []);
  });

  it('hybridRank trust multiplier is neutral at 0.5', () => {
    const now = new Date().toISOString();
    const fts = [{ session_id: 's1', started_at: now, trust_score: 0.5 }];
    const [r] = hybridRank(fts, [], []);
    assert.equal(r._trustMultiplier, 1.0);
  });

  it('hybridRank trust=0 halves the base score', () => {
    const now = new Date().toISOString();
    const ftsNeutral = [{ session_id: 's1', started_at: now, trust_score: 0.5 }];
    const ftsZero = [{ session_id: 's1', started_at: now, trust_score: 0.0 }];
    const [neutral] = hybridRank(ftsNeutral, [], []);
    const [zero] = hybridRank(ftsZero, [], []);
    assert.equal(zero._trustMultiplier, 0.5);
    assert.ok(zero._score < neutral._score);
  });

  it('hybridRank trust=1 gives 1.5x multiplier', () => {
    const now = new Date().toISOString();
    const fts = [{ session_id: 's1', started_at: now, trust_score: 1.0 }];
    const [r] = hybridRank(fts, [], []);
    assert.equal(r._trustMultiplier, 1.5);
  });

  it('hybridRank open-loop boost from Set works correctly', () => {
    const now = new Date().toISOString();
    const fts = [
      { session_id: 'a', started_at: now },
      { session_id: 'b', started_at: now },
    ];
    const olSet = new Set(['a']);
    const result = hybridRank(fts, [], [], { openLoopSet: olSet });
    const a = result.find(r => r.session_id === 'a');
    const b = result.find(r => r.session_id === 'b');
    assert.ok(a._openLoopBoost > 0);
    assert.equal(b._openLoopBoost, 0);
    assert.ok(a._score > b._score);
  });

  it('hybridRank missing trust_score defaults to 0.5', () => {
    const fts = [{ session_id: 's1', started_at: new Date().toISOString() }];
    const [r] = hybridRank(fts, [], []);
    assert.equal(r._trustScore, 0.5);
    assert.equal(r._trustMultiplier, 1.0);
  });

  it('hybridRank entity boost still works with new API', () => {
    const now = new Date().toISOString();
    const fts = [
      { session_id: 'boosted', started_at: now },
      { session_id: 'plain', started_at: now },
    ];
    const entityMap = new Map([['boosted', 1.0]]);
    const result = hybridRank(fts, [], [], { entityScoreBySession: entityMap });
    assert.equal(result[0].session_id, 'boosted');
    assert.ok(result[0]._entityScore > result[1]._entityScore);
  });
});

describe('core/entity.js — resolveEntities', () => {
  it('returns empty for null/empty names', async () => {
    const mockPool = { async query() { return { rows: [] }; } };
    assert.deepEqual(await resolveEntities(mockPool, { schema: 'aq', tenantId: 'x', names: [] }), []);
    assert.deepEqual(await resolveEntities(mockPool, { schema: 'aq', tenantId: 'x', names: null }), []);
  });

  it('deduplicates normalized names', async () => {
    let queryCount = 0;
    const mockPool = {
      async query() { queryCount++; return { rows: [{ id: 1, name: 'Pg', normalized_name: 'pg' }] }; },
    };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: ['PostgreSQL', 'postgresql', ' POSTGRESQL '],
    });
    assert.equal(result.length, 1);
    assert.equal(queryCount, 1);
  });

  it('skips unresolvable names', async () => {
    const mockPool = {
      async query(sql, params) {
        if (params[1] === 'known') return { rows: [{ id: 1, name: 'Known', normalized_name: 'known' }] };
        return { rows: [] };
      },
    };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: ['known', 'unknown'],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].inputName, 'known');
  });

  it('deduplicates by entityId across different input names', async () => {
    const mockPool = {
      async query() { return { rows: [{ id: 42, name: 'Pg', normalized_name: 'pg' }] }; },
    };
    const result = await resolveEntities(mockPool, {
      schema: 'aq', tenantId: 'x', names: ['postgres', 'pg'],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].entityId, 42);
  });
});

describe('core/entity.js — getSessionsByEntityIntersection', () => {
  it('returns empty for empty entityIds', async () => {
    const mockPool = { async query() { assert.fail('should not query'); } };
    const result = await getSessionsByEntityIntersection(mockPool, {
      schema: 'aq', entityIds: [], tenantId: 'x',
    });
    assert.deepEqual(result, []);
  });

  it('returns empty for null entityIds', async () => {
    const mockPool = { async query() { assert.fail('should not query'); } };
    const result = await getSessionsByEntityIntersection(mockPool, {
      schema: 'aq', entityIds: null, tenantId: 'x',
    });
    assert.deepEqual(result, []);
  });

  it('clamps limit to [1, 500]', async () => {
    let capturedLimit;
    const mockPool = {
      async query(sql, params) { capturedLimit = params[params.length - 1]; return { rows: [] }; },
    };
    await getSessionsByEntityIntersection(mockPool, { schema: 'aq', entityIds: [1], tenantId: 'x', limit: 9999 });
    assert.equal(capturedLimit, 500);
    await getSessionsByEntityIntersection(mockPool, { schema: 'aq', entityIds: [1], tenantId: 'x', limit: -5 });
    assert.equal(capturedLimit, 1);
  });
});

describe('core/storage.js — recordFeedback', () => {
  it('rejects invalid verdict', async () => {
    const mockPool = {};
    await assert.rejects(
      () => storage.recordFeedback(mockPool, {
        schema: 'aq', tenantId: 'x', sessionRowId: 1, sessionId: 's1', agentId: 'a', verdict: 'bad',
      }),
      /Invalid verdict/
    );
  });

  it('rejects empty string verdict', async () => {
    const mockPool = {};
    await assert.rejects(
      () => storage.recordFeedback(mockPool, {
        schema: 'aq', tenantId: 'x', sessionRowId: 1, sessionId: 's1', agentId: 'a', verdict: '',
      }),
      /Invalid verdict/
    );
  });
});

describe('core/aquifer.js — feedback', () => {
  it('requires verdict', async () => {
    const aq = createAquifer({ db: 'postgres://fake', entities: { enabled: true } });
    await assert.rejects(
      () => aq.feedback('sess1', {}),
      /verdict is required/
    );
    await aq.close();
  });

  it('rejects entities opt when entities not enabled', async () => {
    const aq = createAquifer({
      db: 'postgres://fake',
      embed: { fn: async () => [[0.1]], dim: 1 },
    });
    await assert.rejects(
      () => aq.recall('test', { entities: ['foo'], entityMode: 'all' }),
      /Entities are not enabled/
    );
    await aq.close();
  });
});

describe('core/storage.js', () => {
  it('markStatus rejects invalid processing states before querying', async () => {
    const pool = {
      async query() {
        assert.fail('query should not run for invalid status');
      },
    };

    await assert.rejects(
      () => markStatus(pool, 1, 'not-a-real-status', null, { schema: 'aquifer' }),
      /Invalid status: not-a-real-status/
    );
  });

  it('extractUserTurns returns [] for nullish input', () => {
    assert.deepEqual(extractUserTurns(null), []);
    assert.deepEqual(extractUserTurns(undefined), []);
  });

  it('extractUserTurns filters noise, handles array/text fallback, and truncates long unicode safely', () => {
    const longUnicode = '🙂'.repeat(2100);

    const turns = extractUserTurns([
      { role: 'user', content: 'ok' },
      { role: 'user', content: '/new session' },
      { role: 'assistant', content: 'ignore assistant' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'image', text: 'skip' },
          { type: 'text', text: 'Line 2' },
        ],
      },
      { role: 'user', text: '  useful fallback text  ' },
      { role: 'user', content: longUnicode },
    ]);

    assert.equal(turns.length, 3);
    assert.equal(turns[0].text, 'Line 1\nLine 2');
    assert.equal(turns[1].text, 'useful fallback text');
    assert.equal(Array.from(turns[2].text).length, 2000);
  });

  it('upsertTurnEmbeddings rejects mismatched turns/vectors lengths', async () => {
    await assert.rejects(
      () => upsertTurnEmbeddings({}, 1, {
        schema: 'aquifer',
        tenantId: 'default',
        sessionId: 's1',
        agentId: 'agent',
        turns: [{ turnIndex: 1, messageIndex: 0, text: 'hello world' }],
        vectors: [],
      }),
      /turns\.length \(1\) !== vectors\.length \(0\)/
    );
  });

  it('upsertTurnEmbeddings rejects non-finite vectors before querying', async () => {
    let queryCalls = 0;
    const pool = {
      async query() {
        queryCalls++;
      },
    };

    await assert.rejects(
      () => upsertTurnEmbeddings(pool, 1, {
        schema: 'aquifer',
        tenantId: 'default',
        sessionId: 's1',
        agentId: 'agent',
        turns: [{ turnIndex: 1, messageIndex: 0, text: 'hello world' }],
        vectors: [[1, Infinity]],
      }),
      /Vector contains non-finite value at index 1/
    );

    assert.equal(queryCalls, 0);
  });

  it('getMessages rejects malformed JSON session payloads', async () => {
    const pool = {
      async query() {
        return {
          rows: [{
            id: 1,
            messages: '{invalid json',
          }],
        };
      },
    };

    await assert.rejects(
      () => getMessages(pool, 's1', 'agent', { schema: 'aquifer', tenantId: 'default' }),
      /JSON|Unexpected|position/i
    );
  });
});

describe('index.js', () => {
  it('exports function entry points', () => {
    assert.equal(typeof indexExports.createAquifer, 'function');
    assert.equal(typeof indexExports.createEmbedder, 'function');
  });
});

describe('pipeline/embed.js', () => {
  it('rejects unknown embedding providers', () => {
    assert.throws(
      () => createEmbedder({ provider: 'mystery' }),
      /Unknown embedding provider: mystery/
    );
  });

  it('rejects custom providers without fn', () => {
    assert.throws(
      () => createEmbedder({ provider: 'custom' }),
      /fn is required for custom embedder/
    );
  });

  it('custom embedder returns [] for empty batches and keeps dim null', async () => {
    const embedder = createEmbedder({
      provider: 'custom',
      async fn() {
        assert.fail('fn should not run for empty batches');
      },
    });

    assert.deepEqual(await embedder.embedBatch([]), []);
    assert.equal(embedder.dim, null);
  });

  it('custom embedder keeps dim null when returned vectors are empty', async () => {
    const embedder = createEmbedder({
      provider: 'custom',
      async fn(texts) {
        return texts.map(() => []);
      },
    });

    assert.deepEqual(await embedder.embed('特殊 unicode'), []);
    assert.equal(embedder.dim, null);
  });

  it('custom embedder infers dim after the first non-empty vector', async () => {
    const embedder = createEmbedder({
      provider: 'custom',
      async fn(texts) {
        return texts.map(() => [1, 2, 3]);
      },
    });

    assert.deepEqual(await embedder.embedBatch(['a'.repeat(5000)]), [[1, 2, 3]]);
    assert.equal(embedder.dim, 3);
  });
});

describe('pipeline/extract-entities.js', () => {
  it('defaultEntityPrompt stringifies non-string content and preserves unicode', () => {
    const prompt = defaultEntityPrompt([
      { role: 'user', content: [{ type: 'text', text: '🙂' }, { type: 'image', url: 'x' }] },
      { role: 'assistant', content: { nested: true } },
    ]);

    assert.match(prompt, /\[user\] \[\{"type":"text","text":"🙂"/);
    assert.match(prompt, /\[assistant\] \{"nested":true\}/);
  });

  it('extractEntities returns [] when llmFn is missing', async () => {
    assert.deepEqual(await extractEntities([{ role: 'user', content: 'hello' }], {}), []);
  });

  it('extractEntities returns [] when llmFn throws', async () => {
    const result = await extractEntities(
      [{ role: 'user', content: 'hello' }],
      { llmFn: async () => { throw new Error('network'); } }
    );

    assert.deepEqual(result, []);
  });

  it('extractEntities returns [] for malformed model output', async () => {
    const result = await extractEntities(
      [{ role: 'user', content: 'hello' }],
      { llmFn: async () => 'not in entity format at all' }
    );

    assert.deepEqual(result, []);
  });
});

describe('pipeline/summarize.js', () => {
  it('extractiveFallback handles empty input', () => {
    assert.deepEqual(extractiveFallback([]), {
      summaryText: '',
      structuredSummary: null,
      entityRaw: null,
      isExtractive: true,
    });
  });

  it('extractiveFallback dedupes overlapping head/tail selections', () => {
    const messages = [
      { role: 'user', content: 'alpha' },
      { role: 'user', content: 'beta' },
      { role: 'user', content: 'gamma' },
      { role: 'user', content: 'delta' },
      { role: 'user', content: 'epsilon' },
      { role: 'user', content: 'alpha' },
      { role: 'user', content: 'zeta' },
      { role: 'user', content: 'beta' },
    ];

    const result = extractiveFallback(messages);

    assert.equal(result.summaryText, 'alpha\n---\nbeta\n---\ngamma\n---\nzeta');
    assert.equal(result.isExtractive, true);
  });

  it('extractiveFallback truncates oversized summaries', () => {
    const huge = '界'.repeat(3000);
    const result = extractiveFallback([{ role: 'user', content: huge }]);
    assert.ok(result.summaryText.length <= 2000);
  });

  it('summarize falls back to extractive mode when llmFn fails', async () => {
    const result = await summarize(
      [{ role: 'user', content: 'fallback please' }],
      { llmFn: async () => { throw new Error('timeout'); } }
    );

    assert.equal(result.isExtractive, true);
    assert.equal(result.summaryText, 'fallback please');
    assert.equal(result.structuredSummary, null);
  });

  it('summarize strips merged [ENTITIES] blocks from stored summary text', async () => {
    const response = [
      'TITLE: Edge failure summary',
      'OVERVIEW: Something happened.',
      'TOPICS:',
      '- Parsing: handled odd input',
      '[ENTITIES]',
      'name: PostgreSQL',
      'type: tool',
      'aliases: Postgres, PG',
      '---',
    ].join('\n');

    const result = await summarize(
      [{ role: 'user', content: 'hello' }],
      { llmFn: async () => response, mergeEntities: true }
    );

    assert.equal(result.isExtractive, false);
    assert.equal(result.summaryText.includes('[ENTITIES]'), false);
    assert.equal(result.entityRaw.startsWith('[ENTITIES]'), true);
    assert.equal(result.structuredSummary.title, 'Edge failure summary');
  });
});
