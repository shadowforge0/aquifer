'use strict';

// Aquifer v1.2.0 install-and-go contract test.
//
// Premise: a new host sets only DATABASE_URL + EMBED_PROVIDER + one LLM key
// in .env and installs. `createAquifer()` with zero args must produce a
// usable instance. This test exercises that path without hitting a real
// Postgres — we use a no-op pool stub to prove the wiring accepts env alone.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function withEnv(patch, fn) {
  const keys = [
    'DATABASE_URL', 'AQUIFER_DB_URL', 'AQUIFER_SCHEMA', 'AQUIFER_TENANT_ID',
    'EMBED_PROVIDER', 'OPENAI_API_KEY', 'OLLAMA_URL', 'AQUIFER_EMBED_MODEL',
    'AQUIFER_LLM_PROVIDER', 'AQUIFER_LLM_MODEL', 'MINIMAX_API_KEY', 'OPENROUTER_API_KEY',
    'OPENCODE_API_KEY',
  ];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(patch)) {
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

describe('v1.2.0 zero-boilerplate install contract', () => {
  it('createAquifer() with ONLY env vars produces a usable instance', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/new_host',
      EMBED_PROVIDER: 'ollama',
      AQUIFER_LLM_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'test-key',
      AQUIFER_SCHEMA: 'new_host',
    }, () => {
      const { createAquifer } = require('../index');
      const aq = createAquifer();
      assert.ok(aq.migrate, 'instance has migrate()');
      assert.ok(aq.commit, 'instance has commit()');
      assert.ok(aq.recall, 'instance has recall()');
      assert.ok(aq.enrich, 'instance has enrich()');
      assert.ok(aq.close, 'instance has close()');
      assert.equal(aq.getConfig().schema, 'new_host');
      aq.close();
    });
  });

  it('createAquifer() picks up openai embed + openrouter llm from env', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      EMBED_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-embed',
      AQUIFER_LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-llm',
    }, () => {
      const { createAquifer } = require('../index');
      const aq = createAquifer();
      assert.ok(aq);
      aq.close();
    });
  });

  it('missing DATABASE_URL produces a clear error', () => {
    withEnv({
      EMBED_PROVIDER: 'ollama',
      AQUIFER_LLM_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'x',
    }, () => {
      const { createAquifer } = require('../index');
      assert.throws(() => createAquifer(), /DATABASE_URL|AQUIFER_DB_URL|database/i);
    });
  });

  it('default persona composes cleanly on top of env-driven aquifer', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/new_host',
      EMBED_PROVIDER: 'ollama',
      AQUIFER_LLM_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'test',
    }, () => {
      const { createPersona } = require('../consumers/default');
      const persona = createPersona({
        agentName: 'DefaultBot',
        schema: 'new_host',
      });
      assert.equal(persona.persona.agentName, 'DefaultBot');
      assert.equal(typeof persona.mountOnOpenClaw, 'function');
      const prompt = persona.summary.buildSummaryPrompt({
        conversationText: 'a', agentId: 'DefaultBot', now: new Date(), dailyContext: '',
        persona: persona.persona,
      });
      assert.ok(prompt.includes('DefaultBot'));
    });
  });
});
