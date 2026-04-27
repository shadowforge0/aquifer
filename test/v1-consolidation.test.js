'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  planCompaction,
  distillArchiveSnapshot,
  resolveOperatorWindow,
  createMemoryConsolidation,
} = require('../core/memory-consolidation');
const { assessCandidate } = require('../core/memory-promotion');
const { createMemoryRecords } = require('../core/memory-records');

describe('v1 consolidation and old DB boundary', () => {
  it('plans daily compaction deterministically for the same snapshot', () => {
    const records = [
      {
        id: 2,
        memoryType: 'open_loop',
        canonicalKey: 'open_loop:b',
        status: 'active',
        staleAfter: '2026-04-25T00:00:00Z',
        summary: 'Follow up B',
      },
      {
        id: 1,
        memoryType: 'decision',
        canonicalKey: 'decision:a',
        status: 'active',
        summary: 'Decision A',
      },
    ];
    const opts = {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-test',
    };

    const a = planCompaction(records, opts);
    const b = planCompaction([...records].reverse(), opts);
    assert.equal(a.inputHash, b.inputHash);
    assert.deepEqual(a.statusUpdates, b.statusUpdates);
    assert.equal(a.meta.activeConflictRate, 0);
  });

  it('open-loop stale/expire planning does not mutate active winners directly', () => {
    const plan = planCompaction([
      {
        id: 9,
        memoryType: 'open_loop',
        canonicalKey: 'open_loop:stale',
        status: 'active',
        validTo: '2026-04-24T00:00:00Z',
        summary: 'Expired loop',
      },
    ], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    assert.deepEqual(plan.statusUpdates, [{
      memoryId: 9,
      canonicalKey: 'open_loop:stale',
      status: 'stale',
      reason: 'valid_to_elapsed',
    }]);
    assert.deepEqual(plan.candidates, []);
  });

  it('plans deterministic aggregate candidates for closed daily weekly monthly windows', () => {
    const records = [
      {
        id: 2,
        memoryType: 'fact',
        canonicalKey: 'fact:project:aquifer:db:lease',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Claim leases are stored as DB-time lease_expires_at rows.',
      },
      {
        id: 1,
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:slice5',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Keep compaction candidates behind the promotion gate.',
      },
      {
        id: 3,
        memoryType: 'open_loop',
        canonicalKey: 'open_loop:project:aquifer:expired',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        staleAfter: '2026-04-25T00:00:00Z',
        summary: 'Expired open loop must not roll up as current truth.',
      },
      {
        id: 4,
        memoryType: 'constraint',
        canonicalKey: 'constraint:project:other',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:other',
        summary: 'Other project remains in a separate rollup candidate.',
      },
      {
        id: 5,
        memoryType: 'fact',
        canonicalKey: 'fact:project:aquifer:old',
        status: 'superseded',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Superseded memory must not roll up.',
      },
      {
        id: 6,
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:incorrect',
        status: 'incorrect',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Incorrect memory must not roll up.',
      },
      {
        id: 7,
        memoryType: 'fact',
        canonicalKey: 'fact:project:aquifer:quarantined',
        status: 'quarantined',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Quarantined memory must not roll up.',
      },
    ];
    for (const cadence of ['daily', 'weekly', 'monthly']) {
      const opts = {
        cadence,
        tenantId: 'tenant-a',
        periodStart: '2026-04-25T00:00:00Z',
        periodEnd: '2026-04-26T00:00:00Z',
        policyVersion: 'v1-rollup',
      };

      const a = planCompaction(records, opts);
      const b = planCompaction([...records].reverse(), opts);

      assert.equal(a.inputHash, b.inputHash);
      assert.deepEqual(a.statusUpdates, b.statusUpdates);
      assert.deepEqual(a.candidates, b.candidates);
      assert.deepEqual(a.meta.outputCoverage, a.outputCoverage);
      assert.equal(a.candidates.length, 2);
      const aquiferCandidate = a.candidates.find(candidate => candidate.scopeKey === 'project:aquifer');
      assert.ok(aquiferCandidate);
      assert.equal(aquiferCandidate.memoryType, 'conclusion');
      assert.match(aquiferCandidate.canonicalKey, /tenant:tenant-a/);
      assert.match(aquiferCandidate.canonicalKey, /scope:project:aquifer/);
      assert.match(aquiferCandidate.canonicalKey, /context:none/);
      assert.match(aquiferCandidate.canonicalKey, /topic:none/);
      assert.match(aquiferCandidate.canonicalKey, new RegExp(`cadence:${cadence}`));
      assert.match(aquiferCandidate.canonicalKey, /window:2026-04-25t00:00:00.000z_2026-04-26t00:00:00.000z/);
      assert.equal(aquiferCandidate.status, 'candidate');
      assert.equal(aquiferCandidate.authority, 'system');
      assert.match(aquiferCandidate.candidateHash, /^[a-f0-9]{64}$/);
      assert.equal(aquiferCandidate.payload.candidateHash, aquiferCandidate.candidateHash);
      assert.deepEqual(aquiferCandidate.payload.sourceMemoryIds, [1, 2]);
      assert.deepEqual(aquiferCandidate.payload.sourceCanonicalKeys, [
        'decision:project:aquifer:slice5',
        'fact:project:aquifer:db:lease',
      ]);
      assert.ok(aquiferCandidate.evidenceRefs.every(ref => ref.sourceKind === 'external'));
      assert.ok(aquiferCandidate.evidenceRefs.every(ref => ref.relationKind === 'derived_from'));
      assert.equal(aquiferCandidate.summary.includes('Expired open loop'), false);
      assert.equal(aquiferCandidate.summary.includes('Superseded memory'), false);
      assert.equal(aquiferCandidate.summary.includes('Incorrect memory'), false);
      assert.equal(aquiferCandidate.summary.includes('Quarantined memory'), false);
      assert.equal(a.outputCoverage.candidateCount, 2);
    }
  });

  it('does not generate aggregate candidates for manual/session cadence or inactive-only snapshots', () => {
    const records = [{
      id: 1,
      memoryType: 'decision',
      canonicalKey: 'decision:a',
      status: 'active',
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      summary: 'Active decision',
    }];
    const window = {
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    };

    assert.deepEqual(planCompaction(records, { ...window, cadence: 'manual' }).candidates, []);
    assert.deepEqual(planCompaction(records, { ...window, cadence: 'session' }).candidates, []);
    assert.deepEqual(planCompaction([
      { ...records[0], status: 'quarantined' },
    ], { ...window, cadence: 'daily' }).candidates, []);
  });

  it('keeps aggregate canonical keys distinct by context and topic within one scope', () => {
    const plan = planCompaction([
      {
        id: 1,
        memoryType: 'decision',
        canonicalKey: 'decision:topic:a',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        contextKey: 'repo:/home/mingko/projects/aquifer',
        topicKey: 'claim-lease',
        summary: 'Lease claims use DB time.',
      },
      {
        id: 2,
        memoryType: 'decision',
        canonicalKey: 'decision:topic:b',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        contextKey: 'repo:/home/mingko/projects/aquifer',
        topicKey: 'rollup',
        summary: 'Rollup candidates stay behind promotion.',
      },
    ], {
      tenantId: 'tenant-a',
      cadence: 'weekly',
      periodStart: '2026-04-20T00:00:00Z',
      periodEnd: '2026-04-27T00:00:00Z',
      policyVersion: 'v1-rollup',
    });

    assert.equal(plan.candidates.length, 2);
    assert.equal(new Set(plan.candidates.map(candidate => candidate.canonicalKey)).size, 2);
    assert.ok(plan.candidates.some(candidate => candidate.canonicalKey.includes('topic:claim-lease')));
    assert.ok(plan.candidates.some(candidate => candidate.canonicalKey.includes('topic:rollup')));
  });

  it('old DB distillation only emits candidates with provenance and no serving visibility', () => {
    const distilled = distillArchiveSnapshot({
      sessions: [{
        sessionId: 'old-s1',
        structuredSummary: {
          decisions: ['Keep old DB out of live recall.'],
          important_facts: ['Old-only entities should return empty in curated recall.'],
        },
      }],
    });

    assert.equal(distilled.meta.bypassedPromotion, false);
    assert.equal(distilled.candidates.length, 2);
    assert.ok(distilled.candidates.every(c => c.status === 'candidate'));
    assert.ok(distilled.candidates.every(c => c.visibleInBootstrap === false));
    assert.ok(distilled.candidates.every(c => c.visibleInRecall === false));
    assert.ok(distilled.candidates.every(c => c.authority === 'raw_transcript'));
    assert.ok(distilled.candidates.every(c => c.evidenceRefs[0].sourceKind === 'external'));
  });

  it('distilled candidates still require the normal promotion gate', () => {
    const distilled = distillArchiveSnapshot({
      sessions: [{
        sessionId: 'old-s1',
        structuredSummary: { decisions: ['Keep old DB out of live recall.'] },
      }],
    }, { authority: 'llm_inference' });

    const result = assessCandidate(distilled.candidates[0]);
    assert.equal(result.action, 'quarantine');
    assert.equal(result.reason, 'insufficient_authority');
  });

  it('operator runJob dry-runs from the DB owner record path without mutating rows', async () => {
    const listed = [];
    const records = {
      async listActive(input) {
        listed.push(input);
        return [{
          id: 11,
          memory_type: 'open_loop',
          canonical_key: 'open_loop:operator:dry-run',
          status: 'active',
          scope_kind: 'project',
          scope_key: 'project:aquifer',
          summary: 'Operator dry run should plan stale open-loop closure.',
          stale_after: '2026-04-27T12:00:00Z',
        }];
      },
      updateMemoryStatusIfCurrent: async () => {
        throw new Error('dry-run must not update memory status');
      },
    };
    const consolidation = createMemoryConsolidation({
      pool: { query: async () => ({ rows: [], rowCount: 0 }) },
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records,
    });

    const result = await consolidation.runJob({
      cadence: 'daily',
      periodStart: '2026-04-27T00:00:00Z',
      periodEnd: '2026-04-28T00:00:00Z',
      activeScopeKey: 'project:aquifer',
    });

    assert.equal(result.status, 'planned');
    assert.equal(result.dryRun, true);
    assert.equal(result.plan.statusUpdates.length, 1);
    assert.deepEqual(listed[0].scopeKeys, ['project:aquifer']);
    assert.equal(listed[0].asOf, '2026-04-28T00:00:00.000Z');
  });

  it('operator window resolves closed daily weekly monthly periods from anchor time', () => {
    assert.deepEqual(resolveOperatorWindow({
      cadence: 'daily',
      anchorTime: '2026-04-28T12:34:56Z',
    }), {
      cadence: 'daily',
      periodStart: '2026-04-27T00:00:00.000Z',
      periodEnd: '2026-04-28T00:00:00.000Z',
    });
    assert.deepEqual(resolveOperatorWindow({
      cadence: 'weekly',
      anchorTime: '2026-04-30T12:34:56Z',
    }), {
      cadence: 'weekly',
      periodStart: '2026-04-20T00:00:00.000Z',
      periodEnd: '2026-04-27T00:00:00.000Z',
    });
    assert.deepEqual(resolveOperatorWindow({
      cadence: 'monthly',
      anchorTime: '2026-05-15T12:34:56Z',
    }), {
      cadence: 'monthly',
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-05-01T00:00:00.000Z',
    });
  });

  it('operator archive-distill job remains dry-run and keeps candidates invisible', async () => {
    const consolidation = createMemoryConsolidation({
      pool: { query: async () => ({ rows: [], rowCount: 0 }) },
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records: {
        async listActive() {
          throw new Error('archive-distill must not read live memory rows');
        },
      },
    });

    const result = await consolidation.runJob({
      job: 'archive-distill',
      archiveSnapshot: {
        sessions: [{
          sessionId: 'archive-1',
          structuredSummary: {
            decisions: ['Archive distill candidates stay behind promotion.'],
          },
        }],
      },
    });

    assert.equal(result.status, 'planned');
    assert.equal(result.dryRun, true);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].visibleInBootstrap, false);
    assert.equal(result.candidates[0].visibleInRecall, false);
  });

  it('operator runJob reports existing applied winner when the same snapshot was already applied', async () => {
    const rows = [{
      id: 11,
      memory_type: 'open_loop',
      canonical_key: 'open_loop:operator:idempotent',
      status: 'active',
      scope_kind: 'project',
      scope_key: 'project:aquifer',
      summary: 'Existing applied run should be returned to the operator.',
      stale_after: '2026-04-27T12:00:00Z',
    }];
    const window = resolveOperatorWindow({
      cadence: 'daily',
      periodStart: '2026-04-27T00:00:00Z',
      periodEnd: '2026-04-28T00:00:00Z',
    });
    const expectedPlan = planCompaction(rows, {
      tenantId: 'tenant-a',
      cadence: window.cadence,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      policyVersion: 'v1',
    });
    const existingRun = {
      id: 77,
      status: 'applied',
      cadence: expectedPlan.cadence,
      period_start: expectedPlan.periodStart,
      period_end: expectedPlan.periodEnd,
      input_hash: expectedPlan.inputHash,
      policy_version: 'v1',
    };
    const client = {
      async query(sql) {
        const text = String(sql);
        if (text === 'BEGIN' || text === 'COMMIT') return { rows: [], rowCount: 0 };
        if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (text.startsWith('UPDATE "aq".compaction_runs\n            SET status = \'failed\'')) {
          return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('INSERT INTO "aq".compaction_runs')) {
          return { rows: [existingRun], rowCount: 1 };
        }
        if (text.startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected sql: ${text}`);
      },
      release() {},
    };
    const pool = {
      async connect() {
        return client;
      },
      async query(sql) {
        const text = String(sql);
        if (text.startsWith('SELECT *\n         FROM "aq".compaction_runs')) {
          return { rows: [existingRun], rowCount: 1 };
        }
        throw new Error(`unexpected pool sql: ${text}`);
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records: {
        async listActive() {
          return rows;
        },
        async updateMemoryStatusIfCurrent() {
          throw new Error('existing applied winner must not re-run lifecycle mutation');
        },
      },
    });

    const result = await consolidation.runJob({
      cadence: 'daily',
      periodStart: '2026-04-27T00:00:00Z',
      periodEnd: '2026-04-28T00:00:00Z',
      apply: true,
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.skipReason, 'already_applied');
    assert.equal(result.existingRun.id, 77);
  });

  it('rejects invalid cadence and invalid period windows before planning', () => {
    assert.throws(
      () => planCompaction([], {
        cadence: 'hourly',
        periodStart: '2026-04-25T00:00:00Z',
        periodEnd: '2026-04-26T00:00:00Z',
      }),
      /invalid cadence/,
    );
    assert.throws(
      () => planCompaction([], {
        cadence: 'daily',
        periodStart: '2026-04-26T00:00:00Z',
        periodEnd: '2026-04-25T00:00:00Z',
      }),
      /periodEnd after periodStart/,
    );
  });

  it('includes deterministic source and output coverage in compaction plans', () => {
    const records = [
      {
        id: 1,
        memoryType: 'open_loop',
        canonicalKey: 'open_loop:a',
        status: 'active',
        staleAfter: '2026-04-25T00:00:00Z',
        summary: 'Follow up A',
      },
      {
        id: 2,
        memoryType: 'decision',
        canonicalKey: 'decision:b',
        status: 'active',
        summary: 'Decision B',
      },
      {
        id: 3,
        memoryType: 'open_loop',
        canonicalKey: 'open_loop:c',
        status: 'stale',
        summary: 'Already stale',
      },
    ];
    const opts = {
      cadence: 'weekly',
      periodStart: '2026-04-20T00:00:00Z',
      periodEnd: '2026-04-27T00:00:00Z',
    };

    const a = planCompaction(records, opts);
    const b = planCompaction([...records].reverse(), opts);

    assert.deepEqual(a.sourceCoverage, {
      recordCount: 3,
      activeCount: 2,
      activeOpenLoopCount: 1,
    });
    assert.deepEqual(a.outputCoverage, {
      candidateCount: 1,
      statusUpdateCount: 1,
    });
    assert.deepEqual(a.meta.outputCoverage, a.outputCoverage);
    assert.deepEqual(a.sourceCoverage, b.sourceCoverage);
    assert.deepEqual(a.outputCoverage, b.outputCoverage);
    assert.equal(a.inputHash, b.inputHash);
  });

  it('recordRun writes coverage columns and protects terminal applied rows', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [{ id: 1, status: 'applied' }], rowCount: 1 };
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
    });
    const plan = planCompaction([], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    await consolidation.recordRun({ plan, status: 'applied' });

    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /source_coverage/);
    assert.match(queries[0].sql, /output_coverage/);
    assert.match(queries[0].sql, /compaction_runs\.status IN \('applying','applied'\)/);
    assert.match(queries[0].sql, /EXCLUDED\.status <> compaction_runs\.status/);
    assert.equal(queries[0].params[10], JSON.stringify(plan.sourceCoverage));
    assert.equal(queries[0].params[11], JSON.stringify(plan.outputCoverage));
  });

  it('recordRun does not downgrade an in-flight applying claim back to planned', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [{ id: 1, status: 'applying' }], rowCount: 1 };
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
    });
    const plan = planCompaction([], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    await consolidation.recordRun({ plan, status: 'planned' });

    assert.match(queries[0].sql, /compaction_runs\.status IN \('applying','applied'\)/);
    assert.match(queries[0].sql, /THEN compaction_runs\.status/);
  });

  it('claimRun records a planned row and claims only when no live period winner exists', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (String(sql).startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return {
            rows: [{ id: 7, status: 'applying', apply_token: params[8], worker_id: params[7] }],
            rowCount: 1,
          };
        }
        return { rows: [{ id: 7, status: params[6] || 'planned' }], rowCount: 1 };
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
    });
    const plan = planCompaction([], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const claim = await consolidation.claimRun({
      plan,
      workerId: 'worker-a',
      applyToken: 'token-a',
      claimedAt: '2026-04-26T00:00:00Z',
    });

    assert.equal(claim.status, 'applying');
    assert.equal(claim.apply_token, 'token-a');
    assert.equal(queries[0].sql, 'SELECT pg_advisory_xact_lock($1, $2)');
    assert.match(queries[1].sql, /claim lease expired before finalize/);
    assert.match(queries[1].sql, /lease_expires_at < transaction_timestamp\(\)/);
    assert.equal(queries[1].params[5], 'worker-a');
    assert.match(queries[2].sql, /INSERT INTO "aq"\.compaction_runs/);
    assert.equal(queries[2].params[6], 'planned');
    assert.match(queries[3].sql, /SET status = 'applying'/);
    assert.match(queries[3].sql, /claimed_at = transaction_timestamp\(\)/);
    assert.match(queries[3].sql, /lease_expires_at = transaction_timestamp\(\) \+ \(\$7::int \* interval '1 second'\)/);
    assert.match(queries[3].sql, /cr\.status = 'planned'/);
    assert.match(queries[3].sql, /other\.status IN \('applying','applied'\)/);
    assert.equal(queries[3].params[6], 600);
    assert.equal(queries[3].params[7], 'worker-a');
    assert.equal(queries[3].params[8], 'token-a');
  });

  it('claimRun normalizes claim lease seconds before writing DB-time expiry', async () => {
    const makePool = () => ({
      queries: [],
      async query(sql, params) {
        this.queries.push({ sql, params });
        if (String(sql).startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [{ id: 7, status: 'applying', apply_token: params[8] }], rowCount: 1 };
        }
        return { rows: [{ id: 7, status: params ? params[6] : null }], rowCount: 1 };
      },
    });
    const plan = planCompaction([], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });
    const cases = [
      [{ claimLeaseSeconds: 1 }, 10],
      [{ staleAfterSeconds: 45 }, 45],
      [{ claimLeaseSeconds: 'invalid' }, 600],
    ];

    for (const [input, expected] of cases) {
      const pool = makePool();
      const consolidation = createMemoryConsolidation({
        pool,
        schema: '"aq"',
        defaultTenantId: 'tenant-a',
      });
      await consolidation.claimRun({ plan, ...input });
      const claimQuery = pool.queries.find(query =>
        String(query.sql).startsWith('UPDATE "aq".compaction_runs AS cr'));
      assert.equal(claimQuery.params[6], expected);
    }
  });

  it('claimRun can disable stale applying reclaim for lease-sensitive callers', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (String(sql).startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [{ id: 7, status: 'applying', apply_token: params[8] }], rowCount: 1 };
        }
        return { rows: [{ id: 7, status: params ? params[6] : null }], rowCount: 1 };
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
    });
    const plan = planCompaction([], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    await consolidation.claimRun({
      plan,
      reclaimStaleClaims: false,
    });

    assert.equal(queries.some(query => /claim lease expired/.test(String(query.sql))), false);
  });

  it('claimRun keeps the advisory xact lock and claim work in one DB transaction', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (String(sql).startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [{ id: 7, status: 'applying', apply_token: params[8] }], rowCount: 1 };
        }
        return { rows: [{ id: 7, status: params ? params[6] : null }], rowCount: 1 };
      },
      release() {
        queries.push({ sql: 'RELEASE', params: [] });
      },
    };
    const pool = {
      async connect() {
        queries.push({ sql: 'CONNECT', params: [] });
        return client;
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
    });
    const plan = planCompaction([], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const claim = await consolidation.claimRun({ plan, applyToken: 'token-a' });

    assert.equal(claim.status, 'applying');
    assert.equal(queries[0].sql, 'CONNECT');
    assert.equal(queries[1].sql, 'BEGIN');
    assert.equal(queries[2].sql, 'SELECT pg_advisory_xact_lock($1, $2)');
    assert.match(queries[3].sql, /claim lease expired before finalize/);
    assert.match(queries[4].sql, /INSERT INTO "aq"\.compaction_runs/);
    assert.match(queries[5].sql, /UPDATE "aq"\.compaction_runs AS cr/);
    assert.equal(queries[6].sql, 'COMMIT');
    assert.equal(queries[7].sql, 'RELEASE');
  });

  it('claimRun advisory lock is schema-scoped and canonicalizes equivalent period instants', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (String(sql).startsWith('UPDATE')) {
          return { rows: [{ id: 1, status: 'applying', apply_token: params[8] }], rowCount: 1 };
        }
        return { rows: [{ id: 1, status: params ? params[6] : null }], rowCount: 1 };
      },
    };
    const planUtc = planCompaction([], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
      policyVersion: 'v1-lock',
    });
    const planOffset = planCompaction([], {
      cadence: 'daily',
      periodStart: '2026-04-25T08:00:00+08:00',
      periodEnd: '2026-04-26T08:00:00+08:00',
      policyVersion: 'v1-lock',
    });
    const consolidationA = createMemoryConsolidation({
      pool,
      schema: '"aq_a"',
      defaultTenantId: 'tenant-a',
    });
    const consolidationB = createMemoryConsolidation({
      pool,
      schema: '"aq_b"',
      defaultTenantId: 'tenant-a',
    });

    await consolidationA.claimRun({ plan: planUtc, applyToken: 'token-a' });
    await consolidationA.claimRun({ plan: planOffset, applyToken: 'token-b' });
    await consolidationB.claimRun({ plan: planUtc, applyToken: 'token-c' });

    const lockQueries = queries.filter(query => query.sql === 'SELECT pg_advisory_xact_lock($1, $2)');
    assert.deepEqual(lockQueries[0].params, lockQueries[1].params);
    assert.notDeepEqual(lockQueries[0].params, lockQueries[2].params);
  });

  it('applyPlan retires only active open-loop status updates through CAS and records coverage', async () => {
    const calls = [];
    const rows = new Map([
      [9, { id: 9, status: 'active' }],
    ]);
    const txRecords = {
      updateMemoryStatusIfCurrent: async input => {
        calls.push(`cas:${input.memoryId}:${input.fromStatus}->${input.status}`);
        const row = rows.get(input.memoryId);
        if (!row || row.status !== input.fromStatus) return null;
        row.status = input.status;
        return row;
      },
    };
    const records = {
      updateMemoryStatusIfCurrent: txRecords.updateMemoryStatusIfCurrent,
      withTransaction: async fn => {
        calls.push('BEGIN');
        const result = await fn(txRecords);
        calls.push('COMMIT');
        return result;
      },
    };
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [{ id: 1, status: params[6] }], rowCount: 1 };
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records,
    });
    const plan = planCompaction([
      {
        id: 9,
        memoryType: 'open_loop',
        canonicalKey: 'open_loop:stale',
        status: 'active',
        staleAfter: '2026-04-25T00:00:00Z',
        summary: 'Expired loop',
      },
    ], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const first = await consolidation.applyPlan({ plan, appliedAt: '2026-04-26T00:00:00Z' });
    const second = await consolidation.applyPlan({ plan, appliedAt: '2026-04-26T00:01:00Z' });

    assert.equal(first.status, 'applied');
    assert.deepEqual(first.applyResult, {
      applied: 1,
      skipped: 0,
      unsupported: 0,
      statusUpdates: 1,
    });
    assert.equal(second.status, 'skipped');
    assert.deepEqual(second.applyResult, {
      applied: 0,
      skipped: 1,
      unsupported: 0,
      statusUpdates: 1,
    });
    assert.deepEqual(calls, [
      'BEGIN',
      'cas:9:active->stale',
      'COMMIT',
      'BEGIN',
      'cas:9:active->stale',
      'COMMIT',
    ]);
    assert.equal(JSON.parse(queries[0].params[11]).appliedStatusUpdateCount, 1);
    assert.equal(JSON.parse(queries[1].params[11]).skippedStatusUpdateCount, 1);
  });

  it('applyPlan carries aggregate candidates in run output while only mutating stale status updates', async () => {
    const calls = [];
    const rows = new Map([
      [9, { id: 9, status: 'active' }],
    ]);
    const records = {
      updateMemoryStatusIfCurrent: async input => {
        calls.push(`cas:${input.memoryId}:${input.fromStatus}->${input.status}`);
        const row = rows.get(input.memoryId);
        if (!row || row.status !== input.fromStatus) return null;
        row.status = input.status;
        return row;
      },
    };
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [{ id: 1, status: params[6] }], rowCount: 1 };
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records,
    });
    const plan = planCompaction([
      {
        id: 9,
        memoryType: 'open_loop',
        canonicalKey: 'open_loop:stale',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        staleAfter: '2026-04-25T00:00:00Z',
        summary: 'Expired loop',
      },
      {
        id: 10,
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:rollup-source',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Aggregate candidates stay behind promotion.',
      },
    ], {
      tenantId: 'tenant-a',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const result = await consolidation.applyPlan({ plan, appliedAt: '2026-04-26T00:00:00Z' });

    assert.equal(plan.candidates.length, 1);
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.applyResult, {
      applied: 1,
      skipped: 0,
      unsupported: 0,
      statusUpdates: 1,
    });
    assert.deepEqual(calls, ['cas:9:active->stale']);
    assert.equal(JSON.parse(queries[0].params[7]).candidates.length, 1);
    const outputCoverage = JSON.parse(queries[0].params[11]);
    assert.equal(outputCoverage.candidateCount, 1);
    assert.equal(outputCoverage.appliedStatusUpdateCount, 1);
  });

  it('applyPlan leaves aggregate candidates behind the promotion gate', async () => {
    const calls = [];
    const records = {
      updateMemoryStatusIfCurrent: async input => {
        calls.push(input);
        throw new Error('candidate-only plans must not mutate memory status');
      },
    };
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [{ id: 1, status: params[6] }], rowCount: 1 };
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records,
    });
    const plan = planCompaction([
      {
        id: 11,
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:promotion-gate',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Aggregate candidates require a separate promotion step.',
      },
    ], {
      tenantId: 'tenant-a',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const result = await consolidation.applyPlan({ plan, appliedAt: '2026-04-26T00:00:00Z' });

    assert.equal(plan.candidates.length, 1);
    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.applyResult, {
      applied: 0,
      skipped: 0,
      unsupported: 0,
      statusUpdates: 0,
    });
    assert.deepEqual(calls, []);
    assert.equal(JSON.parse(queries[0].params[7]).candidates.length, 1);
    assert.equal(JSON.parse(queries[0].params[11]).candidateCount, 1);
  });

  it('applyPlan records planned aggregate candidates in DB path without promotion', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        const text = String(sql);
        if (text.startsWith('INSERT INTO "aq".compaction_runs')) {
          return { rows: [{ id: 7, status: params[6] }], rowCount: 1 };
        }
        if (text.startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [{ id: 7, status: 'applying', apply_token: params[8] }], rowCount: 1 };
        }
        if (text.includes('claim lease expired before finalize')) {
          return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('INSERT INTO "aq".compaction_candidates')) {
          return { rows: [{ id: 35, action: params[4], memory_record_id: params[16] }], rowCount: 1 };
        }
        if (text.startsWith('UPDATE "aq".compaction_runs')) {
          return { rows: [{ id: params[1], status: params[3], output_coverage: JSON.parse(params[8]) }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {
        queries.push({ sql: 'RELEASE', params: [] });
      },
    };
    const pool = {
      async connect() {
        queries.push({ sql: 'CONNECT', params: [] });
        return client;
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records: { updateMemoryStatusIfCurrent: async () => null },
    });
    const plan = planCompaction([
      {
        id: 11,
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:apply-planned',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'applyPlan writes planned aggregate lineage but does not promote.',
      },
    ], {
      tenantId: 'tenant-a',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const result = await consolidation.applyPlan({
      plan,
      workerId: 'apply-worker',
      applyToken: 'apply-token',
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.candidateRows.length, 1);
    assert.equal(queries.some(query => String(query.sql).startsWith('INSERT INTO "aq".memory_records')), false);
    const candidateInsert = queries.find(query => String(query.sql).startsWith('INSERT INTO "aq".compaction_candidates'));
    assert.equal(candidateInsert.params[1], 7);
    assert.equal(candidateInsert.params[4], 'planned');
    assert.equal(candidateInsert.params[5], 'promotion_not_requested');
    assert.equal(candidateInsert.params[16], null);
    const finalize = queries.find(query =>
      String(query.sql).startsWith('UPDATE "aq".compaction_runs') &&
      !String(query.sql).includes(' AS cr') &&
      !String(query.sql).includes('claim lease expired'));
    assert.equal(JSON.parse(finalize.params[8]).plannedCandidateCount, 1);
  });

  it('applyPlan rejects DB-backed aggregate candidates without complete source memory ids', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        const text = String(sql);
        if (text.startsWith('INSERT INTO "aq".compaction_runs')) {
          return { rows: [{ id: 7, status: params[6] }], rowCount: 1 };
        }
        if (text.startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [{ id: 7, status: 'applying', apply_token: params[8] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {
        queries.push({ sql: 'RELEASE', params: [] });
      },
    };
    const pool = {
      async connect() {
        queries.push({ sql: 'CONNECT', params: [] });
        return client;
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records: { updateMemoryStatusIfCurrent: async () => null },
    });
    const plan = planCompaction([
      {
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:missing-source-id',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'DB-backed aggregate lineage requires source row ids.',
      },
    ], {
      tenantId: 'tenant-a',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    await assert.rejects(
      () => consolidation.applyPlan({ plan }),
      /requires one sourceMemoryId for each sourceCanonicalKey/,
    );
    assert.equal(queries.some(query => String(query.sql).startsWith('INSERT INTO "aq".compaction_candidates')), false);
    assert.equal(queries.some(query => query.sql === 'ROLLBACK'), true);
  });

  it('executePlan explicitly promotes aggregate candidates with compaction-run lineage', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        const text = String(sql);
        if (text.startsWith('INSERT INTO "aq".compaction_runs')) {
          return { rows: [{ id: 7, status: params[6] }], rowCount: 1 };
        }
        if (text.startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [{ id: 7, status: 'applying', apply_token: params[8], worker_id: params[7] }], rowCount: 1 };
        }
        if (text.includes('claim lease expired before finalize')) {
          return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('SELECT pg_advisory_xact_lock')) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('FROM "aq".memory_records m')) {
          return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('INSERT INTO "aq".scopes')) {
          return { rows: [{ id: 22, scope_kind: params[1], scope_key: params[2] }], rowCount: 1 };
        }
        if (text.startsWith('INSERT INTO "aq".memory_records')) {
          return { rows: [{ id: 33, status: 'active', created_by_compaction_run_id: params[25] }], rowCount: 1 };
        }
        if (text.startsWith('INSERT INTO "aq".evidence_refs')) {
          return { rows: [{ id: 34, created_by_compaction_run_id: params[9] }], rowCount: 1 };
        }
        if (text.startsWith('INSERT INTO "aq".compaction_candidates')) {
          return { rows: [{ id: 35, action: params[4], memory_record_id: params[16] }], rowCount: 1 };
        }
        if (text.startsWith('UPDATE "aq".compaction_runs')) {
          return { rows: [{ id: params[1], status: params[3], output: JSON.parse(params[4]) }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {
        queries.push({ sql: 'RELEASE', params: [] });
      },
    };
    const pool = {
      async connect() {
        queries.push({ sql: 'CONNECT', params: [] });
        return client;
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records: { updateMemoryStatusIfCurrent: async () => null },
    });
    const plan = planCompaction([
      {
        id: 11,
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:formal-promotion',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Aggregate candidates require a formal promotion operator.',
      },
    ], {
      tenantId: 'tenant-a',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const result = await consolidation.executePlan({
      plan,
      workerId: 'rollup-worker',
      applyToken: 'rollup-token',
      appliedAt: '2026-04-26T00:00:00Z',
      promoteCandidates: true,
    });

    assert.equal(result.status, 'applied');
    assert.equal(result.promotionResult.promoted, 1);
    assert.equal(result.candidateRows[0].memory_record_id, 33);
    const memoryInsert = queries.find(query => String(query.sql).startsWith('INSERT INTO "aq".memory_records'));
    const evidenceInsert = queries.find(query => String(query.sql).startsWith('INSERT INTO "aq".evidence_refs'));
    const candidateInsert = queries.find(query => String(query.sql).startsWith('INSERT INTO "aq".compaction_candidates'));
    assert.equal(memoryInsert.params[25], 7);
    assert.equal(evidenceInsert.params[9], 7);
    assert.equal(candidateInsert.params[1], 7);
    assert.equal(candidateInsert.params[4], 'promote');
    assert.equal(candidateInsert.params[16], 33);
    assert.match(queries[queries.length - 3].sql, /UPDATE "aq"\.compaction_runs/);
    assert.equal(queries[queries.length - 2].sql, 'COMMIT');
    assert.equal(queries[queries.length - 1].sql, 'RELEASE');
  });

  it('executePlan defaults aggregate candidates to planned ledger rows without promotion', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        const text = String(sql);
        if (text.startsWith('INSERT INTO "aq".compaction_runs')) {
          return { rows: [{ id: 7, status: params[6] }], rowCount: 1 };
        }
        if (text.startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [{ id: 7, status: 'applying', apply_token: params[8], worker_id: params[7] }], rowCount: 1 };
        }
        if (text.includes('claim lease expired before finalize')) {
          return { rows: [], rowCount: 0 };
        }
        if (text.startsWith('INSERT INTO "aq".compaction_candidates')) {
          return { rows: [{ id: 35, action: params[4], memory_record_id: params[16] }], rowCount: 1 };
        }
        if (text.startsWith('UPDATE "aq".compaction_runs')) {
          return { rows: [{ id: params[1], status: params[3] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {
        queries.push({ sql: 'RELEASE', params: [] });
      },
    };
    const pool = {
      async connect() {
        queries.push({ sql: 'CONNECT', params: [] });
        return client;
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records: { updateMemoryStatusIfCurrent: async () => null },
    });
    const plan = planCompaction([
      {
        id: 11,
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:planned-only',
        status: 'active',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Aggregate candidate ledger does not imply promotion.',
      },
    ], {
      tenantId: 'tenant-a',
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const result = await consolidation.executePlan({
      plan,
      workerId: 'rollup-worker',
      applyToken: 'rollup-token',
    });

    assert.equal(result.status, 'applied');
    assert.equal(result.promotionResult.planned, 1);
    assert.equal(result.promotionResult.promoted, 0);
    assert.equal(queries.some(query => String(query.sql).startsWith('INSERT INTO "aq".memory_records')), false);
    const candidateInsert = queries.find(query => String(query.sql).startsWith('INSERT INTO "aq".compaction_candidates'));
    assert.equal(candidateInsert.params[4], 'planned');
    assert.equal(candidateInsert.params[5], 'promotion_not_requested');
    assert.equal(candidateInsert.params[16], null);
  });

  it('executePlan refuses non-DB operation because promotion lineage must be transactional', async () => {
    const consolidation = createMemoryConsolidation({
      pool: { async query() { return { rows: [], rowCount: 0 }; } },
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records: { updateMemoryStatusIfCurrent: async () => null },
    });
    const plan = planCompaction([], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    await assert.rejects(
      () => consolidation.executePlan({ plan }),
      /requires DB pool transaction support/,
    );
  });

  it('applyPlan writes lifecycle update and ledger row in one DB transaction when a pool client is available', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (String(sql).startsWith('INSERT INTO "aq".compaction_runs')) {
          return { rows: [{ id: 1, status: params[6] }], rowCount: 1 };
        }
        if (String(sql).startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [{ id: 1, status: 'applying', apply_token: params[8] }], rowCount: 1 };
        }
        if (String(sql).startsWith('UPDATE "aq".memory_records')) {
          return { rows: [{ id: params[1], status: params[3] }], rowCount: 1 };
        }
        if (String(sql).startsWith('UPDATE "aq".compaction_runs')) {
          return { rows: [{ id: params[1], status: params[3] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {
        queries.push({ sql: 'RELEASE', params: [] });
      },
    };
    const pool = {
      async connect() {
        queries.push({ sql: 'CONNECT', params: [] });
        return client;
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records: { updateMemoryStatusIfCurrent: async () => null },
    });
    const plan = planCompaction([
      {
        id: 9,
        memoryType: 'open_loop',
        canonicalKey: 'open_loop:stale',
        status: 'active',
        staleAfter: '2026-04-25T00:00:00Z',
        summary: 'Expired loop',
      },
    ], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const result = await consolidation.applyPlan({ plan, appliedAt: '2026-04-26T00:00:00Z' });

    assert.equal(result.status, 'applied');
    assert.equal(queries[0].sql, 'CONNECT');
    assert.equal(queries[1].sql, 'BEGIN');
    assert.equal(queries[2].sql, 'SELECT pg_advisory_xact_lock($1, $2)');
    assert.match(queries[3].sql, /claim lease expired before finalize/);
    assert.match(queries[4].sql, /INSERT INTO "aq"\.compaction_runs/);
    assert.match(queries[5].sql, /UPDATE "aq"\.compaction_runs AS cr/);
    assert.match(queries[6].sql, /UPDATE "aq"\.memory_records/);
    assert.match(queries[6].sql, /WHERE tenant_id = \$1 AND id = \$2 AND status = \$3/);
    assert.match(queries[7].sql, /UPDATE "aq"\.compaction_runs/);
    assert.match(queries[7].sql, /AND apply_token = \$3/);
    assert.equal(queries[8].sql, 'COMMIT');
    assert.equal(queries[9].sql, 'RELEASE');
  });

  it('applyPlan skips lifecycle mutation when the compaction run cannot be claimed', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (String(sql).startsWith('UPDATE "aq".compaction_runs AS cr')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: 1, status: params ? params[6] : null }], rowCount: 1 };
      },
      release() {
        queries.push({ sql: 'RELEASE', params: [] });
      },
    };
    const pool = {
      async connect() {
        queries.push({ sql: 'CONNECT', params: [] });
        return client;
      },
    };
    const consolidation = createMemoryConsolidation({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
      records: { updateMemoryStatusIfCurrent: async () => { throw new Error('should not mutate'); } },
    });
    const plan = planCompaction([
      {
        id: 9,
        memoryType: 'open_loop',
        canonicalKey: 'open_loop:stale',
        status: 'active',
        staleAfter: '2026-04-25T00:00:00Z',
        summary: 'Expired loop',
      },
    ], {
      cadence: 'daily',
      periodStart: '2026-04-25T00:00:00Z',
      periodEnd: '2026-04-26T00:00:00Z',
    });

    const result = await consolidation.applyPlan({ plan });

    assert.equal(result.status, 'skipped');
    assert.equal(result.claim, null);
    assert.deepEqual(result.applyResult, {
      applied: 0,
      skipped: 1,
      unsupported: 0,
      statusUpdates: 1,
    });
    assert.equal(queries.some(query => /UPDATE "aq"\.memory_records/.test(String(query.sql))), false);
  });

  it('memory status CAS requires the expected current status and closes non-active visibility', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [{ id: params[1], status: params[3] }], rowCount: 1 };
      },
    };
    const records = createMemoryRecords({
      pool,
      schema: '"aq"',
      defaultTenantId: 'tenant-a',
    });

    await records.updateMemoryStatusIfCurrent({
      memoryId: 7,
      fromStatus: 'active',
      status: 'stale',
      visibleInBootstrap: true,
      visibleInRecall: true,
    });

    assert.match(queries[0].sql, /WHERE tenant_id = \$1 AND id = \$2 AND status = \$3/);
    assert.equal(queries[0].params[2], 'active');
    assert.equal(queries[0].params[3], 'stale');
    assert.equal(queries[0].params[6], false);
    assert.equal(queries[0].params[7], false);
  });
});
