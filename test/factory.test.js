'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquiferFromConfig } = require('../consumers/shared/factory');

function cleanOverrides(overrides = {}) {
  const base = {
    db: { url: 'postgresql://localhost:5432/test' },
    schema: 'aquifer',
    tenantId: 'default',
    embed: { baseUrl: null, model: null, apiKey: null, dim: null },
    llm: { baseUrl: null, model: null, apiKey: null },
    memory: { servingMode: 'legacy' },
  };
  return {
    ...base,
    ...overrides,
    db: { ...base.db, ...(overrides.db || {}) },
    embed: { ...base.embed, ...(overrides.embed || {}) },
    llm: { ...base.llm, ...(overrides.llm || {}) },
    memory: { ...base.memory, ...(overrides.memory || {}) },
  };
}

describe('factory.createAquiferFromConfig', () => {
  it('throws if no database URL', () => {
    assert.throws(
      () => createAquiferFromConfig(cleanOverrides({ db: { url: null } })),
      /Database URL is required/
    );
  });

  it('creates aquifer with DB only (no embed, no llm)', async () => {
    const aq = createAquiferFromConfig(cleanOverrides());
    assert.ok(aq.migrate);
    assert.ok(aq.commit);
    assert.ok(aq.recall);
    assert.ok(typeof aq.close === 'function');
    await aq.close();
  });

  it('creates aquifer with ollama embed config', async () => {
    const aq = createAquiferFromConfig(cleanOverrides({
      embed: { baseUrl: 'http://localhost:11434/v1', model: 'bge-m3' },
    }));
    assert.ok(aq.recall); // embed should be configured
    await aq.close();
  });

  it('creates aquifer with openai embed config', async () => {
    const aq = createAquiferFromConfig(cleanOverrides({
      embed: { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', apiKey: 'test-key' },
    }));
    assert.ok(aq.recall);
    await aq.close();
  });

  it('creates aquifer with llm config', async () => {
    const aq = createAquiferFromConfig(cleanOverrides({
      llm: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'test-key' },
    }));
    assert.ok(aq.enrich);
    await aq.close();
  });

  it('recall throws without embed config', async () => {
    const aq = createAquiferFromConfig(cleanOverrides());
    try {
      await assert.rejects(
        () => aq.recall('test query'),
        /requires config\.embed\.fn/
      );
    } finally {
      await aq.close();
    }
  });

  it('exposes getConfig with schema and tenantId', async () => {
    const aq = createAquiferFromConfig(cleanOverrides());
    const cfg = aq.getConfig();
    assert.ok(cfg);
    assert.equal(cfg.schema, 'aquifer');
    assert.equal(cfg.tenantId, 'default');
    await aq.close();
  });

  it('respects schema override via getConfig', async () => {
    const aq = createAquiferFromConfig(cleanOverrides({
      schema: 'custom_schema',
    }));
    assert.equal(aq.getConfig().schema, 'custom_schema');
    await aq.close();
  });

  it('passes memory serving mode through to core config', async () => {
    const aq = createAquiferFromConfig(cleanOverrides({
      memory: { servingMode: 'curated' },
    }));
    assert.equal(aq.getConfig().memoryServingMode, 'curated');
    await aq.close();
  });
});
