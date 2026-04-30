'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assessCandidate,
  createMemoryPromotion,
  extractCandidatesFromStructuredSummary,
  defaultInheritanceForType,
} = require('../core/memory-promotion');
const { createMemoryRecords } = require('../core/memory-records');
const { recallMemoryRecords } = require('../core/memory-recall');
const { buildMemoryBootstrap } = require('../core/memory-bootstrap');

describe('v1 typed memory lifecycle', () => {
  it('extracts typed memory beyond decision/open_loop with scoped canonical keys', () => {
    const candidates = extractCandidatesFromStructuredSummary({
      sessionId: 's1',
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      contextKey: 'repo:/home/mingko/projects/aquifer',
      structuredSummary: {
        important_facts: [{ subject: 'Aquifer', statement: 'Aquifer supports curated memory records.' }],
        preferences: ['Use Traditional Chinese for MK-facing briefings.'],
        constraints: ['Recall must not read raw transcripts.'],
        conclusions: ['Slice 4 is the first normal-use threshold.'],
      },
    });

    assert.deepEqual(
      candidates.map(c => c.memoryType).sort(),
      ['conclusion', 'constraint', 'fact', 'preference'].sort(),
    );
    assert.ok(candidates.every(c => c.scopeKey === 'project:aquifer'));
    assert.ok(candidates.every(c => c.canonicalKey.includes('project:aquifer|repo:/home/mingko/projects/aquifer')));
  });

  it('uses subject and aspect as typed identity when both are explicit', () => {
    const candidates = extractCandidatesFromStructuredSummary({
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      structuredSummary: {
        facts: [
          { subject: 'Aquifer', aspect: 'source_of_truth', statement: 'Source of truth is memory_records.' },
          { subject: 'Aquifer', aspect: 'source_of_truth', statement: 'Source of truth is session_summaries.' },
        ],
      },
    });

    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].canonicalKey, candidates[1].canonicalKey);
  });

  it('uses deterministic inheritance defaults by memory type', () => {
    assert.equal(defaultInheritanceForType('constraint'), 'additive');
    assert.equal(defaultInheritanceForType('preference'), 'defaultable');
    assert.equal(defaultInheritanceForType('decision'), 'non_inheritable');
    assert.equal(defaultInheritanceForType('open_loop'), 'non_inheritable');
  });

  it('does not silently merge same-authority conflicts', () => {
    const result = assessCandidate({
      memoryType: 'fact',
      canonicalKey: 'fact:project:aquifer:storage',
      scopeKey: 'project:aquifer',
      summary: 'Aquifer source of truth is memory_records.',
      authority: 'verified_summary',
      evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 's2' }],
    }, {
      existingActiveRecords: [{
        id: 7,
        canonicalKey: 'fact:project:aquifer:storage',
        summary: 'Aquifer source of truth is session_summaries.',
        authority: 'verified_summary',
      }],
    });

    assert.equal(result.action, 'quarantine');
    assert.equal(result.reason, 'unresolved_active_conflict');
  });

  it('allows higher authority to supersede a lower authority conflict', () => {
    const result = assessCandidate({
      memoryType: 'fact',
      canonicalKey: 'fact:project:aquifer:storage',
      scopeKey: 'project:aquifer',
      summary: 'Aquifer source of truth is memory_records.',
      authority: 'executable_evidence',
      evidenceRefs: [{ sourceKind: 'external', sourceRef: 'schema/007-v1-foundation.sql' }],
    }, {
      existingActiveRecords: [{
        id: 7,
        canonicalKey: 'fact:project:aquifer:storage',
        summary: 'Aquifer source of truth is session_summaries.',
        authority: 'verified_summary',
      }],
    });

    assert.equal(result.action, 'promote');
    assert.equal(result.reason, 'higher_authority_supersedes');
    assert.equal(result.supersedeId, 7);
  });

  it('records supersede chain when higher authority replaces active memory', async () => {
    const updates = [];
    const promotion = createMemoryPromotion({
      records: {
        findActiveByCanonicalKey: async () => [{
          id: 7,
          canonicalKey: 'fact:project:aquifer:storage',
          summary: 'Aquifer source of truth is session_summaries.',
          authority: 'verified_summary',
        }],
        upsertScope: async () => ({ id: 11 }),
        upsertMemory: async input => ({ id: 12, ...input }),
        updateMemoryStatus: async input => {
          updates.push(input);
          return input;
        },
        linkEvidence: async () => null,
      },
    });

    const results = await promotion.promote([{
      memoryType: 'fact',
      canonicalKey: 'fact:project:aquifer:storage',
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      summary: 'Aquifer source of truth is memory_records.',
      authority: 'executable_evidence',
      evidenceRefs: [{ sourceKind: 'external', sourceRef: 'schema/007-v1-foundation.sql' }],
    }], { acceptedAt: '2026-04-26T00:00:00Z' });

    assert.equal(results[0].action, 'promote');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].memoryId, 7);
    assert.equal(updates[0].status, 'superseded');
    assert.equal(updates[1].supersededBy, 12);
    assert.equal(updates[1].validTo, '2026-04-26T00:00:00Z');
  });

  it('writes structured fact assertions and links memory_records.backing_fact_id', async () => {
    const calls = [];
    const promotion = createMemoryPromotion({
      records: {
        findActiveByCanonicalKey: async () => [],
        findActiveFactByCanonicalKey: async input => {
          calls.push(`findFact:${input.canonicalKey}`);
          return [];
        },
        upsertScope: async () => ({ id: 11 }),
        upsertFactAssertion: async input => {
          calls.push(`fact:${input.scopeId}:${input.predicate}:${input.objectKind}`);
          return { id: 99, ...input };
        },
        upsertMemory: async input => {
          calls.push(`memory:${input.backingFactId}:${input.observedAt}`);
          return { id: 12, ...input };
        },
        linkEvidence: async () => null,
      },
    });

    const results = await promotion.promote([{
      memoryType: 'fact',
      canonicalKey: 'fact:project:aquifer:storage',
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      summary: 'Aquifer source of truth is memory_records.',
      payload: {
        subject: 'Aquifer',
        aspect: 'source_of_truth',
        statement: 'Aquifer source of truth is memory_records.',
        observed_at: '2026-04-26T00:00:00Z',
      },
      authority: 'verified_summary',
      evidenceRefs: [{ sourceKind: 'external', sourceRef: 'schema/007-v1-foundation.sql' }],
    }], { tenantId: 'tenant-a', acceptedAt: '2026-04-26T00:00:00Z' });

    assert.equal(results[0].action, 'promote');
    assert.deepEqual(calls, [
      'findFact:fact:project:aquifer:storage',
      'fact:11:source_of_truth:value',
      'memory:99:2026-04-26T00:00:00Z',
    ]);
    assert.equal(results[0].memory.backingFactId, 99);
  });

  it('writes per-memory embeddings from row text when promotion has an embedFn', async () => {
    const calls = [];
    const promotion = createMemoryPromotion({
      embedFn: async texts => {
        calls.push(texts);
        return [[0.11, 0.22, 0.33]];
      },
      records: {
        findActiveByCanonicalKey: async () => [],
        upsertScope: async () => ({ id: 11 }),
        upsertMemory: async input => ({ id: 12, ...input }),
        linkEvidence: async () => null,
      },
    });

    const results = await promotion.promote([{
      memoryType: 'decision',
      canonicalKey: 'decision:project:aquifer:embedding-write',
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      contextKey: 'repo:/home/mingko/projects/aquifer',
      topicKey: 'current-memory',
      title: 'Current-memory query contract',
      summary: 'Direct memory embeddings should anchor curated recall.',
      authority: 'verified_summary',
      evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 's1' }],
    }], { tenantId: 'tenant-a' });

    assert.equal(results[0].action, 'promote');
    assert.deepEqual(calls, [[
      'title: Current-memory query contract\n'
      + 'summary: Direct memory embeddings should anchor curated recall.\n'
      + 'context: repo:/home/mingko/projects/aquifer\n'
      + 'topic: current-memory',
    ]]);
    assert.deepEqual(results[0].memory.embedding, [0.11, 0.22, 0.33]);
  });

  it('wraps promote lifecycle in one transaction and locks canonical identity', async () => {
    const calls = [];
    const txRecords = {
      lockCanonicalKey: async input => {
        calls.push(`lock:${input.tenantId}:${input.canonicalKey}`);
      },
      findActiveByCanonicalKey: async input => {
        calls.push(`find:${input.forUpdate}`);
        return [{
          id: 7,
          canonicalKey: 'fact:project:aquifer:storage',
          summary: 'Aquifer source of truth is session_summaries.',
          authority: 'verified_summary',
        }];
      },
      upsertScope: async input => {
        calls.push(`scope:${input.scopeKey}`);
        return { id: 11 };
      },
      upsertMemory: async input => {
        calls.push(`memory:${input.scopeId}`);
        return { id: 12, ...input };
      },
      updateMemoryStatus: async input => {
        calls.push(`update:${input.memoryId}:${input.status}:${input.supersededBy || ''}`);
        return input;
      },
      linkEvidence: async input => {
        calls.push(`evidence:${input.ownerId}:${input.sourceRef}`);
      },
    };
    const promotion = createMemoryPromotion({
      records: {
        withTransaction: async fn => {
          calls.push('BEGIN');
          const result = await fn(txRecords, { transactional: true });
          calls.push('COMMIT');
          return result;
        },
      },
    });

    const results = await promotion.promote([{
      memoryType: 'fact',
      canonicalKey: 'fact:project:aquifer:storage',
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      summary: 'Aquifer source of truth is memory_records.',
      authority: 'executable_evidence',
      evidenceRefs: [{ sourceKind: 'external', sourceRef: 'schema/007-v1-foundation.sql' }],
    }], { tenantId: 'tenant-a', acceptedAt: '2026-04-26T00:00:00Z' });

    assert.equal(results[0].action, 'promote');
    assert.deepEqual(calls, [
      'BEGIN',
      'lock:tenant-a:fact:project:aquifer:storage',
      'find:true',
      'update:7:superseded:',
      'scope:project:aquifer',
      'memory:11',
      'update:7:superseded:12',
      'evidence:12:schema/007-v1-foundation.sql',
      'COMMIT',
    ]);
  });

  it('rolls back supersede and insert work when evidence linking fails', async () => {
    const calls = [];
    const clone = value => JSON.parse(JSON.stringify(value));
    let committed = {
      scopes: [],
      memories: [{
        id: 7,
        canonicalKey: 'fact:project:aquifer:storage',
        summary: 'Aquifer source of truth is session_summaries.',
        authority: 'verified_summary',
        status: 'active',
      }],
      evidenceRefs: [],
    };
    const createTxRecords = staged => ({
      lockCanonicalKey: async () => calls.push('lock'),
      findActiveByCanonicalKey: async () => staged.memories.filter(memory =>
        memory.canonicalKey === 'fact:project:aquifer:storage' && memory.status === 'active'),
      upsertScope: async input => {
        calls.push('scope');
        const scope = { id: 11, ...input };
        staged.scopes.push(scope);
        return scope;
      },
      upsertMemory: async input => {
        calls.push('memory');
        const memory = { id: 12, ...input };
        staged.memories.push(memory);
        return memory;
      },
      updateMemoryStatus: async input => {
        calls.push(`update:${input.supersededBy || 'pending'}`);
        const memory = staged.memories.find(item => item.id === input.memoryId);
        Object.assign(memory, {
          status: input.status,
          supersededBy: input.supersededBy || memory.supersededBy || null,
          validTo: input.validTo || memory.validTo || null,
        });
        return memory;
      },
      linkEvidence: async input => {
        calls.push('evidence');
        staged.evidenceRefs.push(input);
        throw new Error('link failed');
      },
    });
    const promotion = createMemoryPromotion({
      records: {
        withTransaction: async fn => {
          calls.push('BEGIN');
          const staged = clone(committed);
          try {
            const result = await fn(createTxRecords(staged), { transactional: true });
            committed = staged;
            calls.push('COMMIT');
            return result;
          } catch (error) {
            calls.push('ROLLBACK');
            throw error;
          }
        },
      },
    });

    await assert.rejects(
      () => promotion.promote([{
        memoryType: 'fact',
        canonicalKey: 'fact:project:aquifer:storage',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        summary: 'Aquifer source of truth is memory_records.',
        authority: 'executable_evidence',
        evidenceRefs: [{ sourceKind: 'external', sourceRef: 'schema/007-v1-foundation.sql' }],
      }]),
      /link failed/,
    );

    assert.deepEqual(calls, [
      'BEGIN',
      'lock',
      'update:pending',
      'scope',
      'memory',
      'update:12',
      'evidence',
      'ROLLBACK',
    ]);
    assert.deepEqual(committed, {
      scopes: [],
      memories: [{
        id: 7,
        canonicalKey: 'fact:project:aquifer:storage',
        summary: 'Aquifer source of truth is session_summaries.',
        authority: 'verified_summary',
        status: 'active',
      }],
      evidenceRefs: [],
    });
  });

  it('memory records transaction wrapper rolls back and locks active lookup', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (String(sql).includes('SELECT m.*')) throw new Error('lookup failed');
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
    const records = createMemoryRecords({ pool, schema: '"aq"', defaultTenantId: 'default' });

    await assert.rejects(
      () => records.withTransaction(async txRecords => {
        await txRecords.lockCanonicalKey({ canonicalKey: 'fact:project:aquifer:storage' });
        await txRecords.findActiveByCanonicalKey({
          canonicalKey: 'fact:project:aquifer:storage',
          forUpdate: true,
        });
      }),
      /lookup failed/,
    );

    const sqls = queries.map(query => query.sql);
    assert.equal(sqls[0], 'CONNECT');
    assert.equal(sqls[1], 'BEGIN');
    assert.match(sqls[2], /pg_advisory_xact_lock/);
    assert.match(sqls[3], /FOR UPDATE OF m/);
    assert.equal(sqls[4], 'ROLLBACK');
    assert.equal(sqls[5], 'RELEASE');
  });

  it('respects valid time and stale time in recall and bootstrap asOf queries', () => {
    const records = [
      {
        id: 'future',
        memoryType: 'fact',
        canonicalKey: 'fact:future',
        scopeKey: 'project:aquifer',
        inheritanceMode: 'defaultable',
        status: 'active',
        visibleInRecall: true,
        visibleInBootstrap: true,
        validFrom: '2026-05-01T00:00:00Z',
        summary: 'Future fact about curated memory.',
      },
      {
        id: 'current',
        memoryType: 'fact',
        canonicalKey: 'fact:current',
        scopeKey: 'project:aquifer',
        inheritanceMode: 'defaultable',
        status: 'active',
        visibleInRecall: true,
        visibleInBootstrap: true,
        validFrom: '2026-04-01T00:00:00Z',
        staleAfter: '2026-05-01T00:00:00Z',
        summary: 'Current fact about curated memory.',
      },
    ];

    const recall = recallMemoryRecords(records, 'curated memory', { asOf: '2026-04-26T00:00:00Z' });
    assert.deepEqual(recall.map(r => r.id), ['current']);

    const bootstrap = buildMemoryBootstrap(records, {
      asOf: '2026-04-26T00:00:00Z',
      activeScopePath: ['global', 'project:aquifer'],
    });
    assert.deepEqual(bootstrap.memories.map(r => r.id), ['current']);
  });
});
