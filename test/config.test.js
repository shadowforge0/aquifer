'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../consumers/shared/config');

describe('config.loadConfig', () => {
  it('returns defaults when no env or file', () => {
    const config = loadConfig({ env: {}, cwd: '/nonexistent' });
    assert.equal(config.schema, 'aquifer');
    assert.equal(config.tenantId, 'default');
    assert.equal(config.db.url, null);
    assert.equal(config.storage.backend, 'postgres');
    assert.equal(config.storage.postgres.url, null);
    assert.equal(config.storage.local.path, '.aquifer/aquifer.local.json');
    assert.equal(config.entities.enabled, false);
    assert.equal(config.codex.checkpoint.checkIntervalMinutes, 10);
    assert.equal(config.codex.checkpoint.everyMessages, 20);
    assert.equal(config.codex.checkpoint.quietMs, 3000);
  });

  it('reads DATABASE_URL from env', () => {
    const config = loadConfig({ env: { DATABASE_URL: 'postgresql://x' } });
    assert.equal(config.db.url, 'postgresql://x');
    assert.equal(config.storage.postgres.url, 'postgresql://x');
  });

  it('reads AQUIFER_POSTGRES_URL into legacy db config', () => {
    const config = loadConfig({ env: { AQUIFER_POSTGRES_URL: 'postgresql://new' } });
    assert.equal(config.db.url, 'postgresql://new');
    assert.equal(config.storage.postgres.url, 'postgresql://new');
  });

  it('reads local backend config from env', () => {
    const config = loadConfig({
      env: {
        AQUIFER_BACKEND: 'local',
        AQUIFER_LOCAL_PATH: '/tmp/aquifer-local.json',
      },
    });
    assert.equal(config.storage.backend, 'local');
    assert.equal(config.storage.local.path, '/tmp/aquifer-local.json');
    assert.equal(config.db.url, null);
  });

  it('rejects unknown backend config', () => {
    assert.throws(
      () => loadConfig({ env: { AQUIFER_BACKEND: 'sqlite' } }),
      /Invalid Aquifer backend/
    );
  });

  it('AQUIFER_DB_URL overrides DATABASE_URL', () => {
    const config = loadConfig({ env: { DATABASE_URL: 'a', AQUIFER_DB_URL: 'b' } });
    assert.equal(config.db.url, 'b');
  });

  it('coerces Number env vars', () => {
    const config = loadConfig({ env: { AQUIFER_DB_MAX: '20' } });
    assert.equal(config.db.max, 20);
    assert.equal(typeof config.db.max, 'number');
  });

  it('coerces Boolean env vars — true variants', () => {
    for (const val of ['true', '1', 'yes']) {
      const config = loadConfig({ env: { AQUIFER_ENTITIES_ENABLED: val } });
      assert.equal(config.entities.enabled, true, `'${val}' should be true`);
    }
  });

  it('coerces Boolean env vars — false variants', () => {
    for (const val of ['false', '0', 'no', '']) {
      const config = loadConfig({ env: { AQUIFER_ENTITIES_ENABLED: val } });
      assert.equal(config.entities.enabled, false, `'${val}' should be false`);
    }
  });

  it('programmatic overrides win over env', () => {
    const config = loadConfig({
      env: { AQUIFER_SCHEMA: 'from_env' },
      overrides: { schema: 'from_code' },
    });
    assert.equal(config.schema, 'from_code');
  });

  it('deep merges embed config', () => {
    const config = loadConfig({
      env: { AQUIFER_EMBED_MODEL: 'bge-m3' },
      overrides: { embed: { baseUrl: 'http://localhost:11434/v1' } },
    });
    assert.equal(config.embed.model, 'bge-m3');
    assert.equal(config.embed.baseUrl, 'http://localhost:11434/v1');
    assert.equal(config.embed.timeoutMs, 120000); // default preserved
  });

  it('handles empty string env vars as unset', () => {
    const config = loadConfig({ env: { AQUIFER_SCHEMA: '' } });
    assert.equal(config.schema, 'aquifer'); // default, not ''
  });

  it('handles NaN from bad number env', () => {
    const config = loadConfig({ env: { AQUIFER_DB_MAX: 'abc' } });
    assert.ok(Number.isNaN(config.db.max));
  });

  it('ignores missing config file gracefully', () => {
    const config = loadConfig({ cwd: '/tmp/nonexistent-dir-12345', env: {} });
    assert.equal(config.schema, 'aquifer');
  });

  it('reads AQUIFER_ENTITY_SCOPE from env', () => {
    const config = loadConfig({ env: { AQUIFER_ENTITY_SCOPE: 'my-scope' } });
    assert.equal(config.entities.scope, 'my-scope');
  });

  it('defaults entities.scope to "default"', () => {
    const config = loadConfig({ env: {} });
    assert.equal(config.entities.scope, 'default');
  });

  it('sets insights.dedup defaults', () => {
    const config = loadConfig({ env: {}, cwd: '/nonexistent' });
    assert.equal(config.insights.dedup.mode, 'off');
    assert.equal(config.insights.dedup.cosineThreshold, 0.88);
    assert.equal(config.insights.dedup.closeBandFrom, 0.85);
  });

  it('reads AQUIFER_INSIGHTS_DEDUP_MODE from env', () => {
    const config = loadConfig({ env: { AQUIFER_INSIGHTS_DEDUP_MODE: 'shadow' } });
    assert.equal(config.insights.dedup.mode, 'shadow');
  });

  it('reads AQUIFER_INSIGHTS_DEDUP_COSINE from env', () => {
    const config = loadConfig({ env: { AQUIFER_INSIGHTS_DEDUP_COSINE: '0.92' } });
    assert.equal(config.insights.dedup.cosineThreshold, 0.92);
  });

  it('reads AQUIFER_INSIGHTS_DEDUP_CLOSE_BAND_FROM from env', () => {
    const config = loadConfig({ env: { AQUIFER_INSIGHTS_DEDUP_CLOSE_BAND_FROM: '0.80' } });
    assert.equal(config.insights.dedup.closeBandFrom, 0.8);
  });

  it('treats empty AQUIFER_INSIGHTS_DEDUP_MODE as unset', () => {
    const config = loadConfig({ env: { AQUIFER_INSIGHTS_DEDUP_MODE: '' } });
    assert.equal(config.insights.dedup.mode, 'off');
  });

  it('programmatic insights.dedup.mode override wins over env', () => {
    const config = loadConfig({
      env: { AQUIFER_INSIGHTS_DEDUP_MODE: 'off' },
      overrides: { insights: { dedup: { mode: 'enforce' } } },
    });
    assert.equal(config.insights.dedup.mode, 'enforce');
  });

  it('normalizes insights.dedup shorthand true', () => {
    const config = loadConfig({
      env: {},
      overrides: { insights: { dedup: true } },
    });
    assert.deepEqual(config.insights.dedup, {
      mode: 'enforce',
      cosineThreshold: 0.88,
      closeBandFrom: 0.85,
    });
  });

  it('normalizes insights.dedup shorthand false', () => {
    const config = loadConfig({
      env: {},
      overrides: { insights: { dedup: false } },
    });
    assert.deepEqual(config.insights.dedup, {
      mode: 'off',
      cosineThreshold: 0.88,
      closeBandFrom: 0.85,
    });
  });

  it('deep merges partial insights.dedup override', () => {
    const config = loadConfig({
      env: {},
      overrides: { insights: { dedup: { mode: 'shadow' } } },
    });
    assert.equal(config.insights.dedup.mode, 'shadow');
    assert.equal(config.insights.dedup.cosineThreshold, 0.88);
    assert.equal(config.insights.dedup.closeBandFrom, 0.85);
  });

  it('preserves null insights recall defaults', () => {
    const config = loadConfig({ env: {} });
    assert.equal(config.insights.recallWeights, null);
    assert.equal(config.insights.recencyWindowDays, null);
  });

  it('reads AQUIFER_MEMORY_SERVING_MODE from env', () => {
    const config = loadConfig({ env: { AQUIFER_MEMORY_SERVING_MODE: 'curated' } });
    assert.equal(config.memory.servingMode, 'curated');
  });

  it('programmatic memory.servingMode override wins over env', () => {
    const config = loadConfig({
      env: { AQUIFER_MEMORY_SERVING_MODE: 'legacy' },
      overrides: { memory: { servingMode: 'curated' } },
    });
    assert.equal(config.memory.servingMode, 'curated');
  });

  it('reads Codex checkpoint heartbeat policy from env', () => {
    const config = loadConfig({
      env: {
        AQUIFER_CODEX_CHECKPOINT_CHECK_INTERVAL_MINUTES: '15',
        AQUIFER_CODEX_CHECKPOINT_EVERY_MESSAGES: '30',
        AQUIFER_CODEX_CHECKPOINT_EVERY_USER_MESSAGES: '12',
        AQUIFER_CODEX_CHECKPOINT_QUIET_MS: '5000',
        AQUIFER_CODEX_CHECKPOINT_CLAIM_TTL_MS: '90000',
      },
    });
    assert.equal(config.codex.checkpoint.checkIntervalMinutes, 15);
    assert.equal(config.codex.checkpoint.everyMessages, 30);
    assert.equal(config.codex.checkpoint.everyUserMessages, 12);
    assert.equal(config.codex.checkpoint.quietMs, 5000);
    assert.equal(config.codex.checkpoint.claimTtlMs, 90000);
  });
});
