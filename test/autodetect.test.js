'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { autodetectForQuickstart, DEFAULT_PG_URL } = require('../consumers/shared/autodetect');

test('autodetectForQuickstart: env already set → no probes, empty result', async () => {
  const env = { DATABASE_URL: 'postgresql://user@host/db', EMBED_PROVIDER: 'ollama' };
  const detected = await autodetectForQuickstart(env, {
    probePostgres: async () => { throw new Error('should not probe'); },
    probeOllama: async () => { throw new Error('should not probe'); },
  });
  assert.deepEqual(detected, {});
});

test('autodetectForQuickstart: AQUIFER_DB_URL counts as set', async () => {
  const env = { AQUIFER_DB_URL: 'postgresql://user@host/db', EMBED_PROVIDER: 'ollama' };
  const detected = await autodetectForQuickstart(env, {
    probePostgres: async () => { throw new Error('should not probe'); },
    probeOllama: async () => true,
  });
  assert.deepEqual(detected, {});
});

test('autodetectForQuickstart: legacy AQUIFER_EMBED_BASE_URL+MODEL counts as set', async () => {
  const env = {
    DATABASE_URL: 'postgresql://a@b/c',
    AQUIFER_EMBED_BASE_URL: 'http://localhost:11434/v1',
    AQUIFER_EMBED_MODEL: 'bge-m3',
  };
  const detected = await autodetectForQuickstart(env, {
    probePostgres: async () => { throw new Error('should not probe'); },
    probeOllama: async () => { throw new Error('should not probe'); },
  });
  assert.deepEqual(detected, {});
});

test('autodetectForQuickstart: postgres reachable, no env → sets DATABASE_URL', async () => {
  const env = { EMBED_PROVIDER: 'ollama' };
  const detected = await autodetectForQuickstart(env, {
    probePostgres: async () => true,
    probeOllama: async () => { throw new Error('should not probe'); },
  });
  assert.equal(detected.DATABASE_URL, DEFAULT_PG_URL);
  assert.equal(detected.EMBED_PROVIDER, undefined);
});

test('autodetectForQuickstart: ollama reachable, no env → sets EMBED_PROVIDER', async () => {
  const env = { DATABASE_URL: 'postgresql://a@b/c' };
  const detected = await autodetectForQuickstart(env, {
    probePostgres: async () => { throw new Error('should not probe'); },
    probeOllama: async () => true,
  });
  assert.equal(detected.EMBED_PROVIDER, 'ollama');
  assert.equal(detected.DATABASE_URL, undefined);
});

test('autodetectForQuickstart: nothing reachable → empty map, env untouched', async () => {
  const env = {};
  const detected = await autodetectForQuickstart(env, {
    probePostgres: async () => false,
    probeOllama: async () => false,
  });
  assert.deepEqual(detected, {});
});

test('autodetectForQuickstart: both reachable, no env → sets both', async () => {
  const env = {};
  const detected = await autodetectForQuickstart(env, {
    probePostgres: async () => true,
    probeOllama: async () => true,
  });
  assert.equal(detected.DATABASE_URL, DEFAULT_PG_URL);
  assert.equal(detected.EMBED_PROVIDER, 'ollama');
});

test('autodetectForQuickstart: only half-legacy embed env does NOT count (needs both BASE_URL + MODEL)', async () => {
  const env = {
    DATABASE_URL: 'postgresql://a@b/c',
    AQUIFER_EMBED_BASE_URL: 'http://localhost:11434/v1',
    // AQUIFER_EMBED_MODEL intentionally missing
  };
  const detected = await autodetectForQuickstart(env, {
    probePostgres: async () => { throw new Error('should not probe'); },
    probeOllama: async () => true,
  });
  assert.equal(detected.EMBED_PROVIDER, 'ollama');
});
