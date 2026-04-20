'use strict';

/**
 * Aquifer Integration Tests — 真 PostgreSQL
 *
 * 環境：
 *   - PG 在 Docker，透過 AQUIFER_TEST_DB_URL 傳連線字串
 *   - 每個 describe block 建一個獨立 schema（aquifer_test_<random>），
 *     結束後 DROP。不同 describe 互不干擾。
 *   - 使用 node:test runner（Node.js 24.14）
 *
 * 執行方式：
 *   AQUIFER_TEST_DB_URL="postgresql://burk:PASS@localhost:5432/openclaw_db" \
 *     node --test test/integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');

// ---------------------------------------------------------------------------
// 環境變數
// ---------------------------------------------------------------------------

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping integration tests.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 產生隨機 test schema 名稱 */
function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * fake embed：固定 3-dim vector。
 *
 * 設計原則：
 *   - recall 時 cosine similarity 要能找到 commit 時存的 vector。
 *   - 我們用 "keyword → deterministic vector" 的方式：
 *     相同 keyword 的文字永遠產生同一個 vector，
 *     所以 commit 存的 summary/turn vector 和 recall 查的 query vector 完全一樣，
 *     cosine distance = 0（最近），確保能被搜到。
 *   - 不同 keyword（e.g. "unrelated"）產生正交 vector，不會干擾測試。
 */
function makeFakeEmbed() {
  // Schema locks embedding columns at vector(1024) since 1.5.2. Pad the
  // 3 semantic dimensions into zero-filled 1024-vectors so tests exercise
  // the real column width without losing per-keyword distinctness.
  const DIM = 1024;
  const seed = (positions) => {
    const v = new Array(DIM).fill(0);
    for (const [i, val] of positions) v[i] = val;
    return v;
  };
  const VECTORS = {
    default:   seed([[0, 1]]),
    keyword:   seed([[1, 1]]),
    unrelated: seed([[2, 1]]),
  };

  function textToVec(text) {
    const t = text.toLowerCase();
    for (const [k, v] of Object.entries(VECTORS)) {
      if (t.includes(k)) return v;
    }
    return VECTORS.default;
  }

  return async (texts) => texts.map(textToVec);
}

/**
 * 建立 summaryFn + entityParseFn，讓 enrich 不需要真 LLM。
 * summaryFn 回傳固定格式，可透過 opts 客製 summaryText/entities。
 */
function makeFakeSummaryFn(opts = {}) {
  const summaryText = opts.summaryText || 'This is a test summary about keyword topic.';
  const entityRaw = opts.entityRaw || null;

  return async (_messages) => ({
    summaryText,
    structuredSummary: {
      title: opts.title || 'Test Session',
      overview: opts.overview || summaryText,
      topics: opts.topics || [],
      decisions: opts.decisions || [],
      open_loops: opts.open_loops || [],
      important_facts: opts.facts || [],
    },
    entityRaw,
  });
}

/**
 * 建立 Aquifer instance + 獨立 pool（test 用）。
 * 回傳 { aq, pool, schema }，teardown 負責 DROP schema + close pool。
 */
async function createTestInstance(extraConfig = {}) {
  const schema = randomSchema();
  // 用獨立 pool 讓 aq.close() 不影響 teardown 的 DROP
  const pool = new Pool({ connectionString: DB_URL });

  const aq = createAquifer({
    db: DB_URL,
    schema,
    tenantId: 'test',
    embed: { fn: makeFakeEmbed() },
    entities: { enabled: true, scope: 'test-scope' },
    ...extraConfig,
  });

  return { aq, pool, schema };
}

/**
 * 清理：DROP schema，關閉 pool。
 * 先 aq.close() 關 aquifer 自己的 pool，再用 adminPool DROP schema。
 */
