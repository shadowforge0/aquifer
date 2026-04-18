'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquifer } = require('../index');

function withEnv(envPatch, fn) {
  const keys = [
    'DATABASE_URL', 'AQUIFER_DB_URL',
    'EMBED_PROVIDER', 'OPENAI_API_KEY', 'OLLAMA_URL',
    'AQUIFER_EMBED_BASE_URL', 'AQUIFER_EMBED_MODEL', 'AQUIFER_EMBED_DIM',
  ];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(envPatch)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('createAquifer — embed autodetect', () => {
  it('explicit config.embed.fn beats env', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      EMBED_PROVIDER: 'openai',
      OPENAI_API_KEY: 'env-key',
    }, () => {
      const myFn = async (texts) => texts.map(() => [0.42]);
      const aq = createAquifer({ embed: { fn: myFn } });
      assert.ok(aq);
      aq.close();
    });
  });

  it('config.embed.provider builds embedder', () => {
    const aq = createAquifer({
      db: 'postgresql://localhost/test',
      embed: { provider: 'ollama', ollamaUrl: 'http://localhost:11434', model: 'bge-m3' },
    });
    assert.ok(aq.recall);
    aq.close();
  });

  it('EMBED_PROVIDER=ollama env wires default ollama', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      EMBED_PROVIDER: 'ollama',
    }, () => {
      const aq = createAquifer();
      assert.ok(aq.recall);
      aq.close();
    });
  });

  it('EMBED_PROVIDER=openai uses OPENAI_API_KEY + AQUIFER_EMBED_MODEL', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      EMBED_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
      AQUIFER_EMBED_MODEL: 'text-embedding-3-large',
    }, () => {
      const aq = createAquifer();
      assert.ok(aq);
      aq.close();
    });
  });

  it('EMBED_PROVIDER=openai without key throws clearly', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      EMBED_PROVIDER: 'openai',
    }, () => {
      assert.throws(() => createAquifer(), /OPENAI_API_KEY/);
    });
  });

  it('unknown EMBED_PROVIDER throws', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      EMBED_PROVIDER: 'bogus',
    }, () => {
      assert.throws(() => createAquifer(), /not supported/);
    });
  });

  it('no embed configured → lazy throw on recall, not on construct', async () => {
    withEnv({ DATABASE_URL: 'postgresql://localhost/test' }, async () => {
      const aq = createAquifer();
      assert.ok(aq.recall);
      await assert.rejects(() => aq.recall('query'), /embed/i);
      aq.close();
    });
  });

  it('no embed configured → commit still works (does not need embed)', () => {
    withEnv({ DATABASE_URL: 'postgresql://localhost/test' }, () => {
      const aq = createAquifer();
      assert.ok(aq.commit);
      aq.close();
    });
  });
});
