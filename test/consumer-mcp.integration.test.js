'use strict';

/**
 * MCP Consumer Integration Tests — spawn `consumers/mcp.js` as a subprocess
 * via the official MCP StdioClientTransport and call each exposed tool against
 * real PostgreSQL. Mirrors how Claude Code / OpenCode actually connect.
 *
 * 環境：
 *   AQUIFER_TEST_DB_URL="postgresql://burk:PASS@localhost:5432/openclaw_db" \
 *     node --test test/consumer-mcp.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const { createAquifer } = require('../index');
const { requireTestDb, registerSkip } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('MCP consumer integration tests');

// Lazy require — SDK is optional at module scope, only needed for these tests
let Client, StdioClientTransport;
if (DB_URL) {
  try {
    ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
    ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));
  } catch (err) {
    registerSkip(`MCP consumer integration tests require @modelcontextprotocol/sdk (${err.message})`);
  }
}

const CLI_PATH = path.join(__dirname, '..', 'consumers', 'cli.js');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

function buildIsolatedMcpEnv(schema, extraEnv = {}) {
  const baseEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AQUIFER_MEMORY_')) continue;
    baseEnv[key] = value;
  }
  return {
    ...baseEnv,
    AQUIFER_DB_URL: DB_URL,
    AQUIFER_SCHEMA: schema,
    AQUIFER_TENANT_ID: 'test',
    AQUIFER_CONFIG: '/dev/null',
    ...extraEnv,
  };
}

async function connectMcpClient(schema, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH, 'mcp'],
    env: buildIsolatedMcpEnv(schema, extraEnv),
  });
  const client = new Client({ name: 'aquifer-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

function getToolText(result) {
  const block = (result.content || []).find(c => c.type === 'text');
  return block ? block.text : '';
}

function resolveToolName(tools, name, label = name) {
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes(name), `missing ${label} tool`);
  return name;
}

if (DB_URL && Client && StdioClientTransport) {
describe('MCP consumer — aquifer mcp tool surface', () => {
  let schema, pool, aq, client, transport, curatedMemoryId;

  before(async () => {
    schema = randomSchema();
    pool = new Pool({ connectionString: DB_URL });

    aq = createAquifer({
      db: DB_URL,
      schema,
      tenantId: 'test',
      embed: { fn: async (texts) => texts.map(() => { const v = new Array(1024).fill(0); v[0] = 1; return v; }), dim: 1024 },
    });
    await aq.migrate();
    await aq.commit('mcp-seed-001', [
      { role: 'user', content: 'keyword MCP seed user message one' },
      { role: 'assistant', content: 'seed assistant reply' },
      { role: 'user', content: 'keyword MCP seed user message two' },
    ], { agentId: 'mcp-test', source: 'mcp-test' });
    await aq.enrich('mcp-seed-001', {
      agentId: 'mcp-test',
      summaryFn: async () => ({
        summaryText: 'keyword MCP summary content',
        structuredSummary: {
          title: 'MCP Seed',
          overview: 'keyword MCP seed overview text',
          topics: [], decisions: [], open_loops: [],
        },
      }),
    });
    const scope = await aq.memory.upsertScope({
      tenantId: 'test',
      scopeKind: 'project',
      scopeKey: 'project:mcp-tool-surface',
      inheritanceMode: 'defaultable',
    });
    const memory = await aq.memory.upsertMemory({
      tenantId: 'test',
      scopeId: scope.id,
      memoryType: 'decision',
      canonicalKey: 'decision:project:mcp-tool-surface:feedback-split',
      title: 'Split legacy session feedback from curated memory feedback',
      summary: 'Curated memory feedback should use its own public target.',
      status: 'active',
      authority: 'verified_summary',
      visibleInRecall: true,
      visibleInBootstrap: true,
      acceptedAt: '2026-04-29T00:00:00Z',
    });
    curatedMemoryId = String(memory.id);

    ({ client, transport } = await connectMcpClient(schema));
  });

  after(async () => {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
    try { await aq.close(); } catch {}
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end().catch(() => {}); }
  });

  it('listTools exposes explicit current, historical, compatibility, and evidence recall tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name).sort();
    assert.equal(names.length, 10);
    for (const required of ['memory_recall', 'historical_recall', 'session_recall', 'evidence_recall']) {
      assert.ok(names.includes(required), `missing tool ${required}`);
    }
    for (const required of ['feedback_stats', 'memory_feedback', 'memory_pending', 'memory_stats', 'session_bootstrap', 'session_feedback']) {
      assert.ok(names.includes(required), `missing tool ${required}`);
    }
  });

  it('ignores ambient AQUIFER_MEMORY_* variables unless explicitly passed to the MCP subprocess', async () => {
    const previous = {
      mode: process.env.AQUIFER_MEMORY_SERVING_MODE,
      key: process.env.AQUIFER_MEMORY_ACTIVE_SCOPE_KEY,
      path: process.env.AQUIFER_MEMORY_ACTIVE_SCOPE_PATH,
    };
    process.env.AQUIFER_MEMORY_SERVING_MODE = 'curated';
    process.env.AQUIFER_MEMORY_ACTIVE_SCOPE_KEY = 'project:ambient-poison';
    process.env.AQUIFER_MEMORY_ACTIVE_SCOPE_PATH = 'global,project:ambient-poison';

    const isolated = await connectMcpClient(schema);
    try {
      const result = await isolated.client.callTool({ name: 'memory_stats', arguments: {} });
      const text = getToolText(result);
      assert.match(text, /Serving mode:\s*legacy/);
      assert.match(text, /Warning: legacy serving returns session\/evidence material/);
      assert.doesNotMatch(text, /project:ambient-poison/);
    } finally {
      try { await isolated.client.close(); } catch {}
      try { await isolated.transport.close(); } catch {}
      if (previous.mode === undefined) delete process.env.AQUIFER_MEMORY_SERVING_MODE;
      else process.env.AQUIFER_MEMORY_SERVING_MODE = previous.mode;
      if (previous.key === undefined) delete process.env.AQUIFER_MEMORY_ACTIVE_SCOPE_KEY;
      else process.env.AQUIFER_MEMORY_ACTIVE_SCOPE_KEY = previous.key;
      if (previous.path === undefined) delete process.env.AQUIFER_MEMORY_ACTIVE_SCOPE_PATH;
      else process.env.AQUIFER_MEMORY_ACTIVE_SCOPE_PATH = previous.path;
    }
  });

  it('memory_stats returns storage counts', async () => {
    const result = await client.callTool({ name: 'memory_stats', arguments: {} });
    const text = getToolText(result);
    assert.match(text, /Sessions:\s*1\b/);
    assert.match(text, /Summaries:\s*1/);
    assert.match(text, /Turn embeddings:\s*\d/);
    assert.match(text, /Serving mode:\s*legacy/);
    assert.match(text, /Memory records:\s*1 total/);
    assert.match(text, /Warning: legacy serving returns session\/evidence material/);
  });

  it('session_recall compatibility surface finds seeded session by keyword in legacy mode', async () => {
    const result = await client.callTool({
      name: resolveToolName((await client.listTools()).tools, 'session_recall'),
      arguments: { query: 'MCP seed', mode: 'fts', limit: 3 },
    });
    const text = getToolText(result);
    assert.match(text, /mcp-seed-001|MCP Seed/,
      `recall should surface seeded session; got: ${text.slice(0, 200)}`);
    assert.match(text, /Serving lane: legacy evidence\/session recall/);
    assert.doesNotMatch(text, /Serving lane: explicit legacy\/evidence recall|Serving lane: curated current memory/);
  });

  it('serves curated memory through memory_recall while historical_recall stays on the historical plane', async () => {
    const curated = await connectMcpClient(schema, {
      AQUIFER_MEMORY_SERVING_MODE: 'curated',
      AQUIFER_MEMORY_ACTIVE_SCOPE_KEY: 'project:mcp-tool-surface',
      AQUIFER_MEMORY_ACTIVE_SCOPE_PATH: 'global,project:mcp-tool-surface',
    });
    try {
      const recall = await curated.client.callTool({
        name: resolveToolName((await curated.client.listTools()).tools, 'memory_recall'),
        arguments: { query: 'curated memory feedback target', limit: 3 },
      });
      const recallText = getToolText(recall);
      assert.match(recallText, /Serving lane: explicit current memory recall/);
      assert.match(recallText, /Split legacy session feedback from curated memory feedback/);
      assert.doesNotMatch(recallText, /mcp-seed-001/);
      assert.doesNotMatch(recallText, /Serving lane: explicit historical\/session recall|Serving lane: explicit legacy\/evidence recall/);

      const bootstrap = await curated.client.callTool({
        name: 'session_bootstrap',
        arguments: { limit: 5 },
      });
      const bootstrapText = getToolText(bootstrap);
      assert.match(bootstrapText, /memory-bootstrap/);
      assert.match(bootstrapText, /Curated memory feedback should use its own public target/);
      assert.doesNotMatch(bootstrapText, /MCP Seed|mcp-seed-001/);

      const evidence = await curated.client.callTool({
        name: resolveToolName((await curated.client.listTools()).tools, 'historical_recall'),
        arguments: { query: 'MCP seed', mode: 'fts', agentId: 'mcp-test', limit: 3 },
      });
      const historicalText = getToolText(evidence);
      assert.match(historicalText, /Serving lane: explicit historical\/session recall/);
      assert.match(historicalText, /mcp-seed-001|MCP Seed/);
      assert.doesNotMatch(historicalText, /Serving lane: curated current memory/);

      const audit = await curated.client.callTool({
        name: resolveToolName((await curated.client.listTools()).tools, 'evidence_recall'),
        arguments: { query: 'MCP seed', mode: 'fts', agentId: 'mcp-test', limit: 3 },
      });
      const auditText = getToolText(audit);
      assert.match(auditText, /Serving lane: explicit legacy\/evidence recall/);
      assert.match(auditText, /mcp-seed-001|MCP Seed/);
      assert.doesNotMatch(auditText, /Serving lane: curated current memory/);

      const stats = await curated.client.callTool({ name: 'memory_stats', arguments: {} });
      const statsText = getToolText(stats);
      assert.match(statsText, /Serving mode:\s*curated/);
      assert.match(statsText, /Active scope:\s*global > project:mcp-tool-surface/);
      assert.match(statsText, /Memory record range:\s*2026-04-29/);
      assert.doesNotMatch(statsText, /Warning: legacy serving/);
    } finally {
      try { await curated.client.close(); } catch {}
      try { await curated.transport.close(); } catch {}
    }
  });

  it('does not let linked historical wording make memory_recall hit current memory', async () => {
    await aq.commit('mcp-historical-linked-sentinel', [
      { role: 'user', content: 'The MCP historical plane contains sentinel delta phrase for linked-source separation.' },
      { role: 'assistant', content: 'Keep sentinel delta phrase out of current memory recall unless the row says it.' },
    ], { agentId: 'mcp-test', source: 'mcp-test' });
    await aq.enrich('mcp-historical-linked-sentinel', {
      agentId: 'mcp-test',
      summaryFn: async () => ({
        summaryText: 'MCP historical summary contains sentinel delta phrase as raw source wording.',
        structuredSummary: {
          title: 'MCP linked sentinel source',
          overview: 'MCP historical summary contains sentinel delta phrase as raw source wording.',
          topics: [], decisions: [], open_loops: [],
        },
      }),
    });
    const scope = await aq.memory.upsertScope({
      tenantId: 'test',
      scopeKind: 'project',
      scopeKey: 'project:mcp-tool-surface',
      inheritanceMode: 'defaultable',
    });
    const memory = await aq.memory.upsertMemory({
      tenantId: 'test',
      scopeId: scope.id,
      memoryType: 'decision',
      canonicalKey: 'decision:project:mcp-tool-surface:linked-source-boundary',
      title: 'Linked source boundary',
      summary: 'Current memory rows do not inherit raw linked-source wording.',
      status: 'active',
      authority: 'verified_summary',
      visibleInRecall: true,
      visibleInBootstrap: true,
      acceptedAt: '2026-04-29T01:00:00Z',
    });
    await aq.memory.linkEvidence({
      tenantId: 'test',
      ownerKind: 'memory_record',
      ownerId: memory.id,
      sourceKind: 'session_summary',
      sourceRef: 'mcp-historical-linked-sentinel',
      relationKind: 'primary',
    });

    const curated = await connectMcpClient(schema, {
      AQUIFER_MEMORY_SERVING_MODE: 'curated',
      AQUIFER_MEMORY_ACTIVE_SCOPE_KEY: 'project:mcp-tool-surface',
      AQUIFER_MEMORY_ACTIVE_SCOPE_PATH: 'global,project:mcp-tool-surface',
    });
    try {
      const current = await curated.client.callTool({
        name: resolveToolName((await curated.client.listTools()).tools, 'memory_recall'),
        arguments: { query: 'sentinel delta phrase', mode: 'fts', limit: 5 },
      });
      const currentText = getToolText(current);
      assert.match(currentText, /Serving lane: explicit current memory recall/);
      assert.doesNotMatch(currentText, /Linked source boundary|linked-source-boundary/);

      const historical = await curated.client.callTool({
        name: resolveToolName((await curated.client.listTools()).tools, 'historical_recall'),
        arguments: { query: 'sentinel delta phrase', mode: 'fts', agentId: 'mcp-test', limit: 5 },
      });
      const historicalText = getToolText(historical);
      assert.match(historicalText, /Serving lane: explicit historical\/session recall/);
      assert.match(historicalText, /mcp-historical-linked-sentinel|MCP linked sentinel source/);
    } finally {
      try { await curated.client.close(); } catch {}
      try { await curated.transport.close(); } catch {}
    }
  });

  it('session_bootstrap returns seeded session context', async () => {
    const result = await client.callTool({
      name: 'session_bootstrap',
      arguments: { agentId: 'mcp-test', limit: 5, lookbackDays: 30 },
    });
    const text = getToolText(result);
    assert.ok(text.length > 0, 'bootstrap returns non-empty text');
    assert.match(text, /MCP Seed|mcp-seed-001|overview/i,
      `bootstrap should include seeded context; got: ${text.slice(0, 200)}`);
  });

  it('historical_recall stays on the explicit historical lane even when the subprocess is legacy by default', async () => {
    const result = await client.callTool({
      name: resolveToolName((await client.listTools()).tools, 'historical_recall'),
      arguments: { query: 'MCP seed', mode: 'fts', agentId: 'mcp-test', limit: 3 },
    });
    const text = getToolText(result);
    assert.match(text, /Serving lane: explicit historical\/session recall/);
    assert.match(text, /mcp-seed-001|MCP Seed/);
    assert.doesNotMatch(text, /Serving lane: curated current memory/);
  });

  it('session_feedback updates trust score', async () => {
    const result = await client.callTool({
      name: 'session_feedback',
      arguments: { sessionId: 'mcp-seed-001', verdict: 'helpful', agentId: 'mcp-test' },
    });
    const text = getToolText(result);
    assert.match(text, /Feedback:\s*helpful/);
    assert.match(text, /trust.*→/);
  });

  it('feedback_stats returns feedback totals', async () => {
    const result = await client.callTool({
      name: 'feedback_stats',
      arguments: { agentId: 'mcp-test' },
    });
    const text = getToolText(result);
    assert.match(text, /Feedback:\s*1 total/);
    assert.match(text, /1 helpful/);
  });

  it('memory_feedback records curated feedback on a memory row', async () => {
    const result = await client.callTool({
      name: 'memory_feedback',
      arguments: { memoryId: curatedMemoryId, feedbackType: 'confirm', agentId: 'mcp-test' },
    });
    const text = getToolText(result);
    assert.match(text, /Memory feedback:\s*confirm/);
  });

  it('keeps placeholder sessions out of public historical/evidence recall while current memory stays clean', async () => {
    const seedHistoricalSummary = async ({ sessionId, title, summaryText, transcriptText, startedAt }) => {
      await aq.commit(sessionId, [
        { role: 'user', content: transcriptText },
        { role: 'assistant', content: summaryText },
      ], { agentId: 'main', source: 'mcp-test', startedAt });
      await aq.enrich(sessionId, {
        agentId: 'main',
        summaryFn: async () => ({
          summaryText,
          structuredSummary: {
            title,
            overview: summaryText,
            topics: [],
            decisions: [],
            open_loops: [],
          },
        }),
      });
    };

    await seedHistoricalSummary({
      sessionId: 'mcp-historical-real',
      title: 'Historical layer note',
      summaryText: 'Aquifer current memory layer stays curated and session summary process material belongs to historical hybrid recall.',
      transcriptText: 'Historical recall should explain current memory layer and session summary process material without polluting current truth.',
      startedAt: '2026-04-30T02:00:00.000Z',
    });
    await seedHistoricalSummary({
      sessionId: 'meta-current',
      title: '空測試會話',
      summaryText: '空測試會話 current memory layer session summary process material placeholder.',
      transcriptText: '空測試會話 current memory layer session summary process material placeholder.',
      startedAt: '2026-04-30T02:01:00.000Z',
    });
    await seedHistoricalSummary({
      sessionId: 'meta-eligible-a',
      title: '測試會話無實質內容',
      summaryText: '測試會話無實質內容 current memory layer session summary process material.',
      transcriptText: '測試會話無實質內容 current memory layer session summary process material.',
      startedAt: '2026-04-30T02:02:00.000Z',
    });
    await seedHistoricalSummary({
      sessionId: 'meta-eligible-b',
      title: 'placeholder filler',
      summaryText: 'placeholder x 字元填充 current memory layer session summary process material.',
      transcriptText: 'placeholder x 字元填充 current memory layer session summary process material.',
      startedAt: '2026-04-30T02:03:00.000Z',
    });
    const scope = await aq.memory.upsertScope({
      tenantId: 'test',
      scopeKind: 'project',
      scopeKey: 'project:mcp-tool-surface',
      inheritanceMode: 'defaultable',
    });
    await aq.memory.upsertMemory({
      tenantId: 'test',
      scopeId: scope.id,
      memoryType: 'decision',
      canonicalKey: 'decision:project:mcp-tool-surface:current-memory-layer',
      title: 'Current memory layer query contract',
      summary: 'Current memory layer stays on curated rows and does not treat session summary process material as current truth.',
      status: 'active',
      authority: 'verified_summary',
      visibleInRecall: true,
      visibleInBootstrap: true,
      acceptedAt: '2026-04-30T02:04:00.000Z',
    });

    const curated = await connectMcpClient(schema, {
      AQUIFER_MEMORY_SERVING_MODE: 'curated',
      AQUIFER_MEMORY_ACTIVE_SCOPE_KEY: 'project:mcp-tool-surface',
      AQUIFER_MEMORY_ACTIVE_SCOPE_PATH: 'global,project:mcp-tool-surface',
    });
    try {
      const memoryRecall = await curated.client.callTool({
        name: resolveToolName((await curated.client.listTools()).tools, 'memory_recall'),
        arguments: { query: 'current memory layer session summary process material', mode: 'hybrid', limit: 5 },
      });
      const currentText = getToolText(memoryRecall);
      assert.match(currentText, /Current memory layer query contract/);
      assert.doesNotMatch(currentText, /meta-current|meta-eligible-a|meta-eligible-b|空測試會話|測試會話無實質內容|placeholder|x 字元填充/);

      const historical = await curated.client.callTool({
        name: resolveToolName((await curated.client.listTools()).tools, 'historical_recall'),
        arguments: { query: 'current memory layer session summary process material', mode: 'hybrid', agentId: 'main', limit: 10 },
      });
      const historicalText = getToolText(historical);
      assert.match(historicalText, /mcp-historical-real|Historical layer note/);
      assert.doesNotMatch(historicalText, /meta-current|meta-eligible-a|meta-eligible-b|空測試會話|測試會話無實質內容|placeholder|x 字元填充/);

      const evidence = await curated.client.callTool({
        name: resolveToolName((await curated.client.listTools()).tools, 'evidence_recall'),
        arguments: { query: 'current memory layer session summary process material', mode: 'hybrid', agentId: 'main', limit: 10 },
      });
      const evidenceText = getToolText(evidence);
      assert.match(evidenceText, /mcp-historical-real|Historical layer note/);
      assert.doesNotMatch(evidenceText, /meta-current|meta-eligible-a|meta-eligible-b|空測試會話|測試會話無實質內容|placeholder|x 字元填充/);
    } finally {
      try { await curated.client.close(); } catch {}
      try { await curated.transport.close(); } catch {}
    }
  });

  it('memory_pending returns empty after enrich', async () => {
    const result = await client.callTool({ name: 'memory_pending', arguments: {} });
    const text = getToolText(result);
    assert.match(text, /No pending or failed sessions/,
      `no pending sessions expected after enrich; got: ${text.slice(0, 200)}`);
  });
});
}
