'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAquiferFromConfig } = require('../consumers/shared/factory');

function withClearedMemoryEnv(fn) {
  const snapshot = new Map();
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('AQUIFER_MEMORY_')) continue;
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of snapshot.entries()) {
      process.env[key] = value;
    }
  }
}

function localAquifer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquifer-local-'));
  const filePath = path.join(dir, 'aquifer.local.json');
  const aquifer = withClearedMemoryEnv(() => createAquiferFromConfig({
    db: { url: null },
    storage: {
      backend: 'local',
      local: { path: filePath },
    },
  }));
  return { aquifer, filePath };
}

describe('local starter backend', () => {
  it('persists committed sessions and recalls them lexically', async () => {
    const { aquifer, filePath } = localAquifer();
    await aquifer.init();
    await aquifer.commit('local-001', [
      { role: 'user', content: 'We can try Aquifer without PostgreSQL first.' },
      { role: 'assistant', content: 'The local starter uses degraded lexical recall.' },
    ], { agentId: 'test', source: 'local-test' });

    const results = await aquifer.recall('degraded lexical', { agentId: 'test', limit: 5 });
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, 'local-001');
    assert.equal(results[0].backendKind, 'local');
    assert.match(results[0].matchedTurnText, /lexical recall/);

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(raw.sessions.length, 1);
    await aquifer.close();
  });

  it('reports local stats, bootstrap context, and export rows', async () => {
    const { aquifer } = localAquifer();
    await aquifer.commit('local-002', [
      { role: 'user', content: 'Local bootstrap should show recent raw sessions.' },
    ], { agentId: 'agent-a', source: 'api', startedAt: '2026-04-29T01:00:00.000Z' });

    const stats = await aquifer.getStats();
    assert.equal(stats.backendKind, 'local');
    assert.equal(stats.serving.mode, 'legacy');
    assert.equal(stats.memoryRecords.available, false);
    assert.equal(stats.sessionTotal, 1);
    assert.equal(stats.sessions.ready, 1);
    assert.equal(stats.turnEmbeddings, 0);

    const bootstrap = await aquifer.bootstrap({ agentId: 'agent-a', limit: 1 });
    assert.match(bootstrap.text, /Local bootstrap should show recent raw sessions/);
    assert.equal(bootstrap.meta.degraded, true);

    const rows = await aquifer.exportSessions({ agentId: 'agent-a' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, 'local-002');
    assert.equal(rows[0].backendKind, 'local');
    await aquifer.close();
  });

  it('prefers an exact local decision session over generic placeholders and reports latest stats date', async () => {
    const { aquifer } = localAquifer();
    await aquifer.commit('placeholder', [
      { role: 'user', content: 'Aquifer x x x placeholder workspace noise.' },
    ], { agentId: 'agent-a', source: 'api', startedAt: '2026-04-28T01:00:00.000Z' });
    await aquifer.commit('backend-decision', [
      { role: 'user', content: 'SQLite is not implemented; local starter lowers onboarding friction; PostgreSQL remains the full feature and test backend.' },
    ], { agentId: 'agent-a', source: 'api', startedAt: '2026-04-29T01:00:00.000Z' });

    const results = await aquifer.recall('local starter PostgreSQL full feature test backend', {
      agentId: 'agent-a',
      limit: 2,
    });
    assert.equal(results[0].sessionId, 'backend-decision');
    assert.notEqual(results[0].sessionId, 'placeholder');

    const stats = await aquifer.getStats();
    assert.equal(stats.latest, '2026-04-29T01:00:00.000Z');
    await aquifer.close();
  });

  it('can delete a local quickstart session without touching other rows', async () => {
    const { aquifer } = localAquifer();
    await aquifer.commit('keep', [{ role: 'user', content: 'keep this row' }], { agentId: 'agent-a' });
    await aquifer.commit('drop', [{ role: 'user', content: 'drop this row' }], { agentId: 'agent-a' });

    const result = await aquifer.deleteSession('drop', { agentId: 'agent-a' });
    assert.equal(result.deleted, 1);
    const rows = await aquifer.exportSessions({ agentId: 'agent-a' });
    assert.deepEqual(rows.map(r => r.session_id).sort(), ['keep']);
    await aquifer.close();
  });

  it('keeps unsupported local capabilities explicit', async () => {
    const { aquifer } = localAquifer();
    await aquifer.commit('local-003', [
      { role: 'user', content: 'Vector recall is not available in local starter.' },
    ]);

    await assert.rejects(
      () => aquifer.recall('vector', { mode: 'vector' }),
      /capability evidenceRecallVectorTurn: unsupported/
    );
    await assert.rejects(
      () => aquifer.bootstrap({ servingMode: 'curated' }),
      /capability curatedBootstrap: unsupported/
    );
    await aquifer.close();
  });
});
