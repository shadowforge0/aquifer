'use strict';

const { Pool } = require('pg');

const DEFAULT_PG_URL = 'postgresql://aquifer:aquifer@localhost:5432/aquifer';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

async function probePostgres(url, { timeoutMs = 1500 } = {}) {
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    max: 1,
  });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    try { await pool.end(); } catch { /* ignore */ }
  }
}

async function probeOllama(baseUrl, { timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function autodetectForQuickstart(env, probes = {}) {
  const probePg = probes.probePostgres || probePostgres;
  const probeOll = probes.probeOllama || probeOllama;
  const detected = {};

  const hasDb = env.DATABASE_URL || env.AQUIFER_DB_URL;
  if (!hasDb && await probePg(DEFAULT_PG_URL)) {
    detected.DATABASE_URL = DEFAULT_PG_URL;
  }

  const hasEmbed = env.EMBED_PROVIDER
    || (env.AQUIFER_EMBED_BASE_URL && env.AQUIFER_EMBED_MODEL);
  if (!hasEmbed && await probeOll(DEFAULT_OLLAMA_URL)) {
    detected.EMBED_PROVIDER = 'ollama';
  }

  return detected;
}

module.exports = {
  autodetectForQuickstart,
  probePostgres,
  probeOllama,
  DEFAULT_PG_URL,
  DEFAULT_OLLAMA_URL,
};
