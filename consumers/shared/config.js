'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  db: { url: null, max: 10, idleTimeoutMs: 30000 },
  schema: 'aquifer',
  tenantId: 'default',
  defaults: { agentId: null, source: 'api' },
  embed: {
    baseUrl: null,
    model: null,
    apiKey: null,
    dim: null,
    timeoutMs: 120000,
    maxRetries: 3,
    chunkSize: 32,
  },
  llm: {
    baseUrl: null,
    model: null,
    apiKey: null,
    timeoutMs: 60000,
    maxRetries: 3,
    temperature: 0,
  },
  entities: { enabled: false, mergeCall: true, scope: 'default' },
  rank: { rrf: 0.65, timeDecay: 0.25, access: 0.10, entityBoost: 0.18 },
  rerank: {
    enabled: false,
    provider: null,    // 'tei' | 'jina' | 'custom'
    baseUrl: null,     // TEI base URL
    apiKey: null,      // Jina API key
    model: null,       // Jina model override
    topK: 20,
    maxChars: 1600,
    timeoutMs: 2000,
    maxRetries: 1,
  },
};

// ---------------------------------------------------------------------------
// Env var mapping: ENV_NAME → config path
// ---------------------------------------------------------------------------

const ENV_MAP = [
  ['DATABASE_URL',              'db.url'],
  ['AQUIFER_DB_URL',            'db.url'],
  ['AQUIFER_DB_MAX',            'db.max',            Number],
  ['AQUIFER_SCHEMA',            'schema'],
  ['AQUIFER_TENANT_ID',         'tenantId'],
  ['AQUIFER_AGENT_ID',          'defaults.agentId'],
  ['AQUIFER_SOURCE',            'defaults.source'],
  ['AQUIFER_EMBED_BASE_URL',    'embed.baseUrl'],
  ['AQUIFER_EMBED_MODEL',       'embed.model'],
  ['AQUIFER_EMBED_API_KEY',     'embed.apiKey'],
  ['AQUIFER_EMBED_DIM',         'embed.dim',         Number],
  ['AQUIFER_EMBED_TIMEOUT_MS',  'embed.timeoutMs',   Number],
  ['AQUIFER_EMBED_CHUNK_SIZE',  'embed.chunkSize',   Number],
  ['AQUIFER_LLM_BASE_URL',      'llm.baseUrl'],
  ['AQUIFER_LLM_MODEL',         'llm.model'],
  ['AQUIFER_LLM_API_KEY',       'llm.apiKey'],
  ['AQUIFER_LLM_TIMEOUT_MS',    'llm.timeoutMs',     Number],
  ['AQUIFER_LLM_TEMPERATURE',   'llm.temperature',   Number],
  ['AQUIFER_ENTITIES_ENABLED',  'entities.enabled',  Boolean],
  ['AQUIFER_ENTITY_SCOPE',     'entities.scope'],
  ['AQUIFER_RERANK_ENABLED',   'rerank.enabled',    Boolean],
  ['AQUIFER_RERANK_PROVIDER',  'rerank.provider'],
  ['AQUIFER_RERANK_BASE_URL',  'rerank.baseUrl'],
  ['AQUIFER_RERANK_API_KEY',   'rerank.apiKey'],
  ['AQUIFER_RERANK_MODEL',     'rerank.model'],
  ['AQUIFER_RERANK_TOP_K',     'rerank.topK',       Number],
  ['AQUIFER_RERANK_MAX_CHARS', 'rerank.maxChars',   Number],
  ['AQUIFER_RERANK_TIMEOUT_MS','rerank.timeoutMs',   Number],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined && source[key] !== null
        && typeof source[key] === 'object' && !Array.isArray(source[key])
        && typeof result[key] === 'object' && result[key] !== null) {
      result[key] = deepMerge(result[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

function setPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function coerceEnvValue(raw, type) {
  if (type === Number) return Number(raw);
  if (type === Boolean) return raw === 'true' || raw === '1' || raw === 'yes';
  return raw;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

function loadConfig(opts = {}) {
  const env = opts.env || process.env;
  let config = JSON.parse(JSON.stringify(DEFAULTS));

  // 1. Config file
  const configPath = opts.configPath || env.AQUIFER_CONFIG || null;
  const candidates = configPath
    ? [configPath]
    : [
        path.join(opts.cwd || process.cwd(), 'aquifer.config.json'),
        path.join(opts.cwd || process.cwd(), 'aquifer.config.js'),
      ];

  for (const candidate of candidates) {
    try {
      if (candidate.endsWith('.json')) {
        const raw = fs.readFileSync(candidate, 'utf8');
        config = deepMerge(config, JSON.parse(raw));
      } else if (candidate.endsWith('.js') || candidate.endsWith('.cjs')) {
        config = deepMerge(config, require(candidate));
      }
      break;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }

  // 2. Environment variables
  for (const [envName, configPath, type] of ENV_MAP) {
    const val = env[envName];
    if (val !== undefined && val !== '') {
      setPath(config, configPath, type ? coerceEnvValue(val, type) : val);
    }
  }

  // 3. Programmatic overrides
  if (opts.overrides) {
    config = deepMerge(config, opts.overrides);
  }

  return config;
}

module.exports = { loadConfig, DEFAULTS };
