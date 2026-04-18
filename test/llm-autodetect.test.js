'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveLlmFn } = require('../consumers/shared/llm-autodetect');
const { createAquifer } = require('../index');

function envSnapshot(keys) {
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}
function envRestore(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function withEnv(patch, fn) {
  const keys = [
    'DATABASE_URL', 'AQUIFER_DB_URL',
    'AQUIFER_LLM_PROVIDER', 'AQUIFER_LLM_MODEL', 'AQUIFER_LLM_TIMEOUT',
    'MINIMAX_API_KEY', 'OPENCODE_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  ];
  const saved = envSnapshot(keys);
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    envRestore(saved);
  }
}

describe('resolveLlmFn', () => {
  it('returns null when no config and no env', () => {
    withEnv({}, () => {
      assert.equal(resolveLlmFn(null, process.env), null);
      assert.equal(resolveLlmFn(undefined, process.env), null);
      assert.equal(resolveLlmFn({}, process.env), null);
    });
  });

  it('returns explicit config.llm.fn when given', () => {
    withEnv({ AQUIFER_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-' }, () => {
      const myFn = async () => 'hi';
      assert.equal(resolveLlmFn({ fn: myFn }, process.env), myFn);
    });
  });

  it('minimax provider needs MINIMAX_API_KEY', () => {
    withEnv({ AQUIFER_LLM_PROVIDER: 'minimax' }, () => {
      assert.throws(() => resolveLlmFn(null, process.env), /MINIMAX_API_KEY/);
    });
  });

  it('opencode provider needs OPENCODE_API_KEY', () => {
    withEnv({ AQUIFER_LLM_PROVIDER: 'opencode' }, () => {
      assert.throws(() => resolveLlmFn(null, process.env), /OPENCODE_API_KEY/);
    });
  });

  it('openai provider needs OPENAI_API_KEY', () => {
    withEnv({ AQUIFER_LLM_PROVIDER: 'openai' }, () => {
      assert.throws(() => resolveLlmFn(null, process.env), /OPENAI_API_KEY/);
    });
  });

  it('openrouter provider needs OPENROUTER_API_KEY', () => {
    withEnv({ AQUIFER_LLM_PROVIDER: 'openrouter' }, () => {
      assert.throws(() => resolveLlmFn(null, process.env), /OPENROUTER_API_KEY/);
    });
  });

  it('unknown provider throws with valid list', () => {
    withEnv({ AQUIFER_LLM_PROVIDER: 'claude' }, () => {
      assert.throws(() => resolveLlmFn(null, process.env), /not supported/);
    });
  });

  it('minimax with key returns a function', () => {
    withEnv({ AQUIFER_LLM_PROVIDER: 'minimax', MINIMAX_API_KEY: 'test' }, () => {
      const fn = resolveLlmFn(null, process.env);
      assert.equal(typeof fn, 'function');
    });
  });

  it('openai with key returns a function', () => {
    withEnv({ AQUIFER_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, () => {
      const fn = resolveLlmFn(null, process.env);
      assert.equal(typeof fn, 'function');
    });
  });

  it('AQUIFER_LLM_MODEL overrides default model (smoke: no throw)', () => {
    withEnv({
      AQUIFER_LLM_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'test',
      AQUIFER_LLM_MODEL: 'MiniMax-M2.5',
    }, () => {
      assert.equal(typeof resolveLlmFn(null, process.env), 'function');
    });
  });
});

describe('createAquifer — llm autodetect integration', () => {
  it('picks llm from env, no explicit config needed', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      AQUIFER_LLM_PROVIDER: 'minimax',
      MINIMAX_API_KEY: 'test',
    }, () => {
      const aq = createAquifer();
      assert.ok(aq.enrich);
      aq.close();
    });
  });

  it('explicit llm.fn beats env', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      AQUIFER_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'env-key',
    }, () => {
      const myFn = async () => 'explicit';
      const aq = createAquifer({ llm: { fn: myFn } });
      assert.ok(aq);
      aq.close();
    });
  });
});
