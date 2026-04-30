'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { createMemoryRecords } = require('../core/memory-records');
const { createMemoryPromotion } = require('../core/memory-promotion');
const { requireTestDb } = require('./helpers/require-test-db');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '015-v1-evidence-items.sql'),
  'utf8',
);
const MULTI_ITEM_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '016-v1-evidence-ref-multi-item.sql'),
  'utf8',
);
const MEMORY_EMBEDDING_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'schema', '017-v1-memory-record-embeddings.sql'),
  'utf8',
);
const MIGRATIONS = fs.readFileSync(
  path.join(__dirname, '..', 'core', 'postgres-migrations.js'),
  'utf8',
);
const DB_URL = requireTestDb('v1 evidence item DB-backed tests');

describe('v1 evidence item plane', () => {
  it('adds retrieval-grade evidence items without making HNSW a migration gate', () => {
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.evidence_items/);
    assert.match(SQL, /excerpt_text\s+TEXT\s+NOT NULL/);
    assert.match(SQL, /search_tsv\s+TSVECTOR/);
    assert.match(SQL, /ALTER TABLE \$\{schema\}\.evidence_refs[\s\S]*ADD COLUMN IF NOT EXISTS evidence_item_id BIGINT/);
    assert.match(SQL, /idx_evidence_items_search_tsv/);
    assert.match(SQL, /idx_evidence_items_excerpt_trgm/);
    assert.doesNotMatch(SQL, /\bUSING hnsw\b/i);
    assert.match(MIGRATIONS, /015-v1-evidence-items/);
    assert.match(MULTI_ITEM_SQL, /DROP INDEX IF EXISTS \$\{schema\}\.idx_evidence_refs_dedupe/);
    assert.match(MULTI_ITEM_SQL, /idx_evidence_refs_evidence_item_dedupe/);
    assert.match(MIGRATIONS, /016-v1-evidence-ref-multi-item/);
    assert.match(MEMORY_EMBEDDING_SQL, /ALTER TABLE \$\{schema\}\.memory_records[\s\S]*ADD COLUMN IF NOT EXISTS embedding vector\(1024\)/);
    assert.match(MEMORY_EMBEDDING_SQL, /idx_memory_records_embedding_hnsw/);
    assert.match(MIGRATIONS, /017-v1-memory-record-embeddings/);
  });

  it('can upsert evidence items and link them to memory records', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params: params || [] });
        if (String(sql).includes('INSERT INTO "aq".evidence_items')) {
          return { rows: [{ id: 77, excerpt_text: params[7] }], rowCount: 1 };
        }
        if (String(sql).includes('INSERT INTO "aq".evidence_refs')) {
          return { rows: [{ id: 88, evidence_item_id: params[10] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const records = createMemoryRecords({ pool, schema: '"aq"', defaultTenantId: 'default' });

    const item = await records.upsertEvidenceItem({
      sourceKind: 'session_summary',
      sourceRef: 'session-1',
      excerptText: '使用者問上一輪完成了什麼',
      createdByFinalizationId: 9,
    });
    const ref = await records.linkEvidence({
      ownerKind: 'memory_record',
      ownerId: 12,
      sourceKind: 'session_summary',
      sourceRef: 'session-1',
      relationKind: 'primary',
      evidenceItemId: item.id,
    });

    assert.equal(ref.evidence_item_id, 77);
    assert.match(queries[0].sql, /excerpt_hash/);
    assert.match(queries[1].sql, /evidence_item_id/);
    assert.match(queries[1].sql, /ON CONFLICT \(tenant_id, owner_kind, owner_id, evidence_item_id, relation_kind\)/);
    assert.match(queries[1].sql, /WHERE evidence_item_id IS NOT NULL/);
  });

  it('keeps legacy evidence refs deduped by source when no evidence item is linked', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params: params || [] });
        return { rows: [{ id: 88, evidence_item_id: params[10] }], rowCount: 1 };
      },
    };
    const records = createMemoryRecords({ pool, schema: '"aq"', defaultTenantId: 'default' });

    await records.linkEvidence({
      ownerKind: 'memory_record',
      ownerId: 12,
      sourceKind: 'session_summary',
      sourceRef: 'session-1',
      relationKind: 'primary',
    });

    assert.match(queries[0].sql, /ON CONFLICT \(tenant_id, owner_kind, owner_id, source_kind, source_ref, relation_kind\)/);
    assert.match(queries[0].sql, /WHERE evidence_item_id IS NULL/);
  });

  it('promotion writes per-memory evidence items when candidates include evidence text', async () => {
    const calls = [];
    const embedCalls = [];
    const records = {
      async upsertScope() { return { id: 3 }; },
      async findActiveByCanonicalKey() { return []; },
      async upsertMemory() { return { id: 12 }; },
      async upsertEvidenceItem(input) {
        calls.push({ kind: 'item', input });
        return { id: 77 };
      },
      async linkEvidence(input) {
        calls.push({ kind: 'ref', input });
        return { id: 88 };
      },
    };
    const promotion = createMemoryPromotion({
      records,
      embedFn: async texts => {
        embedCalls.push(texts);
        if (texts[0] && texts[0].startsWith('summary:')) return [[0.91, 0.09]];
        return [[0.25, 0.75]];
      },
    });

    const result = await promotion.promote([{
      memoryType: 'decision',
      canonicalKey: 'decision:project:aquifer:evidence-items',
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      summary: 'Current memory is concise.',
      authority: 'verified_summary',
      evidenceText: 'MK asked what the previous round completed.',
      evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 'session-1', relationKind: 'primary' }],
    }], { tenantId: 'default', createdByFinalizationId: 9 });

    assert.equal(result[0].action, 'promote');
    assert.deepEqual(embedCalls, [
      ['summary: Current memory is concise.'],
      ['MK asked what the previous round completed.'],
    ]);
    assert.equal(calls.find(call => call.kind === 'item').input.excerptText, 'MK asked what the previous round completed.');
    assert.deepEqual(calls.find(call => call.kind === 'item').input.embedding, [0.25, 0.75]);
    assert.equal(calls.find(call => call.kind === 'ref').input.evidenceItemId, 77);
  });

  it('promotion does not synthesize evidence items from distilled memory text', async () => {
    const calls = [];
    const records = {
      async upsertScope() { return { id: 3 }; },
      async findActiveByCanonicalKey() { return []; },
      async upsertMemory() { return { id: 12 }; },
      async upsertEvidenceItem() {
        throw new Error('distilled summary must not be promoted as evidence text');
      },
      async linkEvidence(input) {
        calls.push(input);
        return { id: 88 };
      },
    };
    const promotion = createMemoryPromotion({ records });

    const result = await promotion.promote([{
      memoryType: 'decision',
      canonicalKey: 'decision:project:aquifer:no-fake-evidence',
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      summary: 'Current memory is concise.',
      authority: 'verified_summary',
      evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 'session-1', relationKind: 'primary' }],
    }], { tenantId: 'default', createdByFinalizationId: 9 });

    assert.equal(result[0].action, 'promote');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].evidenceItemId, undefined);
  });

  it('curated recall does not use evidence items as default current-memory corpus', async () => {
    const queries = [];
    const memoryRow = {
      id: 42,
      memory_type: 'decision',
      canonical_key: 'decision:project:aquifer:query-contract',
      scope_key: 'project:aquifer',
      scope_kind: 'project',
      scope_inheritance_mode: 'defaultable',
      status: 'active',
      visible_in_recall: true,
      title: 'Hybrid query contract',
      summary: 'Current memory stays distilled.',
      accepted_at: '2026-04-30T00:00:00Z',
      evidence_score: 1.2,
      recall_score: 1.7,
    };
    const pool = {
      async query(sql, params) {
        const text = String(sql);
        queries.push({ sql: text, params: params || [] });
        if (text.includes('"aq".evidence_items')) return { rows: [memoryRow], rowCount: 1 };
        if (text.includes('FROM "aq".memory_records')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
      },
      async end() {},
    };
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated', activeScopePath: ['global', 'project:aquifer'] },
    });

    const rows = await aq.recall('what did the previous round complete', { limit: 3 });

    assert.equal(queries.some(query => query.sql.includes('evidence_items')), false);
    assert.equal(queries.some(query => query.sql.includes('session_summaries')), false);
    assert.equal(queries.some(query => query.sql.includes('turn_embeddings')), false);
    assert.deepEqual(rows, []);
  });
});

