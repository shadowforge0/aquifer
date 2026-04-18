'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createAquifer } = require('../core/aquifer');

// Minimal pool that records every SQL string. Always returns empty rows.
function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: typeof sql === 'string' ? sql : '(non-string)', params: params || [] });
      return { rowCount: 0, rows: [] };
    },
    async end() {},
  };
}

describe('004-facts.sql schema file', () => {
  it('exists at schema/004-facts.sql', () => {
    const p = path.join(__dirname, '..', 'schema', '004-facts.sql');
    assert.ok(fs.existsSync(p));
  });

  it('uses ${schema} placeholder, not a hardcoded schema', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'schema', '004-facts.sql'), 'utf8');
    assert.ok(raw.includes('${schema}.facts'));
    assert.ok(raw.includes('${schema}.fact_entities'));
    assert.ok(!raw.includes('miranda.facts'));
  });

  it('defines all lifecycle statuses in CHECK', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'schema', '004-facts.sql'), 'utf8');
    for (const status of ['candidate', 'active', 'stale', 'archived', 'superseded']) {
      assert.ok(raw.includes(`'${status}'`), `missing status: ${status}`);
    }
  });

  it('is idempotent (all DDL uses IF NOT EXISTS)', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'schema', '004-facts.sql'), 'utf8');
    const createTables = raw.match(/CREATE TABLE\s+(IF NOT EXISTS\s+)?/gi) || [];
    for (const m of createTables) {
      assert.ok(/IF NOT EXISTS/i.test(m), `CREATE TABLE missing IF NOT EXISTS: ${m}`);
    }
    const createIdx = raw.match(/CREATE (UNIQUE )?INDEX\s+(IF NOT EXISTS\s+)?/gi) || [];
    for (const m of createIdx) {
      assert.ok(/IF NOT EXISTS/i.test(m), `CREATE INDEX missing IF NOT EXISTS: ${m}`);
    }
  });
});

describe('enableFacts()', () => {
  it('runs 004-facts.sql when called after implicit migrate', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'testschema' });
    await aq.enableFacts();
    // Find at least one query that touches the facts table with substituted schema
    const hit = pool.queries.find(q => q.sql.includes('"testschema".facts') && q.sql.includes('CREATE TABLE'));
    assert.ok(hit, 'expected facts CREATE TABLE to run with substituted schema');
  });

  it('runs 004-facts.sql inside migrate() when facts enabled upfront', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'foo', facts: { enabled: true } });
    await aq.migrate();
    const hit = pool.queries.find(q => q.sql.includes('"foo".facts') && q.sql.includes('CREATE TABLE'));
    assert.ok(hit);
  });

  it('does NOT run 004-facts.sql when facts not enabled', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'bar' });
    await aq.migrate();
    const hit = pool.queries.find(q => q.sql.includes('"bar".facts') && q.sql.includes('CREATE TABLE'));
    assert.ok(!hit, 'facts DDL should not run without enableFacts');
  });

  it('is idempotent when called multiple times', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'zz' });
    await aq.enableFacts();
    await aq.enableFacts();
    await aq.enableFacts();
    // Each call re-runs DDL (safe because IF NOT EXISTS). No throw.
    const factsQueries = pool.queries.filter(q => q.sql.includes('"zz".facts'));
    assert.ok(factsQueries.length >= 3);
  });
});

describe('consolidate() requires enableFacts', () => {
  it('throws when consolidate called without enableFacts', async () => {
    const pool = makeRecordingPool();
    const aq = createAquifer({ db: pool, schema: 'x' });
    await assert.rejects(
      () => aq.consolidate('ses-1', { actions: [], agentId: 'main' }),
      /enableFacts/,
    );
  });

  it('delegates to applyConsolidation after enableFacts', async () => {
    // pool with connect() for applyConsolidation tx
    const queries = [];
    const mockClient = {
      async query(sql) {
        queries.push(sql.replace(/\s+/g, ' ').trim());
        return { rowCount: 0, rows: [] };
      },
      release() {},
    };
    const pool = {
      queries,
      async query(sql) {
        queries.push(sql.replace(/\s+/g, ' ').trim());
        return { rowCount: 0, rows: [] };
      },
      async connect() { return mockClient; },
      async end() {},
    };
    const aq = createAquifer({ db: pool, schema: 'aq', facts: { enabled: true } });
    await aq.enableFacts();
    const summary = await aq.consolidate('ses-1', {
      agentId: 'main',
      actions: [{ action: 'confirm', factId: 1 }],
    });
    assert.equal(typeof summary.confirm, 'number');
    assert.ok(queries.includes('BEGIN'));
    assert.ok(queries.includes('COMMIT'));
  });
});
