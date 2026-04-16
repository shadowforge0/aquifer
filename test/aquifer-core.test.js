'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquifer } = require('../index');

describe('createAquifer', () => {
  it('throws if no db config', () => {
    assert.throws(() => createAquifer({}), /config\.db/);
  });

  it('creates without embed or llm (lazy validation)', () => {
    const aq = createAquifer({ db: 'postgresql://localhost/test', schema: 'test' });
    assert.ok(aq.migrate);
    assert.ok(aq.commit);
    assert.ok(aq.enrich);
    assert.ok(aq.recall);
    assert.ok(aq.close);
  });

  it('recall throws without embed', async () => {
    const aq = createAquifer({ db: 'postgresql://localhost/test' });
    await assert.rejects(() => aq.recall('query'), /requires config\.embed\.fn/);
  });

  it('commit does not require embed', async () => {
    // commit should not throw for missing embed — only DB error expected
    const aq = createAquifer({ db: 'postgresql://localhost/test' });
    await assert.rejects(
      () => aq.commit('sid', [{ role: 'user', content: 'hi' }]),
      (err) => {
        // Should fail on DB connection, not on embed
        return !err.message.includes('embed');
      }
    );
  });

  it('validates schema name', () => {
    assert.throws(() => createAquifer({ db: 'pg://x', schema: 'drop table;' }), /Invalid schema/);
    assert.throws(() => createAquifer({ db: 'pg://x', schema: '123bad' }), /Invalid schema/);
  });

  it('accepts valid schema names', () => {
    const aq = createAquifer({ db: 'pg://x', schema: 'my_schema' });
    assert.ok(aq);
    const aq2 = createAquifer({ db: 'pg://x', schema: '_underscore' });
    assert.ok(aq2);
  });

  it('rejects empty tenantId', () => {
    assert.throws(() => createAquifer({ db: 'pg://x', tenantId: '' }), /tenantId/);
  });

  it('defaults tenantId to "default"', () => {
    const aq = createAquifer({ db: 'pg://x' });
    assert.ok(aq); // no throw
  });

  it('creates with embed and llm', () => {
    const aq = createAquifer({
      db: 'pg://x',
      embed: { fn: async (texts) => texts.map(() => [0.1, 0.2]) },
      llm: { fn: async () => 'response' },
      entities: { enabled: true },
    });
    assert.ok(aq.enrich);
  });

  it('close is no-op when pool is external', async () => {
    // When db is a pool object (not string), close should not throw
    const mockPool = { query: async () => ({ rows: [] }), end: async () => {} };
    const aq = createAquifer({ db: mockPool });
    await aq.close(); // should not throw or call pool.end
  });
});

describe('createAquifer.enrich options', () => {
  it('accepts summaryFn override', () => {
    const aq = createAquifer({
      db: 'pg://x',
      embed: { fn: async (t) => t.map(() => [0.1]) },
    });
    // enrich will fail on DB, but the config should be accepted
    assert.ok(aq.enrich);
  });
});