if (DB_URL) {
  describe('v1 evidence items DB-backed recall', () => {
    const schema = `evidence_items_${Date.now()}`;
    let aq;
    let pool;

    after(async () => {
      await aq?.close?.().catch(() => {});
      await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool?.end?.().catch(() => {});
    });

    it('does not serve current memory through a per-memory evidence item when memory text does not contain the query', async () => {
      pool = new Pool({ connectionString: DB_URL });
      aq = createAquifer({
        db: DB_URL,
        schema,
        tenantId: 'test',
        memory: {
          servingMode: 'curated',
          activeScopeKey: 'project:aquifer',
          activeScopePath: ['global', 'project:aquifer'],
        },
      });
      await aq.init();
      const scope = await aq.memory.upsertScope({
        tenantId: 'test',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
      });
      await aq.memory.promote([{
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:evidence-item-db',
        scopeId: scope.id,
        title: 'Evidence item recall contract',
        summary: 'Current memory is intentionally distilled and omits the user phrasing.',
        authority: 'verified_summary',
        evidenceText: 'The user asked what the previous round completed before the memory backend cutover.',
        evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 'session-db-evidence', relationKind: 'primary' }],
      }], { tenantId: 'test' });

      const rows = await aq.recall('previous round completed', {
        activeScopeKey: 'project:aquifer',
        activeScopePath: ['global', 'project:aquifer'],
        limit: 5,
      });
      const evidenceCount = await pool.query(
        `SELECT count(*)::int AS count FROM "${schema}".evidence_items WHERE tenant_id = 'test'`,
      );

      assert.equal(evidenceCount.rows[0].count, 1);
      assert.deepEqual(rows, []);
    });

  });
}
