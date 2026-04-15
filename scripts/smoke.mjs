#!/usr/bin/env node

/**
 * Aquifer smoke test — validates the full write → enrich → recall cycle.
 *
 * Prerequisites:
 *   - DATABASE_URL set to a PostgreSQL database with pgvector
 *   - AQUIFER_EMBED_BASE_URL + AQUIFER_EMBED_MODEL set (e.g., Ollama bge-m3)
 *
 * Usage:
 *   node scripts/smoke.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { createAquifer, createEmbedder } = require('../index.js');
const { loadConfig } = require('../consumers/shared/config.js');

const config = loadConfig();

if (!config.db.url) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

if (!config.embed.baseUrl || !config.embed.model) {
  console.error('ERROR: AQUIFER_EMBED_BASE_URL and AQUIFER_EMBED_MODEL must be set.');
  process.exit(1);
}

// Build embedder
const isOllama = config.embed.baseUrl.includes('11434') || config.embed.baseUrl.includes('ollama');
const embedder = isOllama
  ? createEmbedder({
      provider: 'ollama',
      ollamaUrl: config.embed.baseUrl.replace(/\/v1\/?$/, ''),
      model: config.embed.model,
    })
  : createEmbedder({
      provider: 'openai',
      openaiApiKey: config.embed.apiKey || '',
      openaiModel: config.embed.model,
    });

const aquifer = createAquifer({
  db: config.db.url,
  schema: config.schema || 'aquifer',
  tenantId: config.tenantId || 'default',
  embed: { fn: (texts) => embedder.embedBatch(texts), dim: config.embed.dim || null },
  entities: { enabled: false },
});

const SESSION_ID = `smoke-test-${Date.now()}`;

try {
  // 1. Migrate
  console.log('1. Running migrations...');
  await aquifer.migrate();
  console.log('   OK');

  // 2. Commit a test session
  console.log('2. Committing test session...');
  const commitResult = await aquifer.commit(SESSION_ID, [
    { role: 'user', content: 'We decided to use PostgreSQL with pgvector for the AI memory store instead of a separate vector database.' },
    { role: 'assistant', content: 'Good choice. PG gives us ACID transactions, full-text search, and vector similarity all in one place.' },
    { role: 'user', content: 'The main advantage is turn-level embedding — we can find the exact moment a decision was made.' },
  ], { agentId: 'smoke-test', source: 'smoke' });
  console.log(`   OK — session ${commitResult.isNew ? 'created' : 'updated'}`);

  // 3. Enrich (skip summary since LLM may not be configured)
  console.log('3. Enriching (turn embeddings, skip summary)...');
  const enrichResult = await aquifer.enrich(SESSION_ID, {
    agentId: 'smoke-test',
    skipSummary: true,
    skipEntities: true,
  });
  console.log(`   OK — ${enrichResult.turnsEmbedded} turns embedded`);

  // 4. Recall
  console.log('4. Recalling "PostgreSQL memory store"...');
  const results = await aquifer.recall('PostgreSQL memory store', { limit: 3 });
  if (results.length === 0) {
    console.error('   FAIL — no results returned');
    process.exit(1);
  }
  console.log(`   OK — ${results.length} result(s), top score: ${results[0].score?.toFixed(3)}`);
  if (results[0].matchedTurnText) {
    console.log(`   Matched turn: "${results[0].matchedTurnText.slice(0, 100)}..."`);
  }

  // 5. Stats
  console.log('5. Checking stats...');
  const stats = await aquifer.getStats();
  console.log(`   Sessions: ${stats.sessionTotal}, Turn embeddings: ${stats.turnEmbeddings}`);

  // 6. Cleanup — remove smoke test session
  console.log('6. Cleaning up...');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: config.db.url });
  const schema = config.schema || 'aquifer';
  await pool.query(`DELETE FROM ${schema}.turn_embeddings WHERE session_id IN (SELECT id FROM ${schema}.sessions WHERE session_id = $1)`, [SESSION_ID]);
  await pool.query(`DELETE FROM ${schema}.session_summaries WHERE session_id IN (SELECT id FROM ${schema}.sessions WHERE session_id = $1)`, [SESSION_ID]);
  await pool.query(`DELETE FROM ${schema}.sessions WHERE session_id = $1`, [SESSION_ID]);
  await pool.end();
  console.log('   OK');

  console.log('\n✓ smoke test passed');
} catch (err) {
  console.error(`\n✗ smoke test failed: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
} finally {
  await aquifer.close();
}
