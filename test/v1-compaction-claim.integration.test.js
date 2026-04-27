'use strict';

/**
 * Aquifer v1 compaction claim integration tests — real PostgreSQL.
 *
 * Running:
 *   AQUIFER_TEST_DB_URL="postgresql://..." \
 *     node --test test/v1-compaction-claim.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { createMemoryRecords } = require('../core/memory-records');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('v1 compaction claim integration tests');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

function qname(schema, table) {
  return `"${schema}"."${table}"`;
}

if (DB_URL) {
describe('v1 compaction claim integration', () => {
  let ownerAq;
  let workerAq1;
  let workerAq2;
  let pool;
  let schema;

  before(async () => {
    schema = randomSchema();
    pool = new Pool({ connectionString: DB_URL });
    ownerAq = createAquifer({ db: DB_URL, schema, tenantId: 'test' });
    workerAq1 = createAquifer({ db: DB_URL, schema, tenantId: 'test' });
    workerAq2 = createAquifer({ db: DB_URL, schema, tenantId: 'test' });
    await ownerAq.migrate();
  });

  after(async () => {
    for (const aq of [workerAq2, workerAq1, ownerAq]) {
      try { await aq.close(); } catch {}
    }
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end().catch(() => {});
    }
  });

  it('allows only one concurrent worker to apply the same compaction plan', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
    });
    const memory = await ownerAq.memory.upsertMemory({
      memoryType: 'open_loop',
      canonicalKey: 'open_loop:claim-smoke',
      scopeId: scope.id,
      summary: 'Follow up on the claim smoke test.',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      staleAfter: '2026-04-25T12:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    const planA = workerAq1.memory.consolidation.plan([memory], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-claim-smoke',
    });
    const planB = workerAq2.memory.consolidation.plan([memory], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-claim-smoke',
    });
    assert.equal(planA.inputHash, planB.inputHash);

    const settled = await Promise.allSettled([
      workerAq1.memory.consolidation.applyPlan({
        plan: planA,
        workerId: 'worker-a',
        applyToken: 'token-a',
        appliedAt: '2026-04-26T00:00:00Z',
      }),
      workerAq2.memory.consolidation.applyPlan({
        plan: planB,
        workerId: 'worker-b',
        applyToken: 'token-b',
        appliedAt: '2026-04-26T00:00:01Z',
      }),
    ]);

    assert.deepEqual(settled.map(result => result.status), ['fulfilled', 'fulfilled']);
    const results = settled.map(result => result.value);
    assert.deepEqual(results.map(result => result.status).sort(), ['applied', 'skipped']);
    assert.deepEqual(
      results.map(result => result.applyResult.applied).sort((a, b) => a - b),
      [0, 1],
    );
    assert.deepEqual(
      results.map(result => result.applyResult.skipped).sort((a, b) => a - b),
      [0, 1],
    );

    const memories = await pool.query(
      `SELECT id, status, visible_in_bootstrap, visible_in_recall
         FROM ${qname(schema, 'memory_records')}
        WHERE tenant_id = $1 AND id = $2`,
      ['test', memory.id],
    );
    assert.equal(memories.rows.length, 1);
    assert.equal(memories.rows[0].status, 'stale');
    assert.equal(memories.rows[0].visible_in_bootstrap, false);
    assert.equal(memories.rows[0].visible_in_recall, false);

    const runs = await pool.query(
      `SELECT status, worker_id, apply_token, claimed_at, applied_at,
              source_coverage, output_coverage, output
         FROM ${qname(schema, 'compaction_runs')}
        WHERE tenant_id = $1
          AND cadence = $2
          AND period_start = $3::timestamptz
          AND period_end = $4::timestamptz
          AND input_hash = $5
          AND policy_version = $6`,
      [
        'test',
        planA.cadence,
        planA.periodStart,
        planA.periodEnd,
        planA.inputHash,
        planA.policyVersion,
      ],
    );
    assert.equal(runs.rows.length, 1);
    assert.equal(runs.rows[0].status, 'applied');
    assert.match(runs.rows[0].worker_id, /^worker-[ab]$/);
    assert.match(runs.rows[0].apply_token, /^token-[ab]$/);
    assert.ok(runs.rows[0].claimed_at);
    assert.ok(runs.rows[0].applied_at);
    assert.equal(runs.rows[0].source_coverage.activeOpenLoopCount, 1);
    assert.equal(runs.rows[0].output_coverage.statusUpdateCount, 1);
    assert.equal(runs.rows[0].output_coverage.appliedStatusUpdateCount, 1);
    assert.equal(runs.rows[0].output.applyResult.applied, 1);
  });

  it('skips a different snapshot for the same compaction window without rejecting', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer-claim-race',
    });
    const memory = await ownerAq.memory.upsertMemory({
      memoryType: 'open_loop',
      canonicalKey: 'open_loop:claim-race',
      scopeId: scope.id,
      summary: 'Follow up on the claim race test.',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      staleAfter: '2026-04-25T12:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    const planA = workerAq1.memory.consolidation.plan([memory], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-claim-race',
    });
    const planB = workerAq2.memory.consolidation.plan([{
      ...memory,
      summary: `${memory.summary} Snapshot observed by worker B.`,
    }], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-claim-race',
    });
    assert.notEqual(planA.inputHash, planB.inputHash);

    const settled = await Promise.allSettled([
      workerAq1.memory.consolidation.applyPlan({
        plan: planA,
        workerId: 'worker-a',
        applyToken: 'race-token-a',
        appliedAt: '2026-04-26T00:00:00Z',
      }),
      workerAq2.memory.consolidation.applyPlan({
        plan: planB,
        workerId: 'worker-b',
        applyToken: 'race-token-b',
        appliedAt: '2026-04-26T00:00:01Z',
      }),
    ]);

    assert.deepEqual(settled.map(result => result.status), ['fulfilled', 'fulfilled']);
    const results = settled.map(result => result.value);
    assert.deepEqual(results.map(result => result.status).sort(), ['applied', 'skipped']);

    const runs = await pool.query(
      `SELECT status, count(*)::int AS count
         FROM ${qname(schema, 'compaction_runs')}
        WHERE tenant_id = $1
          AND cadence = $2
          AND period_start = $3::timestamptz
          AND period_end = $4::timestamptz
          AND policy_version = $5
        GROUP BY status
        ORDER BY status`,
      [
        'test',
        planA.cadence,
        planA.periodStart,
        planA.periodEnd,
        planA.policyVersion,
      ],
    );
    const counts = Object.fromEntries(runs.rows.map(row => [row.status, row.count]));
    assert.equal(counts.applied, 1);
    assert.equal(counts.applying || 0, 0);
  });

  it('reclaims a stale applying claim before applying a new snapshot for the same window', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer-claim-lease',
    });
    const memory = await ownerAq.memory.upsertMemory({
      memoryType: 'open_loop',
      canonicalKey: 'open_loop:claim-lease',
      scopeId: scope.id,
      summary: 'Follow up on the claim lease test.',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      staleAfter: '2026-04-25T12:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    const plan = workerAq1.memory.consolidation.plan([memory], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-claim-lease',
    });
    await pool.query(
      `INSERT INTO ${qname(schema, 'compaction_runs')} (
         tenant_id, cadence, period_start, period_end, input_hash,
         policy_version, status, claimed_at, lease_expires_at, worker_id, apply_token
       )
       VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,'applying',$7::timestamptz,$8::timestamptz,$9,$10)`,
      [
        'test',
        plan.cadence,
        plan.periodStart,
        plan.periodEnd,
        'stale-input-hash',
        plan.policyVersion,
        '2026-04-25T23:00:00Z',
        '2026-04-25T23:01:00Z',
        'stale-worker',
        'stale-token',
      ],
    );

    const result = await workerAq1.memory.consolidation.applyPlan({
      plan,
      workerId: 'worker-fresh',
      applyToken: 'fresh-token',
      claimedAt: '2026-04-26T00:00:00Z',
      claimLeaseSeconds: 60,
      appliedAt: '2026-04-26T00:00:01Z',
    });

    assert.equal(result.status, 'applied');

    const runs = await pool.query(
      `SELECT input_hash, status, error, worker_id
         FROM ${qname(schema, 'compaction_runs')}
        WHERE tenant_id = $1
          AND cadence = $2
          AND period_start = $3::timestamptz
          AND period_end = $4::timestamptz
          AND policy_version = $5
        ORDER BY input_hash`,
      [
        'test',
        plan.cadence,
        plan.periodStart,
        plan.periodEnd,
        plan.policyVersion,
      ],
    );
    assert.equal(runs.rows.length, 2);
    const stale = runs.rows.find(row => row.input_hash === 'stale-input-hash');
    const fresh = runs.rows.find(row => row.input_hash === plan.inputHash);
    assert.equal(stale.status, 'failed');
    assert.equal(stale.error, 'claim lease expired before finalize');
    assert.equal(fresh.status, 'applied');
    assert.equal(fresh.worker_id, 'worker-fresh');
  });

  it('does not reclaim an unexpired applying claim for the same window', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer-claim-lease-fresh',
    });
    const memory = await ownerAq.memory.upsertMemory({
      memoryType: 'open_loop',
      canonicalKey: 'open_loop:claim-lease-fresh',
      scopeId: scope.id,
      summary: 'Follow up on the fresh claim lease test.',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      staleAfter: '2026-04-25T12:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    const plan = workerAq1.memory.consolidation.plan([memory], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-claim-lease-fresh',
    });
    await pool.query(
      `INSERT INTO ${qname(schema, 'compaction_runs')} (
         tenant_id, cadence, period_start, period_end, input_hash,
         policy_version, status, claimed_at, lease_expires_at, worker_id, apply_token
       )
       VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,'applying',transaction_timestamp(),$7::timestamptz,$8,$9)`,
      [
        'test',
        plan.cadence,
        plan.periodStart,
        plan.periodEnd,
        'fresh-input-hash',
        plan.policyVersion,
        '2099-01-01T00:00:00Z',
        'fresh-worker',
        'fresh-token',
      ],
    );

    const result = await workerAq1.memory.consolidation.applyPlan({
      plan,
      workerId: 'worker-blocked',
      applyToken: 'blocked-token',
      claimLeaseSeconds: 60,
    });

    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.applyResult, {
      applied: 0,
      skipped: 1,
      unsupported: 0,
      statusUpdates: 1,
    });

    const memories = await pool.query(
      `SELECT status, visible_in_bootstrap, visible_in_recall
         FROM ${qname(schema, 'memory_records')}
        WHERE tenant_id = $1 AND id = $2`,
      ['test', memory.id],
    );
    assert.equal(memories.rows[0].status, 'active');
    assert.equal(memories.rows[0].visible_in_bootstrap, true);
    assert.equal(memories.rows[0].visible_in_recall, true);

    const runs = await pool.query(
      `SELECT input_hash, status, worker_id
         FROM ${qname(schema, 'compaction_runs')}
        WHERE tenant_id = $1
          AND cadence = $2
          AND period_start = $3::timestamptz
          AND period_end = $4::timestamptz
          AND policy_version = $5`,
      ['test', plan.cadence, plan.periodStart, plan.periodEnd, plan.policyVersion],
    );
    assert.equal(runs.rows.length, 2);
    const original = runs.rows.find(row => row.input_hash === 'fresh-input-hash');
    const blocked = runs.rows.find(row => row.input_hash === plan.inputHash);
    assert.equal(original.status, 'applying');
    assert.equal(original.worker_id, 'fresh-worker');
    assert.equal(blocked.status, 'planned');
  });

  it('applyPlan writes planned aggregate candidate lineage without active promotion', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-planned',
    });
    const memory = await ownerAq.memory.upsertMemory({
      memoryType: 'decision',
      canonicalKey: 'decision:rollup-planned-source',
      scopeId: scope.id,
      summary: 'Planner candidates need DB lineage before promotion.',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    const plan = workerAq1.memory.consolidation.plan([{
      ...memory,
      memoryType: memory.memory_type,
      canonicalKey: memory.canonical_key,
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-planned',
      status: memory.status,
    }], {
      tenantId: 'test',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-rollup-planned-smoke',
    });

    const result = await workerAq1.memory.consolidation.applyPlan({
      plan,
      workerId: 'rollup-planned-worker',
      applyToken: 'rollup-planned-token',
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.candidateRows.length, 1);

    const candidateRows = await pool.query(
      `SELECT action, memory_record_id, source_memory_ids, source_canonical_keys
         FROM ${qname(schema, 'compaction_candidates')}
        WHERE tenant_id = $1 AND compaction_run_id = $2`,
      ['test', result.run.id],
    );
    assert.equal(candidateRows.rows.length, 1);
    assert.equal(candidateRows.rows[0].action, 'planned');
    assert.equal(candidateRows.rows[0].memory_record_id, null);
    assert.ok(candidateRows.rows[0].source_memory_ids.map(Number).includes(Number(memory.id)));
    assert.deepEqual(candidateRows.rows[0].source_canonical_keys, [memory.canonical_key]);

    const promoted = await pool.query(
      `SELECT id
         FROM ${qname(schema, 'memory_records')}
        WHERE tenant_id = $1
          AND canonical_key = $2
          AND status = 'active'`,
      ['test', plan.candidates[0].canonicalKey],
    );
    assert.equal(promoted.rows.length, 0);
  });

  it('executePlan promotes aggregate candidates with DB-backed compaction lineage', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-promotion',
    });
    const memory = await ownerAq.memory.upsertMemory({
      memoryType: 'decision',
      canonicalKey: 'decision:rollup-promotion-source',
      scopeId: scope.id,
      summary: 'Rollup candidates must pass a formal promotion operator.',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    const plan = workerAq1.memory.consolidation.plan([{
      ...memory,
      memoryType: memory.memory_type,
      canonicalKey: memory.canonical_key,
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-promotion',
      status: memory.status,
    }], {
      tenantId: 'test',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-rollup-promotion-smoke',
    });
    assert.equal(plan.statusUpdates.length, 0);
    assert.equal(plan.candidates.length, 1);

    const result = await workerAq1.memory.consolidation.executePlan({
      plan,
      workerId: 'rollup-promotion-worker',
      applyToken: 'rollup-promotion-token',
      appliedAt: '2026-04-26T00:00:00Z',
      promoteCandidates: true,
    });

    assert.equal(result.status, 'applied');
    assert.equal(result.promotionResult.promoted, 1);
    assert.equal(result.candidateRows.length, 1);

    const runId = result.run.id;
    const promoted = await pool.query(
      `SELECT id, status, canonical_key, created_by_compaction_run_id,
              visible_in_bootstrap, visible_in_recall
         FROM ${qname(schema, 'memory_records')}
        WHERE tenant_id = $1 AND canonical_key = $2`,
      ['test', plan.candidates[0].canonicalKey],
    );
    assert.equal(promoted.rows.length, 1);
    assert.equal(promoted.rows[0].status, 'active');
    assert.equal(Number(promoted.rows[0].created_by_compaction_run_id), Number(runId));
    assert.equal(promoted.rows[0].visible_in_bootstrap, true);
    assert.equal(promoted.rows[0].visible_in_recall, true);

    const candidates = await pool.query(
      `SELECT action, memory_record_id, source_memory_ids, source_canonical_keys
         FROM ${qname(schema, 'compaction_candidates')}
        WHERE tenant_id = $1 AND compaction_run_id = $2`,
      ['test', runId],
    );
    assert.equal(candidates.rows.length, 1);
    assert.equal(candidates.rows[0].action, 'promote');
    assert.equal(Number(candidates.rows[0].memory_record_id), Number(promoted.rows[0].id));
    assert.ok(candidates.rows[0].source_memory_ids.map(Number).includes(Number(memory.id)));
    assert.deepEqual(candidates.rows[0].source_canonical_keys, [memory.canonical_key]);

    const refs = await pool.query(
      `SELECT created_by_compaction_run_id
         FROM ${qname(schema, 'evidence_refs')}
        WHERE tenant_id = $1
          AND owner_kind = 'memory_record'
          AND owner_id = $2`,
      ['test', promoted.rows[0].id],
    );
    assert.equal(refs.rows.length, 1);
    assert.equal(Number(refs.rows[0].created_by_compaction_run_id), Number(runId));
  });

  it('excludes non-active DB memories from promoted daily rollup candidates', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-exclusion',
    });
    const active = await ownerAq.memory.upsertMemory({
      memoryType: 'decision',
      canonicalKey: 'decision:rollup-exclusion-active',
      scopeId: scope.id,
      summary: 'Rollup exclusion active memory',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    for (const status of ['incorrect', 'quarantined', 'superseded']) {
      await ownerAq.memory.upsertMemory({
        memoryType: 'decision',
        canonicalKey: `decision:rollup-exclusion-${status}`,
        scopeId: scope.id,
        summary: `Rollup exclusion ${status} memory`,
        status,
        authority: 'verified_summary',
        acceptedAt: '2026-04-25T00:01:00Z',
        visibleInBootstrap: false,
        visibleInRecall: false,
      });
    }

    const stored = await pool.query(
      `SELECT status, visible_in_bootstrap, visible_in_recall
         FROM ${qname(schema, 'memory_records')} m
         JOIN ${qname(schema, 'scopes')} s ON s.id = m.scope_id
        WHERE m.tenant_id = $1 AND s.scope_key = $2
        ORDER BY m.status`,
      ['test', 'project:aquifer-rollup-exclusion'],
    );
    assert.deepEqual(stored.rows.map(row => row.status).sort(), ['active', 'incorrect', 'quarantined', 'superseded']);
    assert.equal(stored.rows.filter(row => row.status !== 'active').every(row => row.visible_in_bootstrap === false), true);
    assert.equal(stored.rows.filter(row => row.status !== 'active').every(row => row.visible_in_recall === false), true);

    const records = createMemoryRecords({
      pool,
      schema: `"${schema}"`,
      defaultTenantId: 'test',
    });
    const snapshot = await records.listActive({
      visibleInBootstrap: true,
      scopeKeys: ['project:aquifer-rollup-exclusion'],
      limit: 10,
    });
    assert.deepEqual(snapshot.map(row => row.canonical_key), [active.canonical_key]);

    const plan = workerAq1.memory.consolidation.plan(snapshot.map(row => ({
      ...row,
      memoryType: row.memory_type,
      canonicalKey: row.canonical_key,
      scopeKind: row.scope_kind,
      scopeKey: row.scope_key,
    })), {
      tenantId: 'test',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-rollup-exclusion-smoke',
    });
    assert.equal(plan.candidates.length, 1);
    assert.deepEqual(plan.candidates[0].payload.sourceMemoryIds, [Number(active.id)]);
    assert.deepEqual(plan.candidates[0].payload.sourceCanonicalKeys, [active.canonical_key]);
    assert.doesNotMatch(plan.candidates[0].summary, /incorrect|quarantined|superseded/);

    const result = await workerAq1.memory.consolidation.executePlan({
      plan,
      workerId: 'rollup-exclusion-worker',
      applyToken: 'rollup-exclusion-token',
      appliedAt: '2026-04-26T00:00:00Z',
      promoteCandidates: true,
    });

    assert.equal(result.status, 'applied');
    assert.equal(result.promotionResult.promoted, 1);

    const candidateRows = await pool.query(
      `SELECT action, source_memory_ids, source_canonical_keys
         FROM ${qname(schema, 'compaction_candidates')}
        WHERE tenant_id = $1 AND compaction_run_id = $2`,
      ['test', result.run.id],
    );
    assert.equal(candidateRows.rows.length, 1);
    assert.equal(candidateRows.rows[0].action, 'promote');
    assert.deepEqual(candidateRows.rows[0].source_memory_ids.map(Number), [Number(active.id)]);
    assert.deepEqual(candidateRows.rows[0].source_canonical_keys, [active.canonical_key]);

    const promoted = await pool.query(
      `SELECT summary
         FROM ${qname(schema, 'memory_records')}
        WHERE tenant_id = $1
          AND canonical_key = $2
          AND status = 'active'`,
      ['test', plan.candidates[0].canonicalKey],
    );
    assert.equal(promoted.rows.length, 1);
    assert.doesNotMatch(promoted.rows[0].summary, /incorrect|quarantined|superseded/);
  });

  it('replays planned aggregate candidate writes idempotently without promotion', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-planned-replay',
    });
    const memory = await ownerAq.memory.upsertMemory({
      memoryType: 'decision',
      canonicalKey: 'decision:rollup-planned-replay-source',
      scopeId: scope.id,
      summary: 'Planned compaction candidate replay should not duplicate lineage rows.',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    const plan = workerAq1.memory.consolidation.plan([{
      ...memory,
      memoryType: memory.memory_type,
      canonicalKey: memory.canonical_key,
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-planned-replay',
      status: memory.status,
    }], {
      tenantId: 'test',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-rollup-planned-replay',
    });

    const first = await workerAq1.memory.consolidation.applyPlan({
      plan,
      workerId: 'rollup-planned-replay-worker-a',
      applyToken: 'rollup-planned-replay-token-a',
    });
    const second = await workerAq1.memory.consolidation.applyPlan({
      plan,
      workerId: 'rollup-planned-replay-worker-b',
      applyToken: 'rollup-planned-replay-token-b',
    });

    assert.equal(first.status, 'skipped');
    assert.equal(second.status, 'skipped');
    assert.equal(Number(first.run.id), Number(second.run.id));

    const candidates = await pool.query(
      `SELECT count(*)::int AS count, min(action) AS action
         FROM ${qname(schema, 'compaction_candidates')}
        WHERE tenant_id = $1 AND compaction_run_id = $2`,
      ['test', first.run.id],
    );
    assert.equal(candidates.rows[0].count, 1);
    assert.equal(candidates.rows[0].action, 'planned');
  });

  it('replays promoted aggregate execution without duplicating active memory', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-promote-replay',
    });
    const memory = await ownerAq.memory.upsertMemory({
      memoryType: 'decision',
      canonicalKey: 'decision:rollup-promote-replay-source',
      scopeId: scope.id,
      summary: 'Promoted compaction replay should not duplicate active rollup memory.',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    const plan = workerAq1.memory.consolidation.plan([{
      ...memory,
      memoryType: memory.memory_type,
      canonicalKey: memory.canonical_key,
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-promote-replay',
      status: memory.status,
    }], {
      tenantId: 'test',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-rollup-promote-replay',
    });

    const first = await workerAq1.memory.consolidation.executePlan({
      plan,
      workerId: 'rollup-promote-replay-worker-a',
      applyToken: 'rollup-promote-replay-token-a',
      promoteCandidates: true,
    });
    const second = await workerAq1.memory.consolidation.executePlan({
      plan,
      workerId: 'rollup-promote-replay-worker-b',
      applyToken: 'rollup-promote-replay-token-b',
      promoteCandidates: true,
    });

    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'skipped');

    const memories = await pool.query(
      `SELECT count(*)::int AS count
         FROM ${qname(schema, 'memory_records')}
        WHERE tenant_id = $1
          AND canonical_key = $2
          AND status = 'active'`,
      ['test', plan.candidates[0].canonicalKey],
    );
    assert.equal(memories.rows[0].count, 1);

    const candidates = await pool.query(
      `SELECT count(*)::int AS count, min(action) AS action
         FROM ${qname(schema, 'compaction_candidates')}
        WHERE tenant_id = $1 AND compaction_run_id = $2`,
      ['test', first.run.id],
    );
    assert.equal(candidates.rows[0].count, 1);
    assert.equal(candidates.rows[0].action, 'promote');
  });

  it('rolls back candidate ledger and promoted memory when promotion evidence insert fails', async () => {
    const scope = await ownerAq.memory.upsertScope({
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-rollback',
    });
    const memory = await ownerAq.memory.upsertMemory({
      memoryType: 'decision',
      canonicalKey: 'decision:rollup-rollback-source',
      scopeId: scope.id,
      summary: 'Compaction promotion failure should roll back the run transaction.',
      status: 'active',
      authority: 'verified_summary',
      acceptedAt: '2026-04-25T00:00:00Z',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });
    const plan = workerAq1.memory.consolidation.plan([{
      ...memory,
      memoryType: memory.memory_type,
      canonicalKey: memory.canonical_key,
      scopeKind: 'project',
      scopeKey: 'project:aquifer-rollup-rollback',
      status: memory.status,
    }], {
      tenantId: 'test',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-rollup-rollback',
    });
    plan.candidates[0].evidenceRefs = [{
      sourceKind: 'invalid_source_kind',
      sourceRef: 'compaction:rollback',
    }];

    await assert.rejects(
      () => workerAq1.memory.consolidation.executePlan({
        plan,
        workerId: 'rollup-rollback-worker',
        applyToken: 'rollup-rollback-token',
        promoteCandidates: true,
      }),
      /evidence_refs_source_kind_check|invalid input value|violates check constraint/i,
    );

    const runs = await pool.query(
      `SELECT count(*)::int AS count
         FROM ${qname(schema, 'compaction_runs')}
        WHERE tenant_id = $1
          AND cadence = $2
          AND period_start = $3::timestamptz
          AND period_end = $4::timestamptz
          AND policy_version = $5`,
      ['test', plan.cadence, plan.periodStart, plan.periodEnd, plan.policyVersion],
    );
    assert.equal(runs.rows[0].count, 0);

    const candidates = await pool.query(
      `SELECT count(*)::int AS count
         FROM ${qname(schema, 'compaction_candidates')}
        WHERE tenant_id = $1
          AND canonical_key = $2`,
      ['test', plan.candidates[0].canonicalKey],
    );
    assert.equal(candidates.rows[0].count, 0);

    const promoted = await pool.query(
      `SELECT id
         FROM ${qname(schema, 'memory_records')}
        WHERE tenant_id = $1
          AND canonical_key = $2
          AND status = 'active'`,
      ['test', plan.candidates[0].canonicalKey],
    );
    assert.equal(promoted.rows.length, 0);
  });
});
}
