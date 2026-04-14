'use strict';

const { Pool } = require('pg');
const { createAquifer, createEmbedder, createReranker } = require('../../index');
const { loadConfig } = require('./config');
const { createLlmFn } = require('./llm');

// ---------------------------------------------------------------------------
// createAquiferFromConfig
// ---------------------------------------------------------------------------

function createAquiferFromConfig(overrides) {
  const config = loadConfig({ overrides });

  if (!config.db.url) {
    throw new Error('Database URL is required (set DATABASE_URL or AQUIFER_DB_URL)');
  }

  // Pool
  const pool = new Pool({
    connectionString: config.db.url,
    max: config.db.max || 10,
    idleTimeoutMillis: config.db.idleTimeoutMs || 30000,
  });

  // Embed function (optional — lazy validation in core)
  let embedFn = null;
  if (config.embed && config.embed.baseUrl && config.embed.model) {
    // Detect provider from baseUrl
    const isOllama = config.embed.baseUrl.includes('11434') || config.embed.baseUrl.includes('ollama');
    const embedder = isOllama
      ? createEmbedder({
          provider: 'ollama',
          ollamaUrl: config.embed.baseUrl.replace(/\/v1\/?$/, ''),
          model: config.embed.model,
          chunkSize: config.embed.chunkSize || 32,
          timeout: config.embed.timeoutMs || 120000,
          maxRetries: config.embed.maxRetries || 3,
          initialBackoffMs: 2000,
        })
      : createEmbedder({
          provider: 'openai',
          openaiApiKey: config.embed.apiKey || '',
          openaiModel: config.embed.model,
          openaiDimensions: config.embed.dim || undefined,
          chunkSize: config.embed.chunkSize || 100,
          timeout: config.embed.timeoutMs || 120000,
          maxRetries: config.embed.maxRetries || 3,
          initialBackoffMs: 2000,
        });
    embedFn = (texts) => embedder.embedBatch(texts);
  }

  // LLM function (optional)
  let llmFn = null;
  if (config.llm && config.llm.baseUrl && config.llm.model) {
    llmFn = createLlmFn(config.llm);
  }

  // Rerank config (optional)
  let rerankOpts = null;
  if (config.rerank && config.rerank.enabled && config.rerank.provider) {
    const rc = config.rerank;
    const rerankConfig = { provider: rc.provider, topK: rc.topK, maxChars: rc.maxChars };
    if (rc.provider === 'tei') {
      rerankConfig.teiBaseUrl = rc.baseUrl || 'http://localhost:8080';
      rerankConfig.timeout = rc.timeoutMs || 2000;
      rerankConfig.maxRetries = rc.maxRetries ?? 1;
    } else if (rc.provider === 'jina') {
      rerankConfig.jinaApiKey = rc.apiKey;
      if (rc.model) rerankConfig.jinaModel = rc.model;
      rerankConfig.timeout = rc.timeoutMs || 2000;
      rerankConfig.maxRetries = rc.maxRetries ?? 1;
    }
    rerankOpts = rerankConfig;
  }

  const aquifer = createAquifer({
    db: pool,
    schema: config.schema,
    tenantId: config.tenantId,
    embed: embedFn ? { fn: embedFn, dim: config.embed.dim || null } : null,
    llm: llmFn ? { fn: llmFn } : null,
    entities: config.entities,
    rank: config.rank,
    rerank: rerankOpts,
  });

  // Attach pool for lifecycle management
  aquifer._pool = pool;
  aquifer._config = config;

  return aquifer;
}

module.exports = { createAquiferFromConfig };
