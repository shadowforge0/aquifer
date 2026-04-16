'use strict';

/**
 * Aquifer vector recall 診斷
 *
 * 驗 summary-vector + turn-vector 兩路 infrastructure：
 *   - embedding coverage
 *   - vector dim 是否一致（summary vs turn）
 *   - self-retrieval sanity（拿自己 embedding 當 query，top-1 distance 應 ≈ 0）
 *
 * env:
 *   DATABASE_URL       — required
 *   AQUIFER_SCHEMA     — default 'public'
 */

const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const SCHEMA = process.env.AQUIFER_SCHEMA || 'public';

const pool = new Pool({ connectionString: DB_URL });
const qi = (s) => `"${s.replace(/"/g, '""')}"`;
const pct = (n, d) => (d === 0 ? (n === 0 ? '—' : '∞%') : `${Math.round((n / d) * 100)}%`);
const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').slice(0, 70) : '');

async function main() {
  console.log(`=== Aquifer vector recall 診斷 (schema=${SCHEMA}) ===\n`);

  // -------------------------------------------------------------------------
  // 1. Summary embedding coverage + dim
  // -------------------------------------------------------------------------
  const s = (await pool.query(`
    SELECT
      COUNT(*)                                                      AS total,
      COUNT(*) FILTER (WHERE embedding IS NOT NULL)                 AS with_emb,
      MIN(vector_dims(embedding))                                   AS min_dim,
      MAX(vector_dims(embedding))                                   AS max_dim
    FROM ${qi(SCHEMA)}.session_summaries
  `)).rows[0];
  console.log('--- 1. session_summaries.embedding ---');
  console.log(`  total ${s.total} | with_emb ${s.with_emb} (${pct(s.with_emb, s.total)})`);
  const summaryDim = s.min_dim;
  console.log(`  dim min=${s.min_dim} max=${s.max_dim}${s.min_dim !== s.max_dim ? ' ⚠ 不一致' : ''}\n`);

  // -------------------------------------------------------------------------
  // 2. Turn embedding coverage + dim
  // -------------------------------------------------------------------------
  const t = (await pool.query(`
    SELECT
      COUNT(*)                                                      AS total,
      COUNT(DISTINCT session_row_id)                                AS distinct_sessions,
      MIN(vector_dims(embedding))                                   AS min_dim,
      MAX(vector_dims(embedding))                                   AS max_dim
    FROM ${qi(SCHEMA)}.turn_embeddings
  `)).rows[0];
  console.log('--- 2. turn_embeddings.embedding ---');
  console.log(`  total turns ${t.total} | distinct sessions ${t.distinct_sessions}`);
  console.log(`  dim min=${t.min_dim} max=${t.max_dim}${t.min_dim !== t.max_dim ? ' ⚠ 不一致' : ''}`);
  const turnDim = t.min_dim;
  if (turnDim && summaryDim && turnDim !== summaryDim) {
    console.log(`  ⚠ summary dim ${summaryDim} != turn dim ${turnDim} → query embedding 只會對得上其中一條`);
  }
  console.log();

  // -------------------------------------------------------------------------
  // 3. 缺 turn 但有 summary 的 session 比例
  // -------------------------------------------------------------------------
  const gap = (await pool.query(`
    SELECT
      COUNT(DISTINCT ss.session_row_id)                         AS with_summary_emb,
      COUNT(DISTINCT te.session_row_id)                         AS with_turn_emb,
      COUNT(DISTINCT ss.session_row_id) FILTER (
        WHERE te.session_row_id IS NULL
      )                                                         AS summary_no_turn
    FROM ${qi(SCHEMA)}.session_summaries ss
    LEFT JOIN ${qi(SCHEMA)}.turn_embeddings te
           ON te.session_row_id = ss.session_row_id
    WHERE ss.embedding IS NOT NULL
  `)).rows[0];
  console.log('--- 3. 兩路覆蓋差 ---');
  console.log(`  sessions with summary emb : ${gap.with_summary_emb}`);
  console.log(`  sessions with turn emb    : ${gap.with_turn_emb}`);
  console.log(`  summary-only (no turns)   : ${gap.summary_no_turn} (${pct(gap.summary_no_turn, gap.with_summary_emb)})`);
  console.log('  (summary-only 是常見的—某些 session 沒有合適的 user turn 可 embed)\n');

  // -------------------------------------------------------------------------
  // 4. Self-retrieval sanity: summary vector
  //    拿最近一筆 summary.embedding 當 query，top-1 應該是自己且 distance ≈ 0
  // -------------------------------------------------------------------------
  console.log('--- 4. Summary vector self-retrieval sanity ---');
  const seedS = (await pool.query(`
    SELECT s.session_id, ss.summary_text, ss.embedding
    FROM ${qi(SCHEMA)}.session_summaries ss
    JOIN ${qi(SCHEMA)}.sessions s ON s.id = ss.session_row_id
    WHERE ss.embedding IS NOT NULL
    ORDER BY ss.updated_at DESC
    LIMIT 1
  `)).rows[0];

  if (!seedS) {
    console.log('  (no summary with embedding)\n');
  } else {
    const r = await pool.query(`
      SELECT s.session_id,
             (ss.embedding <=> $1::vector) AS distance,
             ss.summary_text
      FROM ${qi(SCHEMA)}.session_summaries ss
      JOIN ${qi(SCHEMA)}.sessions s ON s.id = ss.session_row_id
      WHERE ss.embedding IS NOT NULL
      ORDER BY ss.embedding <=> $1::vector ASC
      LIMIT 5
    `, [seedS.embedding]);
    console.log(`  seed  : ${String(seedS.session_id).slice(0, 8)} | ${clean(seedS.summary_text)}`);
    for (const row of r.rows) {
      const mark = String(row.session_id) === String(seedS.session_id) ? ' ← self' : '';
      console.log(`  [${Number(row.distance).toFixed(4)}] ${String(row.session_id).slice(0, 8)} | ${clean(row.summary_text)}${mark}`);
    }
    const top = r.rows[0];
    const selfOK = top && String(top.session_id) === String(seedS.session_id) && Number(top.distance) < 0.001;
    console.log(`  → self top-1 @ distance≈0: ${selfOK ? 'YES ✓' : 'NO ✗'}\n`);
  }

  // -------------------------------------------------------------------------
  // 5. Self-retrieval sanity: turn vector
  // -------------------------------------------------------------------------
  console.log('--- 5. Turn vector self-retrieval sanity ---');
  const seedT = (await pool.query(`
    SELECT te.session_row_id, te.turn_index, te.content_text, te.embedding,
           s.session_id
    FROM ${qi(SCHEMA)}.turn_embeddings te
    JOIN ${qi(SCHEMA)}.sessions s ON s.id = te.session_row_id
    ORDER BY te.created_at DESC
    LIMIT 1
  `)).rows[0];

  if (!seedT) {
    console.log('  (no turn embeddings)\n');
  } else {
    const r = await pool.query(`
      SELECT s.session_id, te.turn_index, te.content_text,
             (te.embedding <=> $1::vector) AS distance
      FROM ${qi(SCHEMA)}.turn_embeddings te
      JOIN ${qi(SCHEMA)}.sessions s ON s.id = te.session_row_id
      ORDER BY te.embedding <=> $1::vector ASC
      LIMIT 5
    `, [seedT.embedding]);
    console.log(`  seed  : ${String(seedT.session_id).slice(0, 8)} turn=${seedT.turn_index} | ${clean(seedT.content_text)}`);
    for (const row of r.rows) {
      const self = String(row.session_id) === String(seedT.session_id) && row.turn_index === seedT.turn_index;
      console.log(`  [${Number(row.distance).toFixed(4)}] ${String(row.session_id).slice(0, 8)} turn=${row.turn_index} | ${clean(row.content_text)}${self ? ' ← self' : ''}`);
    }
    const top = r.rows[0];
    const selfOK = top && Number(top.distance) < 0.001;
    console.log(`  → self top-1 @ distance≈0: ${selfOK ? 'YES ✓' : 'NO ✗'}\n`);
  }

  // -------------------------------------------------------------------------
  // 6. 跨路比較：用同一筆 summary embedding 去 turn table 找鄰居
  //    只在 dim 一致時做；看 summary 代表 vs 其最近 turn 的距離分佈
  // -------------------------------------------------------------------------
  if (summaryDim && turnDim && summaryDim === turnDim && seedS) {
    console.log('--- 6. Cross-path：summary emb → turn search (dim 相同才跑) ---');
    const r = await pool.query(`
      SELECT DISTINCT ON (te.session_row_id)
             s.session_id, te.turn_index,
             (te.embedding <=> $1::vector) AS distance,
             te.content_text
      FROM ${qi(SCHEMA)}.turn_embeddings te
      JOIN ${qi(SCHEMA)}.sessions s ON s.id = te.session_row_id
      ORDER BY te.session_row_id, te.embedding <=> $1::vector ASC
    `, [seedS.embedding]);
    r.rows.sort((a, b) => Number(a.distance) - Number(b.distance));
    for (const row of r.rows.slice(0, 5)) {
      const mark = String(row.session_id) === String(seedS.session_id) ? ' ← same session' : '';
      console.log(`  [${Number(row.distance).toFixed(4)}] ${String(row.session_id).slice(0, 8)} turn=${row.turn_index} | ${clean(row.content_text)}${mark}`);
    }
    console.log('  (不要求 top-1 是 seed session，兩路語意不同；只看距離是否合理 ≪ 1)\n');
  }

  await pool.end();
  console.log('=== 完成 ===');
}

main().catch(err => { console.error(err); process.exit(1); });
