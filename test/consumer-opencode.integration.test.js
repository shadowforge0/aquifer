'use strict';

/**
 * OpenCode Consumer Integration Tests — real PostgreSQL + real SQLite fixture.
 *
 * Covers the full path: SQLite session data → ingestOpenCode() → Aquifer.commit()
 * → PG miranda.sessions rows. Asserts normalization (user/assistant merge,
 * tool part inclusion), source/agentId metadata, and too-short filter.
 *
 * 環境（同 integration.test.js）：
 *   AQUIFER_TEST_DB_URL="postgresql://burk:PASS@localhost:5432/openclaw_db" \
 *     node --test test/consumer-opencode.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { DatabaseSync } = require('node:sqlite');

const { createAquifer } = require('../index');
const { ingestOpenCode } = require('../consumers/opencode');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('OpenCode consumer integration tests');

// ---------------------------------------------------------------------------
// SQLite fixture — OpenCode schema subset (session, message, part)
// ---------------------------------------------------------------------------

function createOpenCodeFixture(sessions) {
  const tmpPath = path.join(os.tmpdir(), `aquifer-oc-${crypto.randomBytes(6).toString('hex')}.db`);
  const db = new DatabaseSync(tmpPath);

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      data TEXT,
      time_created INTEGER
    );
  `);

  const insSession = db.prepare(
    'INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insMsg = db.prepare(
    'INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)'
  );
  const insPart = db.prepare(
    'INSERT INTO part (id, session_id, message_id, data, time_created) VALUES (?, ?, ?, ?, ?)'
  );

  for (const s of sessions) {
    insSession.run(s.id, s.projectId || null, s.parentId || null, s.directory || null, s.title || null, s.timeCreated, s.timeUpdated);
    for (const m of s.messages) {
      insMsg.run(m.id, s.id, JSON.stringify(m.data), m.time);
      for (const p of (m.parts || [])) {
        insPart.run(p.id, s.id, m.id, JSON.stringify(p.data), p.time);
      }
    }
  }

  db.close();
  return tmpPath;
}

function muteLogs(fn) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  return Promise.resolve(fn()).finally(() => {
    console.log = origLog;
    console.error = origErr;
  });
}

// ---------------------------------------------------------------------------
// Aquifer test instance (same pattern as integration.test.js)
// ---------------------------------------------------------------------------

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

async function createTestAquifer() {
  const schema = randomSchema();
  const pool = new Pool({ connectionString: DB_URL });

  const aq = createAquifer({
    db: DB_URL,
    schema,
    tenantId: 'test',
    embed: { fn: async (texts) => texts.map(() => [1, 0, 0]) },
  });

  await aq.migrate();
  return { aq, pool, schema };
}

async function teardown(aq, pool, schema, fixturePath) {
  try { await aq.close(); } catch {}
  try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await pool.end().catch(() => {}); }
  if (fixturePath) { try { fs.unlinkSync(fixturePath); } catch {} }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

if (DB_URL) {
describe('OpenCode consumer — ingestOpenCode end-to-end', () => {
  let aq, pool, schema, fixturePath;

  before(async () => {
    ({ aq, pool, schema } = await createTestAquifer());

    // Fixture：兩個 session
    // A: 3 user msgs + merged assistant reply → 應該 commit 進 DB
    // B: 1 user msg → 應該被 min-messages=3 filter 掉
    fixturePath = createOpenCodeFixture([
      {
        id: 'ses_valid_001',
        directory: '/home/test/proj',
        title: 'keyword valid session',
        timeCreated: 1000,
        timeUpdated: 5000,
        messages: [
          {
            id: 'msg_u1', time: 1000,
            data: { role: 'user', modelID: 'claude-sonnet-4-6' },
            parts: [{ id: 'p1', time: 1000, data: { type: 'text', text: 'hello from user 1' } }],
          },
          {
            id: 'msg_a1', time: 1100,
            data: { role: 'assistant', model: { modelID: 'claude-sonnet-4-6' }, tokens: { input: 10, output: 20 } },
            parts: [
              { id: 'p2', time: 1100, data: { type: 'text', text: 'hi from assistant step 1' } },
              { id: 'p3', time: 1110, data: { type: 'tool', tool: 'bash', state: { output: 'ls output here' } } },
            ],
          },
          {
            id: 'msg_a1_step2', time: 1120,
            data: { role: 'assistant', model: { modelID: 'claude-sonnet-4-6' }, tokens: { input: 5, output: 15 } },
            parts: [{ id: 'p4', time: 1120, data: { type: 'text', text: 'assistant continuation' } }],
          },
          {
            id: 'msg_u2', time: 2000,
            data: { role: 'user' },
            parts: [{ id: 'p5', time: 2000, data: { type: 'text', text: 'second user turn' } }],
          },
          {
            id: 'msg_a2', time: 2100,
            data: { role: 'assistant', tokens: { input: 8, output: 12 } },
            parts: [{ id: 'p6', time: 2100, data: { type: 'text', text: 'second assistant reply' } }],
          },
          {
            id: 'msg_u3', time: 3000,
            data: { role: 'user' },
            parts: [{ id: 'p7', time: 3000, data: { type: 'text', text: 'third user turn' } }],
          },
          {
            id: 'msg_a3', time: 3100,
            data: { role: 'assistant', tokens: { input: 4, output: 10 } },
            parts: [{ id: 'p8', time: 3100, data: { type: 'text', text: 'third assistant reply' } }],
          },
        ],
      },
      {
        id: 'ses_short_002',
        directory: '/home/test/proj',
        title: 'too short',
        timeCreated: 4000,
        timeUpdated: 4500,
        messages: [
          {
            id: 'msg_shortu', time: 4000,
            data: { role: 'user' },
            parts: [{ id: 'p_s1', time: 4000, data: { type: 'text', text: 'only one user msg' } }],
          },
          {
            id: 'msg_shorta', time: 4100,
            data: { role: 'assistant' },
            parts: [{ id: 'p_s2', time: 4100, data: { type: 'text', text: 'single reply' } }],
          },
        ],
      },
    ]);
  });

  after(async () => {
    await teardown(aq, pool, schema, fixturePath);
  });

  it('commits valid session and skips too-short', async () => {
    await muteLogs(() => ingestOpenCode(aq, {
      flags: { db: fixturePath, 'agent-id': 'main', 'min-messages': '3', limit: '50' },
    }));

    // 驗證：valid session 進 DB，too-short 沒進
    const rows = await pool.query(
      `SELECT session_id, agent_id, source, model, tokens_in, tokens_out
       FROM "${schema}".sessions
       WHERE tenant_id = 'test'
       ORDER BY session_id`
    );
    assert.equal(rows.rows.length, 1, 'only valid session should be committed');
    const row = rows.rows[0];
    assert.equal(row.session_id, 'ses_valid_001');
    assert.equal(row.source, 'opencode');
    assert.equal(row.agent_id, 'main');
    assert.equal(row.model, 'claude-sonnet-4-6');
    assert.equal(Number(row.tokens_in), 27, 'input tokens summed across assistant msgs');
    assert.equal(Number(row.tokens_out), 57, 'output tokens summed across assistant msgs');
  });

  it('normalizes consecutive assistant steps into a single turn', async () => {
    const res = await pool.query(
      `SELECT messages FROM "${schema}".sessions
       WHERE session_id = 'ses_valid_001' AND tenant_id = 'test'`
    );
    const raw = res.rows[0].messages;
    // commit() wraps the normalized array as { normalized: [...] }.
    const msgs = raw.normalized || raw.messages || raw;
    assert.ok(Array.isArray(msgs), 'messages column should carry normalized array');
    const roles = msgs.map(m => m.role);
    // Pattern expected: user, assistant, user, assistant, user, assistant (3U+3A)
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
      'two consecutive assistant messages should be merged');
    // Merged content should include both text parts + the tool output
    assert.match(msgs[1].content, /assistant step 1/);
    assert.match(msgs[1].content, /assistant continuation/);
    assert.match(msgs[1].content, /\[bash\]: ls output here/, 'tool parts included in normalized content');
  });

  it('is idempotent — second ingest skips already-committed session', async () => {
    const before = await pool.query(
      `SELECT COUNT(*) AS n FROM "${schema}".sessions WHERE tenant_id = 'test'`
    );
    await muteLogs(() => ingestOpenCode(aq, {
      flags: { db: fixturePath, 'agent-id': 'main', 'min-messages': '3', limit: '50' },
    }));
    const after = await pool.query(
      `SELECT COUNT(*) AS n FROM "${schema}".sessions WHERE tenant_id = 'test'`
    );
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n),
      're-running ingest should not duplicate sessions');
  });

  it('session-id flag ingests a single session even if already exists', async () => {
    // session-id mode bypasses the existingSet check (per consumer line 235)
    await muteLogs(() => ingestOpenCode(aq, {
      flags: { db: fixturePath, 'agent-id': 'main', 'session-id': 'ses_valid_001', 'min-messages': '3' },
    }));
    // Still 1 row (upsert on conflict)
    const res = await pool.query(
      `SELECT COUNT(*) AS n FROM "${schema}".sessions
       WHERE session_id = 'ses_valid_001' AND tenant_id = 'test'`
    );
    assert.equal(Number(res.rows[0].n), 1);
  });
});
}
