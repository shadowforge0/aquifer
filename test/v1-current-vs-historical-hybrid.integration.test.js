'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');

const { createAquifer } = require('../index');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('v1 current vs historical hybrid integration tests');

function randomSchema() {
  return `aquifer_hybrid_sep_${crypto.randomBytes(4).toString('hex')}`;
}

async function embedTexts(texts) {
  return texts.map((text) => {
    const lower = String(text || '').toLowerCase();
    const vec = new Array(1024).fill(0);
    vec[0] = lower.includes('two-layer recall contract') ? 1 : 0.4;
    vec[1] = lower.includes('historical') ? 0.8 : 0.2;
    vec[2] = lower.includes('current memory') ? 0.9 : 0.1;
    return vec;
  });
}

if (DB_URL) {
  describe('v1 current vs historical hybrid separation', () => {
    let schema;
    let pool;
    let aq;

    before(async () => {
      schema = randomSchema();
      pool = new Pool({ connectionString: DB_URL });
      aq = createAquifer({
        db: DB_URL,
        schema,
        tenantId: 'test',
        embed: { fn: embedTexts, dim: 1024 },
        memory: {
          servingMode: 'curated',
          activeScopeKey: 'project:aquifer',
          activeScopePath: ['global', 'project:aquifer'],
        },
      });

      await aq.init();

      const seedHistoricalSummary = async ({
        sessionId,
        title,
        summaryText,
        transcriptText,
        agentId = 'main',
        startedAt,
      }) => {
        await aq.commit(sessionId, [
          { role: 'user', content: transcriptText },
          { role: 'assistant', content: summaryText },
        ], { agentId, source: 'integration-test', startedAt });
        await aq.enrich(sessionId, {
          agentId,
          summaryFn: async () => ({
            summaryText,
            structuredSummary: {
              title,
              overview: summaryText,
              topics: [],
              decisions: [],
              open_loops: [],
            },
          }),
        });
      };

      await aq.commit('hist-linked-001', [
        { role: 'user', content: 'Promote the two-layer recall contract into current memory.' },
        { role: 'assistant', content: 'The promoted source session explains why current memory and historical recall stay separate.' },
      ], { agentId: 'hybrid-sep', source: 'integration-test' });
      await aq.enrich('hist-linked-001', {
        agentId: 'hybrid-sep',
        summaryFn: async () => ({
          summaryText: 'The two-layer recall contract was promoted into current memory.',
          structuredSummary: {
            title: 'Linked historical source',
            overview: 'The two-layer recall contract was promoted into current memory.',
            topics: [],
            decisions: [],
            open_loops: [],
          },
        }),
      });

      await aq.commit('hist-unlinked-001', [
        { role: 'user', content: 'Keep this raw two-layer recall contract detail only in history.' },
        { role: 'assistant', content: 'This session stays unpromoted and must not surface as current truth.' },
      ], { agentId: 'hybrid-sep', source: 'integration-test' });
      await aq.enrich('hist-unlinked-001', {
        agentId: 'hybrid-sep',
        summaryFn: async () => ({
          summaryText: 'The two-layer recall contract remains only in this historical session summary and was never promoted.',
          structuredSummary: {
            title: 'Unlinked historical session',
            overview: 'The two-layer recall contract remains only in this historical session summary and was never promoted.',
            topics: [],
            decisions: [],
            open_loops: [],
          },
        }),
      });

      await seedHistoricalSummary({
        sessionId: 'hist-real-002',
        title: 'Historical current-memory layer note',
        summaryText: 'Aquifer current memory layer stays on curated rows; session summary process material belongs to the historical hybrid lane.',
        transcriptText: 'Aquifer historical recall explains that current memory layer and session summary process material stay separated.',
        startedAt: '2026-04-30T01:00:00.000Z',
      });
      await seedHistoricalSummary({
        sessionId: 'meta-current',
        title: '空測試會話',
        summaryText: '空測試會話 current memory layer session summary process material placeholder.',
        transcriptText: '空測試會話 current memory layer session summary process material placeholder.',
        startedAt: '2026-04-30T01:05:00.000Z',
      });
      await seedHistoricalSummary({
        sessionId: 'meta-eligible-a',
        title: '測試會話無實質內容',
        summaryText: '測試會話無實質內容 current memory layer session summary process material.',
        transcriptText: '測試會話無實質內容 current memory layer session summary process material.',
        startedAt: '2026-04-30T01:06:00.000Z',
      });
      await seedHistoricalSummary({
        sessionId: 'meta-eligible-b',
        title: 'placeholder filler',
        summaryText: 'placeholder x 字元填充 current memory layer session summary process material.',
        transcriptText: 'placeholder x 字元填充 current memory layer session summary process material.',
        startedAt: '2026-04-30T01:07:00.000Z',
      });

      const scope = await aq.memory.upsertScope({
        tenantId: 'test',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        inheritanceMode: 'defaultable',
      });

      await aq.memory.promote([{
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:two-layer-recall',
        scopeId: scope.id,
        title: 'Two-layer recall contract',
        summary: 'Current memory stays on promoted rows and does not substitute raw historical summaries.',
        authority: 'verified_summary',
        evidenceText: 'The two-layer recall contract is the active current-memory rule for Aquifer.',
        evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 'hist-linked-001', relationKind: 'primary' }],
      }, {
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:current-memory-layer',
        scopeId: scope.id,
        title: 'Current memory layer query contract',
        summary: 'Aquifer current memory layer stays on curated rows and does not treat session summary process material as current truth.',
        authority: 'verified_summary',
        evidenceText: 'Current memory query layering keeps session summary process material on the historical lane.',
        evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 'hist-real-002', relationKind: 'primary' }],
      }], { tenantId: 'test' });
    });

    after(async () => {
      await aq?.close?.().catch(() => {});
      await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool?.end?.().catch(() => {});
    });

    it('serves only promoted current-memory rows even when unlinked historical summaries share the phrase', async () => {
      const rows = await aq.recall('two-layer recall contract', {
        activeScopeKey: 'project:aquifer',
        activeScopePath: ['global', 'project:aquifer'],
        mode: 'hybrid',
        limit: 5,
      });

      assert.ok(rows.some(row => row.canonicalKey === 'decision:project:aquifer:two-layer-recall'));
      assert.equal(rows.every(row => row.feedbackTarget.kind === 'memory_feedback'), true);
      assert.equal(rows.every(row => row.sessionId === undefined), true);
      assert.equal(rows.some(row => /hist-unlinked-001/.test(JSON.stringify(row))), false);
    });

    it('keeps the unlinked historical session on the explicit historical recall plane', async () => {
      const rows = await aq.historicalRecall('two-layer recall contract', {
        agentId: 'hybrid-sep',
        mode: 'hybrid',
        limit: 5,
      });
      const sessionIds = rows.map(row => row.sessionId);

      assert.ok(sessionIds.includes('hist-unlinked-001'));
      assert.ok(rows.every(row => row.feedbackTarget?.kind !== 'memory_feedback'));
      assert.equal(rows.some(row => row.canonicalKey === 'decision:project:aquifer:two-layer-recall'), false);
    });

    it('keeps current-memory hybrid clean while excluding placeholder sessions from historical hybrid results', async () => {
      const currentRows = await aq.memoryRecall('current memory layer session summary process material', {
        activeScopeKey: 'project:aquifer',
        activeScopePath: ['global', 'project:aquifer'],
        mode: 'hybrid',
        limit: 5,
      });
      const historicalRows = await aq.historicalRecall('current memory layer session summary process material', {
        agentId: 'main',
        mode: 'hybrid',
        limit: 10,
      });

      assert.equal(currentRows[0].canonicalKey, 'decision:project:aquifer:current-memory-layer');
      assert.equal(currentRows.every(row => row.feedbackTarget?.kind === 'memory_feedback'), true);
      assert.equal(currentRows.some(row => /meta-current|meta-eligible-a|meta-eligible-b/.test(JSON.stringify(row))), false);

      const historicalSessionIds = historicalRows.map(row => row.sessionId);
      assert.ok(historicalSessionIds.includes('hist-real-002'));
      assert.equal(historicalSessionIds.includes('meta-current'), false);
      assert.equal(historicalSessionIds.includes('meta-eligible-a'), false);
      assert.equal(historicalSessionIds.includes('meta-eligible-b'), false);
      assert.equal(
        historicalRows.some(row => /空測試會話|測試會話無實質內容|placeholder|x 字元填充/.test(JSON.stringify(row))),
        false,
      );
    });

    it('does not use linked historical summary text as current-memory corpus when the row omits the query', async () => {
      await aq.commit('hist-linked-sentinel-001', [
        { role: 'user', content: 'The raw historical-only note contains sentinel delta phrase for lane separation.' },
        { role: 'assistant', content: 'Keep sentinel delta phrase on the historical plane only.' },
      ], { agentId: 'hybrid-sep', source: 'integration-test' });
      await aq.enrich('hist-linked-sentinel-001', {
        agentId: 'hybrid-sep',
        summaryFn: async () => ({
          summaryText: 'The historical summary contains sentinel delta phrase and should stay out of current-memory corpus.',
          structuredSummary: {
            title: 'Linked sentinel historical source',
            overview: 'The historical summary contains sentinel delta phrase and should stay out of current-memory corpus.',
            topics: [],
            decisions: [],
            open_loops: [],
          },
        }),
      });

      const scope = await aq.memory.upsertScope({
        tenantId: 'test',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        inheritanceMode: 'defaultable',
      });
      const memory = await aq.memory.upsertMemory({
        tenantId: 'test',
        scopeId: scope.id,
        memoryType: 'decision',
        canonicalKey: 'decision:project:aquifer:linked-sentinel-boundary',
        title: 'Linked source boundary',
        summary: 'Distilled current row keeps raw source wording out of the recall corpus.',
        authority: 'verified_summary',
        status: 'active',
        visibleInRecall: true,
        visibleInBootstrap: true,
        acceptedAt: '2026-04-30T03:00:00.000Z',
      });
      await aq.memory.linkEvidence({
        tenantId: 'test',
        ownerKind: 'memory_record',
        ownerId: memory.id,
        sourceKind: 'session_summary',
        sourceRef: 'hist-linked-sentinel-001',
        relationKind: 'primary',
      });

      const currentRows = await aq.memoryRecall('sentinel delta phrase', {
        activeScopeKey: 'project:aquifer',
        activeScopePath: ['global', 'project:aquifer'],
        mode: 'fts',
        limit: 5,
      });
      const historicalRows = await aq.historicalRecall('sentinel delta phrase', {
        agentId: 'hybrid-sep',
        mode: 'fts',
        limit: 5,
      });

      assert.equal(
        currentRows.some(row => row.canonicalKey === 'decision:project:aquifer:linked-sentinel-boundary'),
        false,
      );
      assert.ok(historicalRows.some(row => row.sessionId === 'hist-linked-sentinel-001'));
    });

    it('excludes placeholder sessions from explicit evidence/historical public results while keeping the real historical hit', async () => {
      const evidenceRows = await aq.evidenceRecall('current memory layer session summary process material', {
        agentId: 'main',
        mode: 'hybrid',
        limit: 10,
      });
      const sessionIds = evidenceRows.map(row => row.sessionId);

      assert.ok(sessionIds.includes('hist-real-002'));
      assert.equal(sessionIds.includes('meta-current'), false);
      assert.equal(sessionIds.includes('meta-eligible-a'), false);
      assert.equal(sessionIds.includes('meta-eligible-b'), false);
      assert.equal(
        evidenceRows.some(row => /空測試會話|測試會話無實質內容|placeholder|x 字元填充/.test(JSON.stringify(row))),
        false,
      );
    });
  });
}
