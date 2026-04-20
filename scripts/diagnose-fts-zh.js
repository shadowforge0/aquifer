'use strict';

/**
 * Aquifer FTS 中文診斷
 *
 * 測 aquifer 實際搜尋主路徑（trigram ILIKE on search_text + similarity ranking）
 * vs fallback 路徑（tsvector @@ plainto_tsquery(<cfg>, q)）對中文 query 的表現。
 * tsconfig 自動偵測：public.zhcfg 已存在就用 'zhcfg'（1.5.0+ 底層是 pg_jieba
 * jiebaqry，1.4.0 底層是 zhparser），否則退回 'simple'。腳本會印出 zhcfg 實際
 * parser 名稱——看到 'zhparser' 代表繁體分詞會退化 char-level。
 *
 * env:
 *   DATABASE_URL       — required
 *   AQUIFER_SCHEMA     — default 'public'
 *   AQUIFER_FTS_CONFIG — override auto-detect ('zhcfg' or 'simple')
 *   DIAGNOSE_QUERIES   — comma-separated, overrides built-in set
 */

const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const SCHEMA = process.env.AQUIFER_SCHEMA || 'public';

const DEFAULT_QUERIES = [
  // latin
  'afterburn', 'bootstrap', 'session', 'recall', 'entity', 'OpenCode', 'Jenny', 'Aquifer',
  // CJK short tokens — 最容易暴露 tokenizer 問題
  '記憶', '時區', '去重', '架構', '修復',
  // CJK phrase
  '消化模式', 'daily entries',
];
const QUERIES = process.env.DIAGNOSE_QUERIES
  ? process.env.DIAGNOSE_QUERIES.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_QUERIES;

const pool = new Pool({ connectionString: DB_URL });
const qi = (s) => `"${s.replace(/"/g, '""')}"`;

function pct(n, d) {
  if (d === 0) return n === 0 ? '—' : '∞%';
  return `${Math.round((n / d) * 100)}%`;
}

async function detectFtsConfig() {
  if (process.env.AQUIFER_FTS_CONFIG === 'zhcfg' || process.env.AQUIFER_FTS_CONFIG === 'simple') {
    return { cfg: process.env.AQUIFER_FTS_CONFIG, parser: null };
  }
  try {
    const r = await pool.query(`
      SELECT p.prsname AS parser
      FROM pg_ts_config c JOIN pg_ts_parser p ON c.cfgparser = p.oid
      WHERE c.cfgname = 'zhcfg' AND c.cfgnamespace = 'public'::regnamespace
      LIMIT 1`);
    if (r.rowCount > 0) return { cfg: 'zhcfg', parser: r.rows[0].parser };
    return { cfg: 'simple', parser: null };
  } catch {
    return { cfg: 'simple', parser: null };
  }
}

let FTS_CFG = 'simple';

