'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquiferFromConfig } = require('../consumers/shared/factory');

describe('factory.createAquiferFromConfig', () => {
  it('throws if no database URL', () => {
    assert.throws(
      () => createAquiferFromConfig({ db: { url: null } }),
      /Database URL is required/
    );
  });

  it('creates aquifer with DB only (no embed, no llm)', () => {
    const aq = createAquiferFromConfig({
      db: { url: 'postgresql://localhost:5432/test' },
    });
    assert.ok(aq.migrate);
    assert.ok(aq.commit);
    assert.ok(aq.recall);
    assert.ok(aq._pool);
    aq._pool.end();
  });

  it('creates aquifer with ollama embed config', () => {
    const aq = createAquiferFromConfig({
      db: { url: 'postgresql://localhost:5432/test' },
      embed: { baseUrl: 'http://localhost:11434/v1', model: 'bge-m3' },
    });
    assert.ok(aq.recall); // embed should be configured
    aq._pool.end();
  });

  it('creates aquifer with openai embed config', () => {
    const aq = createAquiferFromConfig({
      db: { url: 'postgresql://localhost:5432/test' },
      embed: { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', apiKey: 'test-key' },
    });
    assert.ok(aq.recall);
    aq._pool.end();
  });

  it('creates aquifer with llm config', () => {
    const aq = createAquiferFromConfig({
      db: { url: 'postgresql://localhost:5432/test' },
      llm: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'test-key' },
    });
    assert.ok(aq.enrich);
    aq._pool.end();
  });

  it('recall throws without embed config', async () => {
    const aq = createAquiferFromConfig({
      db: { url: 'postgresql://localhost:5432/test' },
    });
    await assert.rejects(
      () => aq.recall('test query'),
      /requires config\.embed\.fn/
    );
    aq._pool.end();
  });

  it('attaches _pool and _config', () => {
    const aq = createAquiferFromConfig({
      db: { url: 'postgresql://localhost:5432/test' },
    });
    assert.ok(aq._pool);
    assert.ok(aq._config);
    assert.equal(aq._config.schema, 'aquifer');
    aq._pool.end();
  });

  it('respects schema override', () => {
    const aq = createAquiferFromConfig({
      db: { url: 'postgresql://localhost:5432/test' },
      schema: 'custom_schema',
    });
    assert.equal(aq._config.schema, 'custom_schema');
    aq._pool.end();
  });
});
