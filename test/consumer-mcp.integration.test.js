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

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping MCP consumer integration tests.');
  process.exit(0);
}

// Lazy require — SDK is optional at module scope, only needed for these tests
let Client, StdioClientTransport;
try {
  ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
  ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));
} catch (err) {
  console.error(`MCP SDK not installed; skipping MCP integration tests: ${err.message}`);
  process.exit(0);
}

const CLI_PATH = path.join(__dirname, '..', 'consumers', 'cli.js');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

async function connectMcpClient(schema) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH, 'mcp'],
    env: {
      ...process.env,
      AQUIFER_DB_URL: DB_URL,
      AQUIFER_SCHEMA: schema,
      AQUIFER_TENANT_ID: 'test',
      AQUIFER_CONFIG: '/dev/null',
    },
  });
  const client = new Client({ name: 'aquifer-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

function getToolText(result) {
  const block = (result.content || []).find(c => c.type === 'text');
  return block ? block.text : '';
}

describe('MCP consumer — aquifer mcp tool surface', () => {
  let schema, pool, aq, client, transport;

  before(async () => {
    schema = randomSchema();
    pool = new Pool({ connectionString: DB_URL });

    aq = createAquifer({
      db: DB_URL,
      schema,
      tenantId: 'test',
      embed: { fn: async (texts) => texts.map(() => [1, 0, 0]), dim: 3 },
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

    ({ client, transport } = await connectMcpClient(schema));
  });

  after(async () => {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
    try { await aq.close(); } catch {}
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end().catch(() => {}); }
  });

  it('listTools exposes the five Aquifer tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name).sort();
    assert.deepEqual(
      names,
      ['memory_pending', 'memory_stats', 'session_bootstrap', 'session_feedback', 'session_recall']
    );
  });

  it('memory_stats returns storage counts', async () => {
    const result = await client.callTool({ name: 'memory_stats', arguments: {} });
    const text = getToolText(result);
    assert.match(text, /Sessions:\s*1\b/);
    assert.match(text, /Summaries:\s*1/);
    assert.match(text, /Turn embeddings:\s*\d/);
  });

  it('session_recall finds seeded session by keyword (fts mode, no embed call)', async () => {
    const result = await client.callTool({
      name: 'session_recall',
      arguments: { query: 'MCP seed', mode: 'fts', limit: 3 },
    });
    const text = getToolText(result);
    assert.match(text, /mcp-seed-001|MCP Seed/,
      `recall should surface seeded session; got: ${text.slice(0, 200)}`);
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

  it('session_feedback updates trust score', async () => {
    const result = await client.callTool({
      name: 'session_feedback',
      arguments: { sessionId: 'mcp-seed-001', verdict: 'helpful', agentId: 'mcp-test' },
    });
    const text = getToolText(result);
    assert.match(text, /Feedback:\s*helpful/);
    assert.match(text, /trust.*→/);
  });

  it('memory_pending returns empty after enrich', async () => {
    const result = await client.callTool({ name: 'memory_pending', arguments: {} });
    const text = getToolText(result);
    assert.match(text, /No pending or failed sessions/,
      `no pending sessions expected after enrich; got: ${text.slice(0, 200)}`);
  });
});
