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
    assert.equal(config.entities.enabled, false);
  });

  it('reads DATABASE_URL from env', () => {
    const config = loadConfig({ env: { DATABASE_URL: 'postgresql://x' } });
    assert.equal(config.db.url, 'postgresql://x');
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
});
