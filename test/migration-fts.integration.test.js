'use strict';

/**
 * Integration tests for Chinese FTS migration (1.5.0+).
 *
 * Covers the DO block in schema/001-base.sql that manages public.zhcfg —
 * prefer pg_jieba, fall back to zhparser, handle S9 zombie state.
 *
 * Because `zhcfg` is a database-wide object, these tests do NOT attempt to
 * reset or reshape it. They only assert the post-migrate state is one of the
 * documented branches, that subsequent migrate() calls are idempotent, and
 * that the chosen tokenizer actually segments Chinese (the whole point of
 * 1.5.0 — zhparser silently degraded to char-level on Traditional corpora).
 *
 * Running:
 *   AQUIFER_TEST_DB_URL="postgresql://..." node --test test/migration-fts.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('migration FTS integration tests');

function randomSchema() {
  return `aquifer_ftstest_${crypto.randomBytes(4).toString('hex')}`;
}

if (DB_URL) {
describe('Chinese FTS migration (zhcfg state machine)', () => {
  const schema = randomSchema();
  const pool = new Pool({ connectionString: DB_URL });
  let aq;

  before(async () => {
    aq = createAquifer({
      db: pool,
      schema,
      tenantId: 'default',
      embedProvider: null,
      llmProvider: null,
    });
    await aq.migrate();
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pool.end();
  });

  it('zhcfg (if present) lives in public namespace', async () => {
    const r = await pool.query(`
      SELECT c.cfgname, n.nspname AS namespace, p.prsname AS parser
      FROM pg_ts_config c
      JOIN pg_ts_parser p ON c.cfgparser = p.oid
      JOIN pg_namespace n ON c.cfgnamespace = n.oid
      WHERE c.cfgname = 'zhcfg'
    `);
    if (r.rowCount === 0) {
      console.log('  (no zhcfg — neither pg_jieba nor zhparser installed; FTS on simple)');
      return;
    }
    // 1.5.0 guarantees zhcfg lives in public — the migration schema-qualifies
    // DROP/CREATE as public.zhcfg, and consumers look up with
    // cfgnamespace = 'public'::regnamespace.
    assert.equal(
      r.rows[0].namespace, 'public',
      `zhcfg found in namespace "${r.rows[0].namespace}", expected "public"`
    );
  });

  it('zhcfg parser is one of the documented backends', async () => {
    const r = await pool.query(`
      SELECT p.prsname AS parser
      FROM pg_ts_config c
      JOIN pg_ts_parser p ON c.cfgparser = p.oid
      WHERE c.cfgname = 'zhcfg' AND c.cfgnamespace = 'public'::regnamespace
    `);
    if (r.rowCount === 0) return;  // simple fallback, not an error
    const parser = r.rows[0].parser;
    assert.ok(
      ['jiebaqry', 'jiebacfg', 'zhparser'].includes(parser),
      `zhcfg parser "${parser}" is not in the documented set {jiebaqry, jiebacfg, zhparser}`
    );
  });

  it('migrate() is idempotent — second call leaves zhcfg untouched', async () => {
    const before = await pool.query(`
      SELECT c.cfgname, p.prsname AS parser
      FROM pg_ts_config c
      JOIN pg_ts_parser p ON c.cfgparser = p.oid
      WHERE c.cfgname = 'zhcfg' AND c.cfgnamespace = 'public'::regnamespace
    `);
    await aq.migrate();
    const after = await pool.query(`
      SELECT c.cfgname, p.prsname AS parser
      FROM pg_ts_config c
      JOIN pg_ts_parser p ON c.cfgparser = p.oid
      WHERE c.cfgname = 'zhcfg' AND c.cfgnamespace = 'public'::regnamespace
    `);
    assert.equal(after.rowCount, before.rowCount);
    if (before.rowCount > 0) {
      assert.equal(after.rows[0].parser, before.rows[0].parser);
    }
  });

  it('chosen tokenizer actually segments Chinese (not char-level)', async () => {
    const r = await pool.query(`
      SELECT EXISTS(
        SELECT 1 FROM pg_ts_config
        WHERE cfgname = 'zhcfg' AND cfgnamespace = 'public'::regnamespace
      ) AS have_zhcfg,
      (SELECT p.prsname FROM pg_ts_config c
        JOIN pg_ts_parser p ON c.cfgparser = p.oid
        WHERE c.cfgname = 'zhcfg' AND c.cfgnamespace = 'public'::regnamespace) AS parser
    `);
    const { have_zhcfg, parser } = r.rows[0];
    if (!have_zhcfg) {
      console.log('  (no zhcfg — skipping tokenization check)');
      return;
    }

    // Probe a three-compound string that jieba should split as words, not chars.
    const probe = await pool.query(`SELECT to_tsvector('zhcfg', $1) AS tsv`, ['記憶系統架構升級']);
    const lexemes = (probe.rows[0].tsv || '').match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [];

    if (parser === 'jiebaqry' || parser === 'jiebacfg') {
      // jieba with dict.txt.big should recognize at least one multi-char word.
      // Accept any of the reasonable segmentations (dict versions differ slightly).
      const hasMultiChar = lexemes.some(l => /[\u4e00-\u9fff]{2,}/.test(l));
      assert.ok(
        hasMultiChar,
        `jieba tokenization of "記憶系統架構升級" produced no multi-char CJK token; got: ${JSON.stringify(lexemes)}. Dictionary may be Simplified-only (dict.txt.big not installed).`
      );
    } else if (parser === 'zhparser') {
      // zhparser without a Traditional dict will char-split — document this
      // expectation rather than fail. The 1.5.0 upgrade path is supposed to
      // get users off this state.
      console.log(`  (zhparser-backed zhcfg — tokens: ${JSON.stringify(lexemes.slice(0, 10))})`);
    }
  });

  it('trigger function uses namespace-qualified pg_ts_config lookup', async () => {
    const r = await pool.query(`
      SELECT pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = $1 AND p.proname = 'session_summaries_search_tsv_update'
    `, [schema]);
    assert.equal(r.rowCount, 1);
    const def = r.rows[0].def;
    // 1.5.0 closed the search_path hole: lookup must pin cfgnamespace to public.
    assert.ok(
      /cfgnamespace\s*=\s*'public'::regnamespace/.test(def),
      'trigger function should restrict pg_ts_config lookup to cfgnamespace=public'
    );
  });
});
}