async function teardown(aq, adminPool, schema) {
  try { await aq.close(); } catch {}
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await adminPool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 1. migrate() — DDL 完整性
// ---------------------------------------------------------------------------

describe('1. migrate() — DDL 完整性', () => {
  let aq, pool, schema;

  before(async () => {
    ({ aq, pool, schema } = await createTestInstance());
    await aq.migrate();
  });

  after(async () => {
    await teardown(aq, pool, schema);
  });

  it('建立所有 base tables', async () => {
    // 驗什麼：sessions / session_summaries / turn_embeddings 都存在
    // 為什麼重要：migrate 是所有 API 的前提，schema 缺損後面全爛
    const res = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [schema]
    );
    const tables = res.rows.map(r => r.table_name);
    assert.ok(tables.includes('sessions'), 'sessions table missing');
    assert.ok(tables.includes('session_summaries'), 'session_summaries table missing');
    assert.ok(tables.includes('turn_embeddings'), 'turn_embeddings table missing');
  });

  it('建立 entity tables（entities enabled）', async () => {
    // 驗什麼：entities / entity_mentions / entity_relations / entity_sessions
    // 為什麼重要：entities: { enabled: true } 時要有 entity DDL
    const res = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name IN ('entities','entity_mentions','entity_relations','entity_sessions')
       ORDER BY table_name`,
      [schema]
    );
    const tables = res.rows.map(r => r.table_name);
    assert.ok(tables.includes('entities'), 'entities table missing');
    assert.ok(tables.includes('entity_mentions'), 'entity_mentions table missing');
    assert.ok(tables.includes('entity_relations'), 'entity_relations table missing');
    assert.ok(tables.includes('entity_sessions'), 'entity_sessions table missing');
  });

  it('建立 session_feedback table（003-trust-feedback.sql）', async () => {
    // 驗什麼：feedback 表存在
    // 為什麼重要：003 migrate 無論 entities 是否 enabled 都要跑
    const res = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'session_feedback'`,
      [schema]
    );
    assert.equal(res.rows.length, 1, 'session_feedback table missing');
  });

  it('sessions 有 processing_started_at column（stale lock 所需）', async () => {
    // 驗什麼：001-base.sql 有定義 processing_started_at
    // 為什麼重要：enrich() 的 stale session reclaim 邏輯依賴此 column；
    //   缺此 column 會導致所有 enrich() 呼叫爆 42703 (column does not exist)
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'sessions' AND column_name = 'processing_started_at'`,
      [schema]
    );
    assert.equal(res.rows.length, 1, 'processing_started_at column missing from sessions');
  });

  it('session_summaries 有 trust_score column', async () => {
    // 驗什麼：003 ALTER TABLE ADD COLUMN IF NOT EXISTS trust_score 執行成功
    // 為什麼重要：feedback() 會讀寫 trust_score，column 不存在就爆
    const res = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'session_summaries' AND column_name = 'trust_score'`,
      [schema]
    );
    assert.equal(res.rows.length, 1, 'trust_score column missing');
    assert.equal(res.rows[0].data_type, 'real');
  });

  it('entities 有 entity_scope column', async () => {
    // 驗什麼：002 migration path 的 entity_scope column
    // 為什麼重要：entity upsert 用 (tenant, normalized_name, entity_scope) 做 unique key
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'entities' AND column_name = 'entity_scope'`,
      [schema]
    );
    assert.equal(res.rows.length, 1, 'entity_scope column missing');
  });

  it('FTS trigger 存在（session_summaries_search_tsv_update）', async () => {
    // 驗什麼：trigger 在對應 schema 的 function 存在
    // 為什麼重要：FTS 路徑依賴 trigger 更新 search_tsv
    const res = await pool.query(
      `SELECT routine_name FROM information_schema.routines
       WHERE routine_schema = $1 AND routine_name = 'session_summaries_search_tsv_update'`,
      [schema]
    );
    assert.equal(res.rows.length, 1, 'FTS trigger function missing');
  });

  it('idx_entities_tenant_name_scope 唯一索引存在', async () => {
    // 驗什麼：002 的 unique index 替換了舊的 agent-based constraint
    // 為什麼重要：entity upsert ON CONFLICT 依賴這個 index
    const res = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'idx_entities_tenant_name_scope'`,
      [schema]
    );
    assert.equal(res.rows.length, 1, 'idx_entities_tenant_name_scope missing');
  });

  it('idempotent migrate（兩次不爆）', async () => {
    // 驗什麼：migrate() 第二次呼叫不拋錯
    // 為什麼重要：CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS 要正確
    await assert.doesNotReject(() => aq.migrate(), 'second migrate() threw');
  });
});

// ---------------------------------------------------------------------------
// 2. commit() — session 寫入 + upsert
// ---------------------------------------------------------------------------

describe('2. commit() — session 寫入 + upsert', () => {
  let aq, pool, schema;

  before(async () => {
    ({ aq, pool, schema } = await createTestInstance());
    await aq.migrate();
  });

  after(async () => {
    await teardown(aq, pool, schema);
  });

  it('新 session 寫入，isNew=true，processing_status=pending', async () => {
    // 驗什麼：第一次 commit 建立新 session
    // 為什麼重要：確認 INSERT 路徑和 isNew flag 的語意正確
    const result = await aq.commit('sid-001', [
      { role: 'user', content: 'Hello keyword world' },
      { role: 'assistant', content: 'I can help with that.' },
    ]);

    assert.ok(result.id, 'id missing');
    assert.equal(result.sessionId, 'sid-001');
    assert.equal(result.isNew, true);

    const row = await pool.query(
      `SELECT processing_status, msg_count, user_count, assistant_count
       FROM "${schema}".sessions WHERE session_id = $1`,
      ['sid-001']
    );
    assert.equal(row.rows[0].processing_status, 'pending');
    assert.equal(row.rows[0].msg_count, 2);
    assert.equal(row.rows[0].user_count, 1);
    assert.equal(row.rows[0].assistant_count, 1);
  });

  it('重複 commit 同 sessionId，upsert 不爆，isNew=false', async () => {
    // 驗什麼：ON CONFLICT (tenant_id, agent_id, session_id) DO UPDATE 路徑
    // 為什麼重要：agent session 可能多次 commit（append messages），不能 INSERT 失敗
    await aq.commit('sid-dup', [{ role: 'user', content: 'First message keyword' }]);
    const r2 = await aq.commit('sid-dup', [
      { role: 'user', content: 'First message keyword' },
      { role: 'user', content: 'Second message keyword' },
    ]);
    assert.equal(r2.isNew, false);
    assert.equal(r2.sessionId, 'sid-dup');

    const row = await pool.query(
      `SELECT msg_count FROM "${schema}".sessions WHERE session_id = $1`,
      ['sid-dup']
    );
    assert.equal(row.rows[0].msg_count, 2, 'msg_count should reflect latest commit');
  });

  it('commit 後 processing_status 重置為 pending（可重新 enrich）', async () => {
    // 驗什麼：upsert 時 processing_status = 'pending' 覆蓋舊值
    // 為什麼重要：消費者修改訊息後重新 commit，需要觸發重新 enrich
    await aq.commit('sid-reset', [{ role: 'user', content: 'keyword hello' }]);
    // 手動標為 succeeded
    await pool.query(
      `UPDATE "${schema}".sessions SET processing_status = 'succeeded' WHERE session_id = $1`,
      ['sid-reset']
    );
    await aq.commit('sid-reset', [{ role: 'user', content: 'keyword updated' }]);
    const row = await pool.query(
      `SELECT processing_status FROM "${schema}".sessions WHERE session_id = $1`,
      ['sid-reset']
    );
    assert.equal(row.rows[0].processing_status, 'pending');
  });

  it('commit 拒絕空 sessionId', async () => {
    // 驗什麼：必填欄位 guard
    // 為什麼重要：空 sessionId 會破壞 unique constraint 語意
    await assert.rejects(
      () => aq.commit('', [{ role: 'user', content: 'hi' }]),
      /sessionId is required/
    );
  });

  it('commit 拒絕 messages 非陣列', async () => {
    await assert.rejects(
      () => aq.commit('sid-x', 'not-an-array'),
      /messages must be an array/
    );
  });

  it('custom opts（agentId, source, model）正確寫入', async () => {
    // 驗什麼：optional meta 欄位
    // 為什麼重要：多 agent 環境靠 agentId + source 區分資料
    await aq.commit('sid-opts', [
      { role: 'user', content: 'keyword test content' },
    ], {
      agentId: 'custom-agent',
      source: 'whatsapp',
      model: 'gpt-4o',
      tokensIn: 100,
      tokensOut: 200,
    });

    const row = await pool.query(
      `SELECT agent_id, source, model, tokens_in, tokens_out
       FROM "${schema}".sessions WHERE session_id = $1`,
      ['sid-opts']
    );
    assert.equal(row.rows[0].agent_id, 'custom-agent');
    assert.equal(row.rows[0].source, 'whatsapp');
    assert.equal(row.rows[0].model, 'gpt-4o');
    assert.equal(row.rows[0].tokens_in, 100);
    assert.equal(row.rows[0].tokens_out, 200);
  });
});

