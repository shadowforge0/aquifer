'use strict';

// P3-d — Miranda daily-log render reference impl test.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { renderDailyMd } = require('../consumers/miranda/render-daily-md');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping miranda render test.');
  process.exit(0);
}

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

describe('Miranda daily log render', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;

  before(async () => {
    pool = new Pool({ connectionString: DB_URL });
    aquifer = createAquifer({
      db: DB_URL, schema, tenantId: 'default',
      embed: { fn: async () => [[0]], dim: 1 },
    });
    await aquifer.migrate();
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await aquifer.close();
    await pool.end();
  });

  it('renders markdown with state + narrative + timeline + handoff', async () => {
    // Seed timeline across categories.
    await aquifer.timeline.append({
      agentId: 'main', occurredAt: '2026-04-19T09:00:00Z',
      source: 'test', category: 'focus', text: 'ship P3-d',
    });
    await aquifer.timeline.append({
      agentId: 'main', occurredAt: '2026-04-19T10:30:00Z',
      source: 'test', category: 'todo', text: 'MCP manifest',
    });
    await aquifer.timeline.append({
      agentId: 'main', occurredAt: '2026-04-19T14:00:00Z',
      source: 'test', category: 'note', text: 'figured out ingest bug',
    });
    // Event on a different day — should NOT appear in 2026-04-19 render.
    await aquifer.timeline.append({
      agentId: 'main', occurredAt: '2026-04-20T09:00:00Z',
      source: 'test', category: 'focus', text: 'next day',
    });

    await aquifer.state.write({
      agentId: 'main',
      payload: {
        goal: 'finish P3',
        active_work: ['render-daily-md', 'MCP manifest'],
        blockers: [],
        affect: { mood: 'focused', energy: 'high' },
      },
    });

    await aquifer.narratives.upsertSnapshot({
      agentId: 'main', text: 'Aquifer completion work landing; consumer profiles online.',
    });

    await aquifer.handoff.write({
      agentId: 'main', sessionId: 'sess-x',
      payload: {
        last_step: 'render reference impl',
        status: 'in_progress',
        next: 'wire into OpenClaw',
        blockers: [], decided: ['use envelope'], open_loops: ['facts pipe diagnose'],
      },
    });

    const r = await renderDailyMd({
      aquifer, date: '2026-04-19', agentId: 'main',
    });

    assert.ok(r.markdown.includes('# 2026-04-19'));
    assert.ok(r.markdown.includes('## State'));
    assert.ok(r.markdown.includes('finish P3'));
    assert.ok(r.markdown.includes('## Narrative'));
    assert.ok(r.markdown.includes('Aquifer completion'));
    assert.ok(r.markdown.includes('## Focus'));
    assert.ok(r.markdown.includes('ship P3-d'));
    assert.ok(r.markdown.includes('## Todo'));
    assert.ok(r.markdown.includes('MCP manifest'));
    assert.ok(r.markdown.includes('## Note'));
    assert.ok(r.markdown.includes('## Handoff'));
    assert.ok(r.markdown.includes('render reference impl'));
    // Events from the other day must NOT leak in.
    assert.ok(!r.markdown.includes('next day'));
  });

  it('artifact record declaration is well-formed + idempotency-stable', async () => {
    const r1 = await renderDailyMd({
      aquifer, date: '2026-04-19', agentId: 'main',
    });
    const r2 = await renderDailyMd({
      aquifer, date: '2026-04-19', agentId: 'main',
    });
    assert.equal(r1.artifact.idempotencyKey, r2.artifact.idempotencyKey);
    assert.equal(r1.artifact.producerId, 'miranda.workspace.daily-log');
    assert.equal(r1.artifact.type, 'daily-log');
    assert.equal(r1.artifact.format, 'markdown');
    assert.equal(r1.artifact.destination, 'workspace://memory/2026-04-19.md');
    assert.equal(r1.artifact.payload.date, '2026-04-19');
    assert.ok(r1.artifact.payload.event_count >= 3);
  });

  it('integrates with aq.artifacts.record — round-trip from pending to produced', async () => {
    const r = await renderDailyMd({
      aquifer, date: '2026-04-19', agentId: 'main',
    });
    // Producer records pending first.
    const rec1 = await aquifer.artifacts.record({
      agentId: 'main',
      producerId: r.artifact.producerId,
      type: r.artifact.type,
      format: r.artifact.format,
      destination: r.artifact.destination,
      idempotencyKey: r.artifact.idempotencyKey,
      payload: r.artifact.payload,
      status: 'pending',
    });
    assert.equal(rec1.ok, true);
    // After rendering / writing file, flips to produced.
    const rec2 = await aquifer.artifacts.record({
      agentId: 'main',
      producerId: r.artifact.producerId,
      type: r.artifact.type,
      format: r.artifact.format,
      destination: r.artifact.destination,
      idempotencyKey: r.artifact.idempotencyKey,
      payload: r.artifact.payload,
      status: 'produced',
      contentRef: `sha256:${crypto.createHash('sha256').update(r.markdown).digest('hex')}`,
    });
    assert.equal(rec2.ok, true);
    assert.equal(rec1.data.artifactId, rec2.data.artifactId);

    const list = await aquifer.artifacts.list({
      agentId: 'main', producerId: r.artifact.producerId,
    });
    const entry = list.data.rows.find(x => x.artifactId === rec1.data.artifactId);
    assert.equal(entry.status, 'produced');
    assert.ok(entry.contentRef.startsWith('sha256:'));
  });

  it('rejects invalid date format', async () => {
    await assert.rejects(
      () => renderDailyMd({ aquifer, date: 'bad-date', agentId: 'main' }),
      /YYYY-MM-DD/,
    );
  });
});