async function main() {
  const detected = await detectFtsConfig();
  FTS_CFG = detected.cfg;
  const parserLabel = detected.parser
    ? ` parser=${detected.parser}`
    : '';
  console.log(`=== Aquifer FTS 中文診斷 (schema=${SCHEMA}, tsconfig=${FTS_CFG}${parserLabel}) ===\n`);
  if (detected.parser === 'zhparser') {
    console.log('[warn] zhcfg 目前是 zhparser-backed。scws 內建字典是簡體字為主，對');
    console.log('       繁體字會全退 char-level 分詞（「記憶」→ 記/憶 單字，等於');
    console.log('       simple tokenizer）。考慮換 pg_jieba，見 CHANGELOG 1.5.0。\n');
  }

  // -------------------------------------------------------------------------
  // 0. 覆蓋率：search_text NULL 率 → 看 fallback 觸發比例
  // -------------------------------------------------------------------------
  const cov = await pool.query(`
    SELECT
      COUNT(*)                                          AS total,
      COUNT(*) FILTER (WHERE search_text IS NOT NULL)   AS with_text,
      COUNT(*) FILTER (WHERE search_tsv  IS NOT NULL)   AS with_tsv,
      COUNT(*) FILTER (WHERE search_text IS NULL
                         AND search_tsv  IS NOT NULL)   AS tsv_only
    FROM ${qi(SCHEMA)}.session_summaries
  `);
  const c = cov.rows[0];
  console.log('--- 0. 搜尋欄位覆蓋率 ---');
  console.log(`  total rows       : ${c.total}`);
  console.log(`  has search_text  : ${c.with_text} (${pct(c.with_text, c.total)})`);
  console.log(`  has search_tsv   : ${c.with_tsv} (${pct(c.with_tsv, c.total)})`);
  console.log(`  tsv-only (NULL search_text, falls back to FTS): ${c.tsv_only} (${pct(c.tsv_only, c.total)})\n`);

  // -------------------------------------------------------------------------
  // 1. Token 範例（tsvector lexeme 粒度觀察）
  // -------------------------------------------------------------------------
  console.log('--- 1. tsvector lexeme 粒度範例（最近 1 筆）---');
  const tokenDetail = await pool.query(`
    SELECT session_id,
           array_length(tsvector_to_array(search_tsv), 1) AS token_count,
           array_to_string(tsvector_to_array(search_tsv), ' | ') AS tokens
    FROM ${qi(SCHEMA)}.session_summaries
    WHERE search_tsv IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  if (tokenDetail.rows[0]) {
    const r = tokenDetail.rows[0];
    const all = (r.tokens || '').split(' | ').filter(Boolean);
    const cjk = all.filter(t => /[\u4e00-\u9fff]/.test(t));
    const latin = all.filter(t => /^[a-z0-9]/.test(t));
    console.log(`  session: ${String(r.session_id).slice(0, 8)} | total tokens: ${r.token_count || 0}`);
    console.log(`  latin: ${latin.length} | cjk-containing: ${cjk.length}`);
    console.log(`  CJK lexemes (前 15): ${cjk.slice(0, 15).join(' | ')}`);
    console.log(`  → CJK lexeme 若是 phrase 級（整句無空白），簡 tokenizer 對中文短 query 會 miss\n`);
  } else {
    console.log('  (no rows)\n');
  }

  // -------------------------------------------------------------------------
  // 2. 主路徑 vs fallback：binary match 比對
  //
  // Ground truth = search_text ILIKE '%q%'（所有源欄位拼出的純文字 superset）
  // 主路徑        = search_text ILIKE（GIN trgm 加速，語意等價 ILIKE）
  // Fallback     = search_tsv @@ plainto_tsquery(<cfg>, q)
  // -------------------------------------------------------------------------
  console.log('--- 2. 主路徑（trigram）vs fallback（tsvector）binary match ---');
  console.log('  query               | truth | trgm  | tsv   | trgm% | tsv%  | tsv-extra');
  console.log('  ' + '-'.repeat(82));

  const rowCount = await pool.query(
    `SELECT COUNT(*) AS n FROM ${qi(SCHEMA)}.session_summaries WHERE search_text IS NOT NULL`
  );
  const withTextN = parseInt(rowCount.rows[0].n, 10);
  console.log(`  (ground truth 基數：含 search_text 的 row ${withTextN})`);

  const summary = [];
  for (const q of QUERIES) {
    const r = await pool.query(
      `
      WITH base AS (
        SELECT search_text,
               search_tsv,
               (search_text ILIKE '%' || $1 || '%')                                 AS trgm_hit,
               (search_tsv  @@ plainto_tsquery('${FTS_CFG}', $2))                   AS tsv_hit
        FROM ${qi(SCHEMA)}.session_summaries
        WHERE search_text IS NOT NULL
      )
      SELECT
        COUNT(*) FILTER (WHERE trgm_hit)                         AS truth,
        COUNT(*) FILTER (WHERE trgm_hit)                         AS trgm,
        COUNT(*) FILTER (WHERE tsv_hit)                          AS tsv,
        COUNT(*) FILTER (WHERE tsv_hit AND NOT trgm_hit)         AS tsv_extra
      FROM base
      `,
      [q.replace(/[%_\\]/g, '\\$&'), q]
    );
    const { truth, trgm, tsv, tsv_extra } = r.rows[0];
    const T = parseInt(truth, 10);
    const A = parseInt(trgm, 10);
    const B = parseInt(tsv, 10);
    const E = parseInt(tsv_extra, 10);
    summary.push({ q, T, A, B, E });
    console.log(
      `  ${q.padEnd(19)} | ${String(T).padStart(5)} | ${String(A).padStart(5)} | ${String(B).padStart(5)} | ${pct(A, T).padStart(5)} | ${pct(B, T).padStart(5)} | ${String(E).padStart(5)}`
    );
  }
  console.log('  (tsv-extra = tsvector 命中但 trigram 沒命中 → 通常是 0，代表 tsv 對整體搜尋無額外貢獻)\n');

  // -------------------------------------------------------------------------
  // 3. Ranking 品質對比：舊 ranking (similarity only) vs 新 ranking (substr-hit first)
  // -------------------------------------------------------------------------
  console.log('--- 3. Ranking 品質對比：top-5 substring-hit 命中率 ---');
  console.log('  query               | truth | old (sim only) | new (hit+sim)');
  console.log('  ' + '-'.repeat(70));
  for (const q of QUERIES) {
    const like = q.replace(/[%_\\]/g, '\\$&');
    const truthR = await pool.query(
      `SELECT COUNT(*) AS n
         FROM ${qi(SCHEMA)}.session_summaries
         WHERE search_text ILIKE '%' || $1 || '%'`,
      [like]
    );
    const T = parseInt(truthR.rows[0].n, 10);

    const oldR = await pool.query(
      `
      SELECT (search_text ILIKE '%' || $1 || '%') AS substr_hit
      FROM ${qi(SCHEMA)}.session_summaries
      WHERE search_text IS NOT NULL
      ORDER BY similarity(search_text, $2) DESC
      LIMIT 5
      `,
      [like, q]
    );
    const oldHits = oldR.rows.filter(x => x.substr_hit).length;

    const newR = await pool.query(
      `
      SELECT (search_text ILIKE '%' || $1 || '%') AS substr_hit
      FROM ${qi(SCHEMA)}.session_summaries
      WHERE search_text IS NOT NULL
      ORDER BY
        (search_text ILIKE '%' || $1 || '%') DESC,
        similarity(search_text, $2) DESC
      LIMIT 5
      `,
      [like, q]
    );
    const newHits = newR.rows.filter(x => x.substr_hit).length;

    const expected = Math.min(5, T);
    console.log(
      `  ${q.padEnd(19)} | ${String(T).padStart(5)} | ${String(oldHits).padStart(3)}/5 → ${String(expected).padStart(1)}/5 ${oldHits < expected ? '✗' : '✓'}      | ${String(newHits).padStart(3)}/5 ${newHits < expected ? '✗' : '✓'}`
    );
  }
  console.log('  (truth = 含該字串的 row 數；ideal top-5 substr-hit = min(truth, 5))');

  await pool.end();
  console.log('\n=== 完成 ===');
}

main().catch(err => { console.error(err); process.exit(1); });