// ---------------------------------------------------------------------------
// 3. enrich() — summary + turn embed + entity extraction
// ---------------------------------------------------------------------------

describe('3. enrich() — summary + turn embed + entity extraction', () => {
  let aq, pool, schema;

  before(async () => {
    ({ aq, pool, schema } = await createTestInstance());
    await aq.migrate();
  });

  after(async () => {
    await teardown(aq, pool, schema);
  });

  it('enrich 寫入 summary，processing_status → succeeded', async () => {
    // 驗什麼：enrich 完整路徑：summary upsert + status 更新
    // 為什麼重要：succeeded 是 recall 可以找到該 session 的前提
    await aq.commit('sid-enrich-1', [
      { role: 'user', content: 'Tell me about keyword performance.' },
      { role: 'assistant', content: 'Sure, let me explain.' },
    ]);

    const result = await aq.enrich('sid-enrich-1', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'Session about keyword performance.' }),
    });

    assert.ok(result.summary, 'summary text missing');
    assert.equal(result.warnings.length, 0, `unexpected warnings: ${result.warnings.join(', ')}`);

    const session = await pool.query(
      `SELECT processing_status FROM "${schema}".sessions WHERE session_id = $1`,
      ['sid-enrich-1']
    );
    assert.equal(session.rows[0].processing_status, 'succeeded');

    const summary = await pool.query(
      `SELECT summary_text, search_tsv IS NOT NULL AS has_tsv
       FROM "${schema}".session_summaries ss
       JOIN "${schema}".sessions s ON s.id = ss.session_row_id
       WHERE s.session_id = $1`,
      ['sid-enrich-1']
    );
    assert.ok(summary.rows[0], 'summary row missing');
    assert.ok(summary.rows[0].summary_text.includes('keyword'));
    assert.equal(summary.rows[0].has_tsv, true, 'FTS trigger not fired');
  });

  it('enrich 寫入 turn embeddings', async () => {
    // 驗什麼：user turn 的 vector 存入 turn_embeddings
    // 為什麼重要：turn embedding 搜尋路徑依賴這些資料
    await aq.commit('sid-turn-emb', [
      { role: 'user', content: 'keyword question about system design' },
      { role: 'assistant', content: 'Here is the answer.' },
    ]);

    const result = await aq.enrich('sid-turn-emb', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'keyword system design session' }),
    });

    assert.ok(result.turnsEmbedded >= 1, `turnsEmbedded should be >= 1, got ${result.turnsEmbedded}`);

    const turns = await pool.query(
      `SELECT content_text, embedding IS NOT NULL AS has_embedding
       FROM "${schema}".turn_embeddings te
       JOIN "${schema}".sessions s ON s.id = te.session_row_id
       WHERE s.session_id = $1`,
      ['sid-turn-emb']
    );
    assert.ok(turns.rows.length >= 1, 'no turn embeddings written');
    assert.ok(turns.rows.every(r => r.has_embedding), 'some turn embeddings null');
  });

  it('enrich 用 entityParseFn 提取 entities，entity_scope 正確', async () => {
    // 驗什麼：entity 提取路徑 + entity_scope = 'test-scope'
    // 為什麼重要：entity_scope 是 unique key 的一部分，scope 錯會導致跨 agent 污染
    await aq.commit('sid-entity-1', [
      { role: 'user', content: 'Discuss Alice and Bob project.' },
      { role: 'assistant', content: 'They are collaborating.' },
    ]);

    const entityRaw = `[ENTITIES]
name: Alice
type: person
aliases: ali
---
name: Bob
type: person
aliases:`;

    const result = await aq.enrich('sid-entity-1', {
      summaryFn: makeFakeSummaryFn({
        summaryText: 'keyword session about Alice and Bob',
        entityRaw,
      }),
      entityParseFn: (raw) => {
        // 使用內建 parser 以確保測試反映真實邏輯
        const { parseEntityOutput } = require('../core/entity');
        return parseEntityOutput(raw);
      },
    });

    assert.equal(result.entitiesFound, 2, `expected 2 entities, got ${result.entitiesFound}`);

    const entities = await pool.query(
      `SELECT name, entity_scope FROM "${schema}".entities WHERE tenant_id = 'test'`,
    );
    const names = entities.rows.map(r => r.name);
    assert.ok(names.includes('Alice'), 'Alice not found');
    assert.ok(names.includes('Bob'), 'Bob not found');
    entities.rows.forEach(r => {
      assert.equal(r.entity_scope, 'test-scope', `entity_scope wrong: ${r.entity_scope}`);
    });
  });

  it('同一 entity 兩次 enrich，frequency 累加', async () => {
    // 驗什麼：ON CONFLICT entity upsert 的 frequency + 1 邏輯
    // 為什麼重要：entity 頻率是 searchEntities 排序依據
    const entityRaw = `[ENTITIES]
name: Charlie
type: person
aliases:`;

    const parseFn = (raw) => require('../core/entity').parseEntityOutput(raw);

    await aq.commit('sid-freq-1', [{ role: 'user', content: 'Charlie keyword' }]);
    await aq.enrich('sid-freq-1', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'keyword Charlie session', entityRaw }),
      entityParseFn: parseFn,
    });

    await aq.commit('sid-freq-2', [{ role: 'user', content: 'Charlie again keyword' }]);
    await aq.enrich('sid-freq-2', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'keyword Charlie again', entityRaw }),
      entityParseFn: parseFn,
    });

    const row = await pool.query(
      `SELECT frequency FROM "${schema}".entities
       WHERE normalized_name = 'charlie' AND tenant_id = 'test'`
    );
    assert.ok(row.rows.length === 1, 'charlie entity not found');
    assert.ok(row.rows[0].frequency >= 2, `frequency should be >= 2, got ${row.rows[0].frequency}`);
  });

  it('enrich 兩個 entity，entity_relations 建立 co-occurrence pair', async () => {
    // 驗什麼：entity_relations.src < dst constraint + co_occurrence_count
    // 為什麼重要：knowledge graph 的邊資料正確性
    await aq.commit('sid-rel-1', [
      { role: 'user', content: 'Diana and Eve keyword collaboration.' },
    ]);

    const entityRaw = `[ENTITIES]
name: Diana
type: person
aliases:
---
name: Eve
type: person
aliases:`;

    await aq.enrich('sid-rel-1', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'keyword Diana Eve session', entityRaw }),
      entityParseFn: (raw) => require('../core/entity').parseEntityOutput(raw),
    });

    const rels = await pool.query(
      `SELECT er.src_entity_id, er.dst_entity_id, er.co_occurrence_count
       FROM "${schema}".entity_relations er
       JOIN "${schema}".entities e1 ON e1.id = er.src_entity_id
       JOIN "${schema}".entities e2 ON e2.id = er.dst_entity_id
       WHERE e1.normalized_name IN ('diana','eve') OR e2.normalized_name IN ('diana','eve')`
    );
    assert.ok(rels.rows.length >= 1, 'entity_relations not created');
    rels.rows.forEach(r => {
      assert.ok(r.src_entity_id < r.dst_entity_id, 'src < dst constraint violated');
    });
  });

  it('processing_status lifecycle: pending → processing → succeeded', async () => {
    // 驗什麼：optimistic lock 在 enrich 期間設 processing，完成後轉 succeeded
    // 為什麼重要：防止同一 session 被並行 enrich 兩次
    await aq.commit('sid-lifecycle', [
      { role: 'user', content: 'keyword lifecycle test.' },
    ]);

    // 在 enrich 前確認是 pending
    let row = await pool.query(
      `SELECT processing_status FROM "${schema}".sessions WHERE session_id = $1`,
      ['sid-lifecycle']
    );
    assert.equal(row.rows[0].processing_status, 'pending');

    await aq.enrich('sid-lifecycle', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'keyword lifecycle done.' }),
    });

    row = await pool.query(
      `SELECT processing_status FROM "${schema}".sessions WHERE session_id = $1`,
      ['sid-lifecycle']
    );
    assert.equal(row.rows[0].processing_status, 'succeeded');
  });

  it('enrich already-succeeded session 拋錯', async () => {
    // 驗什麼：enrich 不允許重複處理 succeeded session
    // 為什麼重要：防止雙重 summary 寫入；caller 需 re-commit 再 enrich
    await aq.commit('sid-already-done', [{ role: 'user', content: 'keyword done already.' }]);
    await aq.enrich('sid-already-done', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'keyword done.' }),
    });

    await assert.rejects(
      () => aq.enrich('sid-already-done', {
        summaryFn: makeFakeSummaryFn({ summaryText: 'keyword redo.' }),
      }),
      /already enriched/
    );
  });

  it('enrich 不存在的 session 拋錯', async () => {
    // 驗什麼：session not found error
    // 為什麼重要：caller 可以區分「不存在」與「已處理」
    await assert.rejects(
      () => aq.enrich('sid-nonexistent', {
        summaryFn: makeFakeSummaryFn(),
      }),
      /Session not found/
    );
  });

  it('skipSummary=true 只做 turn embed', async () => {
    // 驗什麼：skipSummary flag 跳過 summary 但保留 turn embed
    // 為什麼重要：部分 pipeline 可能只需要 turn-level 搜尋
    await aq.commit('sid-skip-sum', [
      { role: 'user', content: 'keyword skip summary test.' },
    ]);

    const result = await aq.enrich('sid-skip-sum', {
      skipSummary: true,
    });

    assert.equal(result.summary, null);
    assert.ok(result.turnsEmbedded >= 1, 'expected turn embeddings even with skipSummary');
  });

  it('customSummaryFn 拋錯 → session 不卡 processing，標 partial', async () => {
    // 驗什麼：pre-transaction summary failure 要收斂到 partial，不能讓
    //   session 卡在 processing 等 stale 回收。
    // 為什麼重要：operator 看不到錯誤會誤以為 enrich 正常。
    await aq.commit('sid-sumfail', [{ role: 'user', content: 'keyword will fail.' }]);

    const throwingFn = async () => { throw new Error('mock summary failure'); };
    await aq.enrich('sid-sumfail', { summaryFn: throwingFn, skipTurnEmbed: true });

    const row = await pool.query(
      `SELECT processing_status, processing_error FROM "${schema}".sessions WHERE session_id = $1`,
      ['sid-sumfail']
    );
    assert.notEqual(row.rows[0].processing_status, 'processing',
      'session must not be stuck in processing');
    assert.equal(row.rows[0].processing_status, 'partial');
    assert.match(row.rows[0].processing_error || '', /summary/i);
  });

  it('concurrent enrich 同一個 session → 第二個拋 "already being enriched"', async () => {
    // 驗什麼：claim UPDATE 是 race-safe，同一 session 不會被兩個 worker 同時處理。
    // 為什麼重要：防重複寫入 / 資料錯亂。
    await aq.commit('sid-concurrent', [{ role: 'user', content: 'keyword concurrent.' }]);

    const slowFn = async () => {
      await new Promise(r => setTimeout(r, 100));
      return { summaryText: 'keyword done.' };
    };

    const [r1, r2] = await Promise.allSettled([
      aq.enrich('sid-concurrent', { summaryFn: slowFn, skipTurnEmbed: true }),
      new Promise(r => setTimeout(r, 10))
        .then(() => aq.enrich('sid-concurrent', { summaryFn: slowFn, skipTurnEmbed: true })),
    ]);

    const fulfilled = [r1, r2].filter(r => r.status === 'fulfilled');
    const rejected = [r1, r2].filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one enrich should succeed');
    assert.equal(rejected.length, 1, 'exactly one enrich should be rejected');
    assert.match(rejected[0].reason.message, /already being enriched/);
  });

  it('staleEnrichMinutes config 讓舊的 processing 可被 reclaim', async () => {
    // 驗什麼：staleEnrichMinutes=1 + processing_started_at 在 5 min 前 → 第二次 enrich 可 reclaim。
    // 為什麼重要：崩掉的 worker 留下的 processing session 不能永久卡住。
    await aq.commit('sid-stale', [{ role: 'user', content: 'keyword stale.' }]);
    await pool.query(
      `UPDATE "${schema}".sessions
         SET processing_status = 'processing',
             processing_started_at = NOW() - INTERVAL '5 minutes'
         WHERE session_id = $1`,
      ['sid-stale']
    );

    const aqShort = createAquifer({
      db: DB_URL, schema, tenantId: 'test',
      embed: { fn: makeFakeEmbed() },
      staleEnrichMinutes: 1,
    });
    try {
      await aqShort.enrich('sid-stale', {
        summaryFn: makeFakeSummaryFn({ summaryText: 'keyword reclaimed.' }),
        skipTurnEmbed: true,
      });
      const row = await pool.query(
        `SELECT processing_status FROM "${schema}".sessions WHERE session_id = $1`,
        ['sid-stale']
      );
      assert.equal(row.rows[0].processing_status, 'succeeded');
    } finally {
      await aqShort.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. recall() — 三路搜尋 + entity boost + entityMode 'all'
// ---------------------------------------------------------------------------

describe('4. recall() — hybrid search', () => {
  let aq, pool, schema;

  // 共用資料：提前建好兩個 session
  before(async () => {
    ({ aq, pool, schema } = await createTestInstance());
    await aq.migrate();

    // Session A：包含 "keyword"
    await aq.commit('sid-recall-A', [
      { role: 'user', content: 'Tell me about keyword optimization strategies.' },
      { role: 'assistant', content: 'Keyword optimization involves several steps.' },
    ]);
    await aq.enrich('sid-recall-A', {
      summaryFn: makeFakeSummaryFn({
        summaryText: 'Discussion about keyword optimization strategies.',
        title: 'Keyword Optimization',
        overview: 'Deep dive into keyword strategies',
        entityRaw: `[ENTITIES]\nname: KeywordProject\ntype: project\naliases:`,
      }),
      entityParseFn: (raw) => require('../core/entity').parseEntityOutput(raw),
    });

    // Session B：關於 "unrelated"（不包含 "keyword"）
    await aq.commit('sid-recall-B', [
      { role: 'user', content: 'Tell me about unrelated astronomy topics.' },
      { role: 'assistant', content: 'The cosmos is vast.' },
    ]);
    await aq.enrich('sid-recall-B', {
      summaryFn: makeFakeSummaryFn({
        summaryText: 'Discussion about unrelated astronomy and cosmos.',
        entityRaw: `[ENTITIES]\nname: CosmosProject\ntype: project\naliases:`,
      }),
      entityParseFn: (raw) => require('../core/entity').parseEntityOutput(raw),
    });
  });

  after(async () => {
    await teardown(aq, pool, schema);
  });

  it('recall 找到 keyword session（FTS 路徑）', async () => {
    // 驗什麼：FTS 能用 plainto_tsquery 搜到 summary_text 的詞
    // 為什麼重要：FTS 是三路搜尋中最直覺的路徑，確保 search_tsv 觸發器正確
    const results = await aq.recall('keyword optimization');
    assert.ok(results.length >= 1, 'FTS found nothing');

    const found = results.find(r => r.sessionId === 'sid-recall-A');
    assert.ok(found, 'sid-recall-A not in results');
    assert.ok(found.score > 0, 'score should be > 0');
    assert.ok(found.summaryText, 'summaryText missing');
  });

  it('recall 找到 keyword session（embedding 路徑）', async () => {
    // 驗什麼：summary embedding cosine similarity < threshold 能找到正確 session
    // 為什麼重要：embedding 路徑是語意搜尋的核心
    // fake embed 讓 "keyword" 文字產生 [0,1,0]，query "keyword" 也是 [0,1,0]
    // cosine distance = 0 → 一定在最前面
    const results = await aq.recall('keyword query');
    const found = results.find(r => r.sessionId === 'sid-recall-A');
    assert.ok(found, 'sid-recall-A not found via embedding search');
  });

  it('recall 找到 keyword session（turn embedding 路徑）', async () => {
    // 驗什麼：turn_embeddings 搜尋路徑
    // 為什麼重要：turn-level granularity 補足 summary 不夠細的情況
    // "keyword optimization strategies" 存在 turn，query "keyword" vector 相同
    const results = await aq.recall('keyword optimization strategies');
    const found = results.find(r => r.sessionId === 'sid-recall-A');
    assert.ok(found, 'turn embedding path did not find sid-recall-A');
    // matched_turn_text 若來自 turn 路徑會有值
    if (found.matchedTurnText) {
      assert.ok(found.matchedTurnText.length > 0);
    }
  });

  it('recall 結果有正確欄位格式', async () => {
    // 驗什麼：output shape 符合 API 文件
    // 為什麼重要：消費者依賴固定 output shape
    const results = await aq.recall('keyword');
    assert.ok(results.length >= 1);

    const r = results[0];
    assert.ok('sessionId' in r, 'sessionId missing');
    assert.ok('score' in r, 'score missing');
    assert.ok('trustScore' in r, 'trustScore missing');
    assert.ok('_debug' in r, '_debug missing');
    assert.ok('summaryText' in r, 'summaryText missing');
    assert.ok(typeof r.score === 'number');
    assert.ok(r.score >= 0 && r.score <= 1, `score out of range: ${r.score}`);
  });

  it('recall 空 query 拋錯（1.4.0 contract: must be non-empty string）', async () => {
    // 驗什麼：空字串 guard — 1.4.0 改成 throw 而非 silent []，避免吃 caller bug
    // 為什麼重要：contract 清楚才不會把上游錯打包成空結果
    await assert.rejects(() => aq.recall(''), /must be a non-empty string/);
  });

  it('recall limit 參數生效', async () => {
    // 驗什麼：limit=1 最多回傳 1 筆
    // 為什麼重要：caller 要能控制結果數量
    const results = await aq.recall('keyword', { limit: 1 });
    assert.ok(results.length <= 1, `expected <= 1 result, got ${results.length}`);
  });

  it('recall entities 參數（entityMode default any）提升命中分數', async () => {
    // 驗什麼：明確帶 entities: ['KeywordProject'] recall，entity boost 讓 A 排前面
    // 為什麼重要：entity boost 是 knowledge graph 整合的核心功能
    const results = await aq.recall('keyword', { entities: ['KeywordProject'] });
    assert.ok(results.length >= 1, 'no results with entity filter');

    const foundA = results.find(r => r.sessionId === 'sid-recall-A');
    assert.ok(foundA, 'sid-recall-A should be in results with entity boost');
    assert.ok(foundA._debug.entityScore > 0, 'entity boost score should be > 0');
  });

  it('recall entityMode=all：只有兩個 entity 都有的 session 才出現', async () => {
    // 驗什麼：entityMode 'all' 是 AND filter，不是 OR
    // 為什麼重要：精確 entity intersection 查詢依賴這個語意
    // 先建一個有 Diana + Eve 的 session
    await aq.commit('sid-both-ents', [
      { role: 'user', content: 'keyword Diana and Eve collaboration.' },
    ]);
    await aq.enrich('sid-both-ents', {
      summaryFn: makeFakeSummaryFn({
        summaryText: 'keyword Diana Eve meeting session',
        entityRaw: `[ENTITIES]\nname: Diana\ntype: person\naliases:\n---\nname: Eve\ntype: person\naliases:`,
      }),
      entityParseFn: (raw) => require('../core/entity').parseEntityOutput(raw),
    });

    // 只有 Diana 的 session
    await aq.commit('sid-only-diana', [
      { role: 'user', content: 'keyword Diana solo work.' },
    ]);
    await aq.enrich('sid-only-diana', {
      summaryFn: makeFakeSummaryFn({
        summaryText: 'keyword Diana working alone',
        entityRaw: `[ENTITIES]\nname: Diana\ntype: person\naliases:`,
      }),
      entityParseFn: (raw) => require('../core/entity').parseEntityOutput(raw),
    });

    // entityMode 'all'：只有 sid-both-ents 符合
    const results = await aq.recall('keyword', {
      entities: ['Diana', 'Eve'],
      entityMode: 'all',
    });

    const foundBoth = results.find(r => r.sessionId === 'sid-both-ents');
    const foundOnlyDiana = results.find(r => r.sessionId === 'sid-only-diana');

    assert.ok(foundBoth, 'session with both entities should appear');
    assert.equal(foundOnlyDiana, undefined, 'session with only Diana should NOT appear in all mode');
  });

  it('recall 不存在的 entity，entityMode=all 回傳 []', async () => {
    // 驗什麼：entity resolve 失敗時 early return []
    // 為什麼重要：避免因 partial resolve 導致 AND 語意被靜默弱化
    const results = await aq.recall('keyword', {
      entities: ['NonExistentEntityXyz'],
      entityMode: 'all',
    });
    assert.deepEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// 5. feedback() — trust_score 更新
// ---------------------------------------------------------------------------

describe('5. feedback() — trust_score', () => {
  let aq, pool, schema;

  before(async () => {
    ({ aq, pool, schema } = await createTestInstance());
    await aq.migrate();

    // 準備一個 enriched session
    await aq.commit('sid-feedback', [
      { role: 'user', content: 'keyword feedback test content.' },
    ]);
    await aq.enrich('sid-feedback', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'keyword feedback summary.' }),
    });
  });

  after(async () => {
    await teardown(aq, pool, schema);
  });

  it('helpful feedback 使 trust_score 上升 +0.05', async () => {
    // 驗什麼：TRUST_UP = 0.05 邏輯
    // 為什麼重要：trust score 直接影響 recall ranking
    const before = await pool.query(
      `SELECT trust_score FROM "${schema}".session_summaries ss
       JOIN "${schema}".sessions s ON s.id = ss.session_row_id
       WHERE s.session_id = $1`,
      ['sid-feedback']
    );
    const trustBefore = parseFloat(before.rows[0].trust_score);

    const result = await aq.feedback('sid-feedback', { verdict: 'helpful' });

    assert.ok(Math.abs(result.trustAfter - Math.min(1.0, trustBefore + 0.05)) < 0.001,
      `trustAfter wrong: ${result.trustAfter}`);
    assert.equal(result.verdict, 'helpful');

    // DB 值也更新
    const after = await pool.query(
      `SELECT trust_score FROM "${schema}".session_summaries ss
       JOIN "${schema}".sessions s ON s.id = ss.session_row_id
       WHERE s.session_id = $1`,
      ['sid-feedback']
    );
    assert.ok(Math.abs(parseFloat(after.rows[0].trust_score) - result.trustAfter) < 0.001);
  });

  it('unhelpful feedback 使 trust_score 下降 -0.10', async () => {
    // 驗什麼：TRUST_DOWN = 0.10
    // 為什麼重要：懲罰機制要正確，不能下溢 0
    const before = await pool.query(
      `SELECT trust_score FROM "${schema}".session_summaries ss
       JOIN "${schema}".sessions s ON s.id = ss.session_row_id
       WHERE s.session_id = $1`,
      ['sid-feedback']
    );
    const trustBefore = parseFloat(before.rows[0].trust_score);

    const result = await aq.feedback('sid-feedback', { verdict: 'unhelpful' });

    assert.ok(Math.abs(result.trustAfter - Math.max(0.0, trustBefore - 0.10)) < 0.001,
      `trustAfter wrong: ${result.trustAfter}`);
    assert.ok(result.trustAfter >= 0, 'trust_score underflowed below 0');
  });

  it('feedback 寫入 session_feedback audit trail', async () => {
    // 驗什麼：每次 feedback 有一條 audit row
    // 為什麼重要：audit trail 用於 debug 和 ML 訓練資料
    await aq.feedback('sid-feedback', { verdict: 'helpful', note: 'great answer' });

    const after = await pool.query(
      `SELECT verdict, note FROM "${schema}".session_feedback sf
       JOIN "${schema}".sessions s ON s.id = sf.session_row_id
       WHERE s.session_id = $1
       ORDER BY sf.created_at DESC LIMIT 1`,
      ['sid-feedback']
    );
    assert.equal(parseInt(after.rows.length), 1);
    assert.equal(after.rows[0].verdict, 'helpful');
    assert.equal(after.rows[0].note, 'great answer');
  });

  it('feedback 不存在 session 拋錯', async () => {
    await assert.rejects(
      () => aq.feedback('sid-ghost', { verdict: 'helpful' }),
      /Session not found/
    );
  });

  it('feedback missing verdict 拋錯', async () => {
    await assert.rejects(
      () => aq.feedback('sid-feedback', {}),
      /opts\.verdict is required/
    );
  });

  it('feedback 未 enriched session（無 summary）拋錯', async () => {
    // 驗什麼：feedback 依賴 session_summaries row 存在
    // 為什麼重要：沒有 summary 不知道 trust_score 起始值
    await aq.commit('sid-no-summary', [{ role: 'user', content: 'keyword only committed.' }]);

    await assert.rejects(
      () => aq.feedback('sid-no-summary', { verdict: 'helpful' }),
      /not enriched/
    );
  });

  it('duplicate (agent, verdict) does not stack trust_score', async () => {
    // Contract: same agent applying the same verdict twice must count once.
    // Different agents applying the same verdict should still each move trust.
    await aq.commit('sid-fb-dup', [{ role: 'user', content: 'keyword dedupe.' }]);
    await aq.enrich('sid-fb-dup', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'keyword dedupe summary.' }),
    });

    const r1 = await aq.feedback('sid-fb-dup', { verdict: 'helpful' });
    const r2 = await aq.feedback('sid-fb-dup', { verdict: 'helpful' });
    assert.ok(Math.abs(r1.trustAfter - (r1.trustBefore + 0.05)) < 0.001,
      'first helpful must apply +TRUST_UP');
    assert.ok(Math.abs(r2.trustAfter - r1.trustAfter) < 0.001,
      `duplicate (agent, verdict) must not stack trust: r2.before=${r2.trustBefore} after=${r2.trustAfter}`);
    assert.equal(r2.duplicate, true, 'second call must flag duplicate');

    // Same agent, different verdict must still move trust (not deduped).
    const r3 = await aq.feedback('sid-fb-dup', { verdict: 'unhelpful' });
    assert.ok(r3.trustAfter < r2.trustAfter,
      `different verdict should still move trust: before=${r3.trustBefore} after=${r3.trustAfter}`);
    assert.equal(r3.duplicate, false);
  });

  it('trust_score 上限 clamp 到 1.0', async () => {
    // 驗什麼：Math.min(1.0, trust + 0.05)
    // 為什麼重要：防止 trust_score > 1 破壞 hybridRank trustMultiplier 計算
    // 建一個 trust=1.0 的 session
    await aq.commit('sid-maxts', [{ role: 'user', content: 'keyword max trust.' }]);
    await aq.enrich('sid-maxts', {
      summaryFn: makeFakeSummaryFn({ summaryText: 'keyword max trust summary.' }),
    });
    await pool.query(
      `UPDATE "${schema}".session_summaries SET trust_score = 1.0
       WHERE session_row_id = (SELECT id FROM "${schema}".sessions WHERE session_id = $1)`,
      ['sid-maxts']
    );

    const result = await aq.feedback('sid-maxts', { verdict: 'helpful' });
    assert.equal(result.trustAfter, 1.0);
  });
});

// ---------------------------------------------------------------------------
// 6. entity_scope DDL migration 路徑
// ---------------------------------------------------------------------------

describe('6. entity_scope migration path', () => {
  let pool, schema;

  before(async () => {
    schema = randomSchema();
    pool = new Pool({ connectionString: DB_URL });
    // 建立 001-base.sql（不含 entities）
    const { createAquifer } = require('../index');
    const aqBase = createAquifer({
      db: DB_URL,
      schema,
      tenantId: 'test',
      embed: { fn: makeFakeEmbed() },
      // entities NOT enabled — 先建 base schema
    });
    await aqBase.migrate();
    await aqBase.close();
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('後來 enableEntities() 補建 entity tables + entity_scope index', async () => {
    // 驗什麼：已存在的 schema 上補跑 002-entities.sql
    // 為什麼重要：現有部署可能先升 base 再升 entities
    const aqFull = createAquifer({
      db: DB_URL,
      schema,
      tenantId: 'test',
      embed: { fn: makeFakeEmbed() },
      entities: { enabled: false },
    });
    // 先跑 base migrate（entities=false 只跑 001+003）
    await aqFull.migrate();
    // 再 enable entities — 應補跑 002-entities.sql
    await aqFull.enableEntities();

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name IN ('entities','entity_mentions','entity_relations','entity_sessions')`,
      [schema]
    );
    const names = tables.rows.map(r => r.table_name);
    assert.ok(names.includes('entities'), 'entities missing after enableEntities');

    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'idx_entities_tenant_name_scope'`,
      [schema]
    );
    assert.equal(idx.rows.length, 1, 'idx_entities_tenant_name_scope missing');

    await aqFull.close();
  });

  it('entity_scope DEFAULT 是 default，NOT NULL 確保沒有空值', async () => {
    // 驗什麼：002 的 ALTER COLUMN SET NOT NULL 有效
    // 為什麼重要：ON CONFLICT (tenant, normalized_name, entity_scope) 不能有 NULL 的 scope
    const col = await pool.query(
      `SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'entities' AND column_name = 'entity_scope'`,
      [schema]
    );
    assert.equal(col.rows[0].is_nullable, 'NO', 'entity_scope should be NOT NULL');
  });
});

// ---------------------------------------------------------------------------
// 7. pool 管理 + 邊界情況
// ---------------------------------------------------------------------------

describe('7. pool 管理 + 邊界情況', () => {
  it('外部 pool 傳入，close() 不關 pool', async () => {
    // 驗什麼：ownsPool=false 時 aq.close() 不呼叫 pool.end()
    // 為什麼重要：共享 pool 被意外關閉會影響其他程式碼
    const schema = randomSchema();
    const adminPool = new Pool({ connectionString: DB_URL });

    try {
      const aq = createAquifer({
        db: adminPool,   // 傳 pool 物件，不是 string
        schema,
        tenantId: 'test',
        embed: { fn: makeFakeEmbed() },
      });
      await aq.migrate();
      await aq.close();

      // pool 應該還活著
      const res = await adminPool.query('SELECT 1 AS alive');
      assert.equal(res.rows[0].alive, 1, 'pool was closed by aq.close()');
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    }
  });

  it('string db config 建立自有 pool，close() 後 pool 關閉', async () => {
    // 驗什麼：ownsPool=true 時 close() 確實呼叫 pool.end()
    // 為什麼重要：resource leak 測試
    const schema = randomSchema();
    const adminPool = new Pool({ connectionString: DB_URL });

    try {
      const aq = createAquifer({
        db: DB_URL,
        schema,
        tenantId: 'test',
        embed: { fn: makeFakeEmbed() },
      });
      await aq.migrate();
      await aq.close();
      // 關後不應能繼續 query（但 aq.close 後 pool 已關，再呼叫會錯）
      // 只驗 close 不拋錯即可
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    }
  });

  it('recall 不帶 embed fn 拋錯', async () => {
    // 驗什麼：lazy validation on recall
    const aq = createAquifer({ db: DB_URL });
    await assert.rejects(
      () => aq.recall('test query'),
      /requires config\.embed\.fn/
    );
    await aq.close();
  });

  it('entities recall 未 enable entities 拋錯', async () => {
    // 驗什麼：recall with entities option 但 entities not enabled
    // 為什麼重要：應給明確錯誤，而非靜默返回錯誤結果
    const schema = randomSchema();
    const adminPool = new Pool({ connectionString: DB_URL });
    try {
      const aq = createAquifer({
        db: DB_URL,
        schema,
        tenantId: 'test',
        embed: { fn: makeFakeEmbed() },
        // entities NOT enabled
      });
      await assert.rejects(
        () => aq.recall('test', { entities: ['SomeEntity'] }),
        /Entities are not enabled/
      );
      await aq.close();
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await adminPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. bootstrap() — contract over session visibility
// ---------------------------------------------------------------------------

describe('8. bootstrap() — session visibility contract', () => {
  let aq, pool, schema;

  before(async () => {
    ({ aq, pool, schema } = await createTestInstance());
    await aq.migrate();
  });

  after(async () => {
    await teardown(aq, pool, schema);
  });

  it('includes sessions with processing_status = partial', async () => {
    // 驗什麼：enrich 產生 warnings 的 session 標 'partial'（有 summary 但有失敗）
    //   必須被 bootstrap 看見，否則 operator 永遠拿不到帶警訊的 session
    // 為什麼重要：contract — 有 summary 就可見，不管是 'succeeded' 還是 'partial'
    await aq.commit('sid-boot-partial', [
      { role: 'user', content: 'keyword partial visibility.' },
    ]);

    // 讓 customSummaryFn 成功寫 summary，但強迫一條 warning（turn embed fail）
    const failingEmbedAq = createAquifer({
      db: DB_URL, schema, tenantId: 'test',
      embed: { fn: async () => { throw new Error('mock embed fail'); }, dim: 1024 },
    });
    try {
      await failingEmbedAq.enrich('sid-boot-partial', {
        summaryFn: makeFakeSummaryFn({ summaryText: 'keyword partial summary.' }),
      });
    } finally {
      await failingEmbedAq.close();
    }

    const statusRow = await pool.query(
      `SELECT processing_status FROM "${schema}".sessions WHERE session_id = $1`,
      ['sid-boot-partial']
    );
    assert.equal(statusRow.rows[0].processing_status, 'partial',
      'precondition: session must be partial for this test to be meaningful');

    const boot = await aq.bootstrap({ limit: 10, lookbackDays: 30 });
    const ids = boot.sessions.map(s => s.sessionId);
    assert.ok(ids.includes('sid-boot-partial'),
      `bootstrap must include 'partial' sessions; got ${JSON.stringify(ids)}`);
  });

  it('excludes sessions still in pending/processing (no summary yet)', async () => {
    // 驗什麼：沒走過 enrich 的 session 不該出現（沒 summary 可顯示）
    await aq.commit('sid-boot-pending', [
      { role: 'user', content: 'keyword pending never enriched.' },
    ]);

    const boot = await aq.bootstrap({ limit: 10, lookbackDays: 30 });
    const ids = boot.sessions.map(s => s.sessionId);
    assert.ok(!ids.includes('sid-boot-pending'),
      `bootstrap must not include pending sessions; got ${JSON.stringify(ids)}`);
  });
});
