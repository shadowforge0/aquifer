'use strict';

/**
 * CLI Consumer Integration Tests — spawn `consumers/cli.js` as subprocess
 * against real PostgreSQL. Verifies migrate / stats / export / bootstrap /
 * feedback all work end-to-end through the CLI arg parsing + config loader.
 *
 * 環境：
 *   AQUIFER_TEST_DB_URL="postgresql://burk:PASS@localhost:5432/openclaw_db" \
 *     node --test test/consumer-cli.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

const { createAquifer } = require('../index');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping CLI consumer integration tests.');
  process.exit(0);
}

const CLI_PATH = path.join(__dirname, '..', 'consumers', 'cli.js');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

function runCli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: {
      ...process.env,
      AQUIFER_DB_URL: DB_URL,
      AQUIFER_SCHEMA: env.AQUIFER_SCHEMA,
      AQUIFER_TENANT_ID: 'test',
      // Avoid picking up user's ~/.aquifer/config.json if any
      AQUIFER_CONFIG: '/dev/null',
      ...env,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('CLI consumer — aquifer <command> end-to-end', () => {
  let schema, pool, aq;

  before(async () => {
    schema = randomSchema();
    pool = new Pool({ connectionString: DB_URL });

    // Pre-seed one enriched session so stats/export/bootstrap have data
    aq = createAquifer({
      db: DB_URL,
      schema,
      tenantId: 'test',
      embed: { fn: async (texts) => texts.map(() => { const v = new Array(1024).fill(0); v[0] = 1; return v; }), dim: 1024 },
    });
    await aq.migrate();
    await aq.commit('cli-seed-001', [
      { role: 'user', content: 'keyword seed message one' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'keyword seed message two' },
    ], { agentId: 'cli-test', source: 'cli-test' });
    await aq.enrich('cli-seed-001', {
      agentId: 'cli-test',
      summaryFn: async () => ({
        summaryText: 'keyword CLI seed summary',
        structuredSummary: {
          title: 'CLI Seed',
          overview: 'keyword CLI seed overview',
          topics: [], decisions: [], open_loops: [],
        },
      }),
    });
  });

  after(async () => {
    try { await aq.close(); } catch {}
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end().catch(() => {}); }
  });

  it('migrate is idempotent — rerun on seeded schema succeeds', () => {
    // Schema already migrated in before(); CLI migrate should be idempotent.
    const res = runCli(['migrate'], { AQUIFER_SCHEMA: schema });
    assert.equal(res.code, 0, `migrate failed: ${res.stderr}`);
    assert.match(res.stdout, /Migrations applied successfully/);
  });

  it('stats --json reports seeded session counts', () => {
    const res = runCli(['stats', '--json'], { AQUIFER_SCHEMA: schema });
    assert.equal(res.code, 0, `stats failed: ${res.stderr}`);
    const stats = JSON.parse(res.stdout);
    assert.equal(stats.sessionTotal, 1, 'sessionTotal should be 1 after seeding');
    assert.equal(stats.summaries, 1, 'summaries should be 1 after enrich');
    assert.ok(stats.turnEmbeddings >= 2, 'two user turns → 2+ embeddings');
  });

  it('export --json emits JSONL with seeded session', () => {
    const res = runCli(['export', '--json'], { AQUIFER_SCHEMA: schema });
    assert.equal(res.code, 0, `export failed: ${res.stderr}`);
    const lines = res.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'one session exported');
    const row = JSON.parse(lines[0]);
    assert.equal(row.session_id, 'cli-seed-001');
    assert.equal(row.agent_id, 'cli-test');
    assert.equal(row.source, 'cli-test');
    assert.equal(row.summary?.title, 'CLI Seed');
  });

  it('bootstrap --json returns structured payload with seeded session', () => {
    const res = runCli(['bootstrap', '--json', '--agent-id', 'cli-test', '--limit', '5'],
      { AQUIFER_SCHEMA: schema });
    assert.equal(res.code, 0, `bootstrap failed: ${res.stderr}`);
    const payload = JSON.parse(res.stdout);
    assert.ok(Array.isArray(payload.sessions), 'bootstrap returns sessions array');
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0].sessionId, 'cli-seed-001');
  });

  it('feedback updates trust score and reports transition', () => {
    const res = runCli([
      'feedback',
      '--session-id', 'cli-seed-001',
      '--verdict', 'helpful',
      '--agent-id', 'cli-test',
      '--json',
    ], { AQUIFER_SCHEMA: schema });
    assert.equal(res.code, 0, `feedback failed: ${res.stderr}`);
    const result = JSON.parse(res.stdout);
    assert.equal(result.verdict, 'helpful');
    assert.ok(result.trustAfter > result.trustBefore,
      `helpful feedback should raise trust (before=${result.trustBefore}, after=${result.trustAfter})`);
  });

  it('--help exits 0 and lists all commands', () => {
    const res = runCli(['--help']);
    assert.equal(res.code, 0);
    for (const cmd of ['quickstart', 'migrate', 'recall', 'backfill', 'stats', 'export', 'bootstrap', 'ingest-opencode', 'mcp']) {
      assert.match(res.stdout, new RegExp(cmd), `--help should mention ${cmd}`);
    }
  });

  it('unknown command exits non-zero', () => {
    const res = runCli(['nonexistent-command'], { AQUIFER_SCHEMA: schema });
    assert.notEqual(res.code, 0, 'unknown command should fail');
  });
});
