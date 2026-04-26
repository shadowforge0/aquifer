'use strict';

/**
 * Aquifer v1 curated writer integration tests — real PostgreSQL.
 *
 * Running:
 *   AQUIFER_TEST_DB_URL="postgresql://..." \
 *     node --test test/v1-curated-writer.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('v1 curated writer integration tests');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

function qname(schema, table) {
  return `"${schema}"."${table}"`;
}

function factCandidate(overrides = {}) {
  return {
    memoryType: 'fact',
    canonicalKey: overrides.canonicalKey || 'fact:project:aquifer:storage',
    scopeKind: 'project',
    scopeKey: 'project:aquifer',
    summary: overrides.summary || 'Aquifer source of truth is memory_records.',
    authority: overrides.authority || 'verified_summary',
    evidenceRefs: overrides.evidenceRefs || [{
      sourceKind: 'external',
      sourceRef: overrides.sourceRef || 'schema/007-v1-foundation.sql',
    }],
  };
}

if (DB_URL) {
describe('v1 curated writer integration', () => {
  let aq;
  let pool;
  let schema;

  before(async () => {
    schema = randomSchema();
    pool = new Pool({ connectionString: DB_URL });
    aq = createAquifer({ db: DB_URL, schema, tenantId: 'test' });
    await aq.migrate();
  });

  after(async () => {
    try { await aq.close(); } catch {}
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end().catch(() => {});
    }
  });

  async function memoryRows(canonicalKey = 'fact:project:aquifer:storage') {
    const result = await pool.query(
      `SELECT id, canonical_key, status, summary, authority, superseded_by,
              valid_to, backing_fact_id, observed_at, superseded_at,
              visible_in_bootstrap, visible_in_recall
         FROM ${qname(schema, 'memory_records')}
        WHERE tenant_id = $1 AND canonical_key = $2
        ORDER BY id ASC`,
      ['test', canonicalKey],
    );
    return result.rows;
  }

  async function factRows(canonicalKey = 'fact:project:aquifer:storage') {
    const result = await pool.query(
      `SELECT id, canonical_key, status, predicate, object_kind, object_value_json,
              authority, superseded_by, valid_to, observed_at, superseded_at
         FROM ${qname(schema, 'fact_assertions_v1')}
        WHERE tenant_id = $1 AND canonical_key = $2
        ORDER BY id ASC`,
      ['test', canonicalKey],
    );
    return result.rows;
  }

  it('serializes zero-row concurrent promotions for the same canonical key', async () => {
    const first = aq.memory.promote([factCandidate({
      summary: 'Aquifer source of truth is memory_records.',
      sourceRef: 'candidate:first',
    })], { acceptedAt: '2026-04-26T00:00:00Z' });
    const second = aq.memory.promote([factCandidate({
      summary: 'Aquifer source of truth is session_summaries.',
      sourceRef: 'candidate:second',
    })], { acceptedAt: '2026-04-26T00:00:01Z' });

    const settled = await Promise.allSettled([first, second]);
    assert.deepEqual(settled.map(result => result.status), ['fulfilled', 'fulfilled']);

    const actions = settled.map(result => result.value[0].action).sort();
    assert.deepEqual(actions, ['promote', 'quarantine']);
    assert.equal(
      settled.find(result => result.value[0].action === 'quarantine').value[0].reason,
      'unresolved_active_conflict',
    );

    const rows = await memoryRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'active');
    assert.ok(rows[0].backing_fact_id, 'active fact memory should link to fact_assertions_v1');

    const facts = await factRows();
    assert.equal(facts.length, 1);
    assert.equal(facts[0].status, 'active');
    assert.equal(facts[0].predicate, 'fact');
    assert.equal(facts[0].object_kind, 'value');
  });

  it('keeps supersede history when higher authority replaces an active memory', async () => {
    const canonicalKey = 'fact:project:aquifer:supersede';
    const first = await aq.memory.promote([factCandidate({
      canonicalKey,
      summary: 'Aquifer source of truth is session_summaries.',
      authority: 'verified_summary',
      sourceRef: 'candidate:lower-authority',
    })], { acceptedAt: '2026-04-26T01:00:00Z' });
    const second = await aq.memory.promote([factCandidate({
      canonicalKey,
      summary: 'Aquifer source of truth is memory_records.',
      authority: 'executable_evidence',
      sourceRef: 'candidate:higher-authority',
    })], { acceptedAt: '2026-04-26T01:01:00Z' });

    assert.equal(first[0].action, 'promote');
    assert.equal(second[0].action, 'promote');

    const rows = await memoryRows(canonicalKey);
    assert.equal(rows.length, 2);
    const oldRow = rows.find(row => row.status === 'superseded');
    const newRow = rows.find(row => row.status === 'active');
    assert.ok(oldRow, 'expected old row to remain as superseded history');
    assert.ok(newRow, 'expected new active row');
    assert.equal(Number(oldRow.superseded_by), Number(newRow.id));
    assert.ok(oldRow.valid_to, 'superseded row should have a valid_to timestamp');
    assert.ok(oldRow.superseded_at, 'superseded row should have system-time retirement');
    assert.ok(newRow.backing_fact_id, 'new active memory should link to structured fact assertion');
    assert.equal(oldRow.visible_in_bootstrap, false);
    assert.equal(oldRow.visible_in_recall, false);

    const facts = await factRows(canonicalKey);
    assert.equal(facts.length, 2);
    const oldFact = facts.find(row => row.status === 'superseded');
    const newFact = facts.find(row => row.status === 'active');
    assert.ok(oldFact, 'expected old fact assertion to remain as superseded history');
    assert.ok(newFact, 'expected new active fact assertion');
    assert.equal(Number(oldFact.superseded_by), Number(newFact.id));
    assert.equal(Number(newRow.backing_fact_id), Number(newFact.id));

    const refs = await pool.query(
      `SELECT id FROM ${qname(schema, 'evidence_refs')}
        WHERE tenant_id = $1 AND owner_kind = 'memory_record' AND owner_id = $2`,
      ['test', newRow.id],
    );
    assert.equal(refs.rowCount, 1);
  });

  it('rolls back supersede and new active insert when evidence insert fails', async () => {
    const canonicalKey = 'fact:project:aquifer:rollback';
    await aq.memory.promote([factCandidate({
      canonicalKey,
      summary: 'Aquifer source of truth is session_summaries.',
      authority: 'verified_summary',
      sourceRef: 'candidate:rollback-seed',
    })], { acceptedAt: '2026-04-26T02:00:00Z' });

    await assert.rejects(
      () => aq.memory.promote([factCandidate({
        canonicalKey,
        summary: 'Aquifer source of truth is memory_records.',
        authority: 'executable_evidence',
        evidenceRefs: [{ sourceKind: 'invalid_source_kind', sourceRef: 'candidate:bad-evidence' }],
      })], { acceptedAt: '2026-04-26T02:01:00Z' }),
      /evidence_refs_source_kind_check|invalid input value|violates check constraint/i,
    );

    const rows = await memoryRows(canonicalKey);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[0].summary, 'Aquifer source of truth is session_summaries.');
    assert.equal(rows[0].superseded_by, null);
    assert.equal(rows[0].valid_to, null);
  });
});
}
