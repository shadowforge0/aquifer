'use strict';

/**
 * DB-backed Codex recovery smoke:
 * consented recovery prompt -> finalizeSession -> curated bootstrap serving.
 *
 * Run with:
 *   AQUIFER_TEST_DB_URL="postgresql://..." node --test test/codex-finalization-serving.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

const { createAquifer } = require('../index');
const codex = require('../consumers/codex');
const handoff = require('../consumers/codex-handoff');
const { createMemoryRecords } = require('../core/memory-records');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('Codex finalization serving integration tests');

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

if (DB_URL) {
  describe('Codex finalization DB-backed serving smoke', () => {
    const schema = `codex_finalization_${Date.now()}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquifer-codex-serving-'));
    let pool;
    let aq;
    let records;

    before(async () => {
      pool = new Pool({ connectionString: DB_URL });
      aq = createAquifer({
        db: DB_URL,
        schema,
        tenantId: 'test',
        memory: { servingMode: 'curated' },
      });
      await aq.init();
      records = createMemoryRecords({
        pool,
        schema: `"${schema}"`,
        defaultTenantId: 'test',
      });
    });

    after(async () => {
      await aq?.close?.().catch(() => {});
      await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool?.end?.().catch(() => {});
    });

    it('serves memory promoted by Codex recovery finalization from DB bootstrap', async () => {
      const file = path.join(root, 'rollout-codex-serving.jsonl');
      writeJsonl(file, [
        { type: 'session_meta', payload: { id: 'codex-serving-smoke' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Aquifer recovery smoke start.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tracking DB finalization.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Decision: Codex recovery finalization must be visible through curated bootstrap.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will promote that as verified summary memory.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Close the loop with DB-backed serving smoke.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finalization should now populate memory_records.' }] } },
      ]);

      const view = codex.materializeRecoveryTranscriptView({ filePath: file }, {
        maxRecoveryBytes: 1024 * 1024,
      });
      assert.equal(view.status, 'ok');

      const scope = await aq.memory.upsertScope({
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
      });
      await aq.memory.upsertMemory({
        memoryType: 'state',
        canonicalKey: 'state:codex-serving-smoke:current-memory-input',
        scopeId: scope.id,
        summary: 'Existing DB current memory is available before recovery finalization.',
        status: 'active',
        authority: 'verified_summary',
        visibleInBootstrap: true,
        visibleInRecall: true,
      });

      const finalized = await codex.finalizeCodexSession(aq, {
        view,
        mode: 'session_start_recovery',
        summaryText: 'Codex recovery finalization produced curated memory for DB-backed serving.',
        structuredSummary: {
          decisions: [{
            decision: 'Codex recovery finalization must be visible through curated bootstrap.',
            reason: 'This is the DB-backed serving smoke for SessionStart recovery.',
          }],
        },
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
      }, {
        agentId: 'main',
        source: 'codex',
        sessionKey: 'codex:recovery:smoke',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        activeScopePath: ['global', 'project:aquifer'],
        activeScopeKey: 'project:aquifer',
      });

      assert.equal(finalized.status, 'finalized');
      assert.equal(finalized.finalization.memoryResult.promoted, 1);

      const finalizationRow = await aq.finalization.get({
        sessionId: 'codex-serving-smoke',
        agentId: 'main',
        source: 'codex',
        transcriptHash: view.transcriptHash,
      });
      assert.equal(finalizationRow.status, 'finalized');
      assert.equal(finalizationRow.metadata.currentMemory.meta.servingContract, 'current_memory_v1');
      assert.equal(
        finalizationRow.metadata.currentMemory.memories.some(
          row => row.summary === 'Existing DB current memory is available before recovery finalization.',
        ),
        true,
      );
      assert.match(finalizationRow.session_start_text, /下一段只需要帶/);
      assert.match(finalizationRow.session_start_text, /Codex recovery finalization must be visible through curated bootstrap/);
      assert.doesNotMatch(finalizationRow.session_start_text, /transcriptHash|sessionId|DB Write Plan|raw JSON|message count/);

      const bootstrap = await aq.bootstrap({
        activeScopePath: ['global', 'project:aquifer'],
        format: 'text',
        maxChars: 2000,
      });

      assert.match(bootstrap.text, /memory-bootstrap/);
      assert.match(bootstrap.text, /Codex recovery finalization must be visible through curated bootstrap/);
    });

    it('injects DB current memory into consented recovery prompt before agent summary', async () => {
      const sessionsDir = path.join(root, 'recovery-prompt-sessions');
      const stateDir = path.join(root, 'recovery-prompt-state');
      const file = path.join(sessionsDir, 'rollout-codex-recovery-prompt.jsonl');
      writeJsonl(file, [
        { type: 'session_meta', payload: { id: 'codex-recovery-prompt-smoke' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Aquifer recovery prompt smoke start.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tracking prompt current memory.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Decision: recovery prompt must include current memory.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The prompt should reconcile against committed memory.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Verify current memory enters the finalization prompt.' } },
      ]);

      const scope = await aq.memory.upsertScope({
        scopeKind: 'project',
        scopeKey: 'project:aquifer-recovery-prompt',
      });
      await aq.memory.upsertMemory({
        memoryType: 'state',
        canonicalKey: 'state:codex-recovery-prompt:current',
        scopeId: scope.id,
        summary: 'Existing recovery prompt current memory comes from memory_records.',
        status: 'active',
        authority: 'verified_summary',
        visibleInBootstrap: true,
        visibleInRecall: true,
      });

      const prepared = await codex.prepareSessionStartRecovery(aq, {
        sessionsDir,
        stateDir,
        includeJsonlPreviews: true,
        minSessionBytes: 1,
        idleMs: 0,
        excludeNewest: false,
        consent: true,
        activeScopePath: ['global', 'project:aquifer-recovery-prompt'],
        activeScopeKey: 'project:aquifer-recovery-prompt',
        scopeKind: 'project',
        scopeKey: 'project:aquifer-recovery-prompt',
      });

      assert.equal(prepared.status, 'needs_agent_summary');
      assert.equal(prepared.currentMemory.meta.servingContract, 'current_memory_v1');
      assert.match(prepared.prompt, /<current_memory/);
      assert.match(prepared.prompt, /Existing recovery prompt current memory comes from memory_records/);
      assert.doesNotMatch(prepared.prompt, /AQUIFER CONTEXT|session_summaries/);
    });

    it('serves memory promoted by Codex handoff finalization from the same core surface', async () => {
      const file = path.join(root, 'rollout-codex-handoff.jsonl');
      writeJsonl(file, [
        { type: 'session_meta', payload: { id: 'codex-handoff-smoke' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Aquifer handoff smoke start.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tracking handoff finalization.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Decision: Codex handoff finalization must use the shared core serving surface.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will finalize through core.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Open loop: verify handoff SessionStart minimal context.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The handoff wrapper should not create a second semantics.' }] } },
      ]);

      const view = codex.materializeRecoveryTranscriptView({ filePath: file }, {
        maxRecoveryBytes: 1024 * 1024,
      });
      assert.equal(view.status, 'ok');

      const scope = await aq.memory.upsertScope({
        scopeKind: 'project',
        scopeKey: 'project:aquifer-handoff',
      });
      await aq.memory.upsertMemory({
        memoryType: 'state',
        canonicalKey: 'state:codex-handoff-smoke:current-memory-input',
        scopeId: scope.id,
        summary: 'Existing handoff current memory is captured in finalization metadata.',
        status: 'active',
        authority: 'verified_summary',
        visibleInBootstrap: true,
        visibleInRecall: true,
      });

      const result = await handoff.finalizeHandoff(aq, {
        title: 'Codex handoff DB smoke',
        overview: 'Payload-only overview must remain metadata, not promoted memory.',
        next: 'Payload-only next step must not become the sole SessionStart source.',
      }, {
        view,
        summaryText: 'Codex handoff finalization produced curated memory for DB-backed serving.',
        structuredSummary: {
          decisions: [{
            decision: 'Codex handoff finalization must use the shared core serving surface.',
            reason: 'This proves non-recovery trigger parity.',
          }],
          open_loops: [{
            item: 'verify handoff SessionStart minimal context',
            owner: 'Miranda',
          }],
        },
        agentId: 'main',
        source: 'codex-wrapper',
        sessionKey: 'codex:wrapper:handoff',
        scopeKind: 'project',
        scopeKey: 'project:aquifer-handoff',
        activeScopePath: ['global', 'project:aquifer-handoff'],
        activeScopeKey: 'project:aquifer-handoff',
      });

      assert.equal(result.status, 'finalized');
      assert.equal(result.memoryResult.promoted, 2);
      assert.match(result.reviewText, /已整理進 DB/);
      assert.match(result.reviewText, /Codex handoff finalization must use the shared core serving surface/);
      assert.match(result.sessionStartText, /verify handoff SessionStart minimal context/);
      assert.match(result.sessionStartText, /Codex handoff finalization must use the shared core serving surface/);
      assert.doesNotMatch(result.sessionStartText, /Payload-only overview|Payload-only next step|sessionId|transcriptHash/);

      const finalizationRow = await aq.finalization.get({
        sessionId: 'codex-handoff-smoke',
        agentId: 'main',
        source: 'codex-wrapper',
        transcriptHash: view.transcriptHash,
      });
      assert.equal(finalizationRow.status, 'finalized');
      assert.equal(finalizationRow.mode, 'handoff');
      assert.equal(finalizationRow.human_review_text, result.reviewText);
      assert.equal(finalizationRow.session_start_text, result.sessionStartText);
      assert.equal(finalizationRow.metadata.currentMemory.meta.servingContract, 'current_memory_v1');
      assert.equal(
        finalizationRow.metadata.currentMemory.memories.some(
          row => row.summary === 'Existing handoff current memory is captured in finalization metadata.',
        ),
        true,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(finalizationRow.metadata.currentMemory.memories[0], 'evidenceRefs'),
        false,
      );

      const bootstrap = await aq.bootstrap({
        activeScopePath: ['global', 'project:aquifer-handoff'],
        format: 'text',
        maxChars: 2000,
      });
      assert.match(bootstrap.text, /Codex handoff finalization must use the shared core serving surface/);
      assert.match(bootstrap.text, /verify handoff SessionStart minimal context/);
      assert.doesNotMatch(bootstrap.text, /Payload-only overview|Payload-only next step/);
    });

    it('promotes reviewed handoff synthesis output through core and supersedes lower-authority current memory', async () => {
      const file = path.join(root, 'rollout-codex-handoff-synthesis.jsonl');
      writeJsonl(file, [
        { type: 'session_meta', payload: { id: 'codex-handoff-synthesis-smoke' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Aquifer handoff synthesis smoke start.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tracking handoff synthesis promotion.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'State: reviewed handoff synthesis output should replace the old lower-authority state.' } },
      ]);

      const view = codex.materializeRecoveryTranscriptView({ filePath: file }, {
        maxRecoveryBytes: 1024 * 1024,
      });
      assert.equal(view.status, 'ok');

      const scope = await aq.memory.upsertScope({
        scopeKind: 'project',
        scopeKey: 'project:aquifer-handoff-synthesis',
      });
      await aq.memory.upsertMemory({
        memoryType: 'state',
        canonicalKey: 'state:project:aquifer:handoff-synthesis-reviewed',
        scopeId: scope.id,
        summary: 'Old lower-authority handoff synthesis state must leave active serving.',
        status: 'active',
        authority: 'llm_inference',
        visibleInBootstrap: true,
        visibleInRecall: true,
      });

      const result = await handoff.finalizeHandoff(aq, {
        title: 'Codex handoff synthesis DB smoke',
        overview: 'Raw handoff synthesis overview must stay metadata only.',
        next: 'Raw handoff synthesis next must stay metadata only.',
      }, {
        view,
        synthesisSummary: {
          summaryText: 'Reviewed handoff synthesis output promotes one state.',
          structuredSummary: {
            states: [{ state: 'Reviewed handoff synthesis output should replace the old lower-authority state.' }],
          },
          candidates: [{
            memoryType: 'state',
            canonicalKey: 'state:project:aquifer:handoff-synthesis-reviewed',
            scopeKind: 'project',
            scopeKey: 'project:aquifer-handoff-synthesis',
            title: 'Reviewed handoff synthesis output should replace the old lower-authority state.',
            summary: 'Reviewed handoff synthesis output should replace the old lower-authority state.',
            payload: { state: 'Reviewed handoff synthesis output should replace the old lower-authority state.' },
            authority: 'verified_summary',
            evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: view.sessionId, relationKind: 'primary' }],
          }],
        },
        agentId: 'main',
        source: 'codex-wrapper',
        sessionKey: 'codex:wrapper:handoff-synthesis',
        scopeKind: 'project',
        scopeKey: 'project:aquifer-handoff-synthesis',
        activeScopePath: ['global', 'project:aquifer-handoff-synthesis'],
        activeScopeKey: 'project:aquifer-handoff-synthesis',
      });

      assert.equal(result.status, 'finalized');
      assert.equal(result.memoryResult.promoted, 1);
      assert.match(result.sessionStartText, /Reviewed handoff synthesis output/);
      assert.doesNotMatch(result.sessionStartText, /Raw handoff synthesis overview|Raw handoff synthesis next/);

      const finalizationRow = await aq.finalization.get({
        sessionId: 'codex-handoff-synthesis-smoke',
        agentId: 'main',
        source: 'codex-wrapper',
        transcriptHash: view.transcriptHash,
      });
      assert.equal(finalizationRow.status, 'finalized');
      assert.equal(finalizationRow.metadata.handoffSynthesis.kind, 'handoff_current_memory_synthesis_v1');

      const bootstrap = await aq.bootstrap({
        activeScopePath: ['global', 'project:aquifer-handoff-synthesis'],
        format: 'text',
        maxChars: 2000,
      });
      assert.match(bootstrap.text, /Reviewed handoff synthesis output should replace the old lower-authority state/);
      assert.doesNotMatch(bootstrap.text, /Old lower-authority handoff synthesis state|Raw handoff synthesis overview|Raw handoff synthesis next/);
    });

    it('serves memory promoted by Codex import afterburn finalization from the same core surface', async () => {
      const sessionsDir = path.join(root, 'afterburn-sessions');
      const stateDir = path.join(root, 'afterburn-state');
      const file = path.join(sessionsDir, 'rollout-codex-afterburn.jsonl');
      writeJsonl(file, [
        { type: 'session_meta', payload: { id: 'codex-afterburn-smoke' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Aquifer afterburn smoke start.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tracking afterburn import.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Decision: Codex import afterburn finalization must use the shared core serving surface.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will finalize through afterburn.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Open loop: verify afterburn SessionStart minimal context.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The import path should match recovery and handoff.' }] } },
      ]);

      const result = await codex.runSync(aq, {
        sessionsDir,
        stateDir,
        minSessionBytes: 1,
        idleMs: 0,
        maxImports: 10,
        maxAfterburns: 10,
        source: 'codex',
        agentId: 'main',
        sessionKey: 'codex:cli:afterburn-smoke',
        scopeKind: 'project',
        scopeKey: 'project:aquifer-afterburn',
        summaryFn: async () => ({
          summaryText: 'Codex import afterburn finalization produced curated memory for DB-backed serving.',
          structuredSummary: {
            decisions: [{
              decision: 'Codex import afterburn finalization must use the shared core serving surface.',
              reason: 'This proves import trigger parity.',
            }],
            open_loops: [{
              item: 'verify afterburn SessionStart minimal context',
              owner: 'Miranda',
            }],
          },
        }),
        logger: { warn() {} },
      });

      assert.equal(result.imported.length, 1);
      assert.equal(result.afterburned.length, 1);
      assert.equal(result.afterburned[0].status, 'afterburned');
      assert.match(result.afterburned[0].humanReviewText, /已整理進 DB/);
      assert.match(result.afterburned[0].humanReviewText, /Codex import afterburn finalization must use the shared core serving surface/);
      assert.match(result.afterburned[0].sessionStartText, /verify afterburn SessionStart minimal context/);
      assert.match(result.afterburned[0].sessionStartText, /Codex import afterburn finalization must use the shared core serving surface/);
      assert.doesNotMatch(result.afterburned[0].sessionStartText, /sessionId|transcriptHash|raw JSON|message count/);

      const transcriptHash = result.afterburned[0].finalization.transcriptHash;
      const finalizationRow = await aq.finalization.get({
        sessionId: 'codex-afterburn-smoke',
        agentId: 'main',
        source: 'codex',
        transcriptHash,
      });
      assert.equal(finalizationRow.status, 'finalized');
      assert.equal(finalizationRow.mode, 'afterburn');
      assert.equal(finalizationRow.human_review_text, result.afterburned[0].humanReviewText);
      assert.equal(finalizationRow.session_start_text, result.afterburned[0].sessionStartText);

      const bootstrap = await aq.bootstrap({
        activeScopePath: ['global', 'project:aquifer-afterburn'],
        format: 'text',
        maxChars: 2000,
      });
      assert.match(bootstrap.text, /Codex import afterburn finalization must use the shared core serving surface/);
      assert.match(bootstrap.text, /verify afterburn SessionStart minimal context/);
    });

    it('removes non-active recovery finalization memory from curated recall and bootstrap', async () => {
      const file = path.join(root, 'rollout-codex-incorrect.jsonl');
      writeJsonl(file, [
        { type: 'session_meta', payload: { id: 'codex-incorrect-smoke' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Aquifer incorrect memory smoke start.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tracking incorrect lifecycle.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Decision: Incorrect Codex recovery memories must disappear from active serving.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The smoke will retire that memory.' }] } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Verify recall and bootstrap do not serve retired memory.' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Curated serving should filter non-active rows.' }] } },
      ]);

      const view = codex.materializeRecoveryTranscriptView({ filePath: file }, {
        maxRecoveryBytes: 1024 * 1024,
      });
      assert.equal(view.status, 'ok');

      await codex.finalizeCodexSession(aq, {
        view,
        mode: 'session_start_recovery',
        summaryText: 'Codex recovery finalization produced a memory that will be marked incorrect.',
        structuredSummary: {
          decisions: [{
            decision: 'Incorrect Codex recovery memories must disappear from active serving.',
            reason: 'This proves retired memory does not leak into SessionStart or recall.',
          }],
        },
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
      }, {
        agentId: 'main',
        source: 'codex',
        sessionKey: 'codex:recovery:smoke',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
      });

      const active = await aq.recall('Incorrect Codex recovery memories', {
        limit: 5,
      });
      assert.equal(active.some(row => /Incorrect Codex recovery memories/.test(row.summary)), true);

      const target = active.find(row => /Incorrect Codex recovery memories/.test(row.summary));
      const retired = await records.updateMemoryStatus({
        memoryId: target.id,
        status: 'incorrect',
        visibleInBootstrap: true,
        visibleInRecall: true,
      });
      assert.equal(retired.status, 'incorrect');
      assert.equal(retired.visible_in_bootstrap, false);
      assert.equal(retired.visible_in_recall, false);

      const recalled = await aq.recall('Incorrect Codex recovery memories', {
        limit: 5,
      });
      assert.equal(recalled.some(row => /Incorrect Codex recovery memories/.test(row.summary)), false);

      const bootstrap = await aq.bootstrap({
        activeScopePath: ['global', 'project:aquifer'],
        format: 'text',
        maxChars: 2000,
      });
      assert.doesNotMatch(bootstrap.text, /Incorrect Codex recovery memories/);
    });

    it('serves only active memories across bootstrap and recall with non-active rows present', async () => {
      const scope = await aq.memory.upsertScope({
        scopeKind: 'project',
        scopeKey: 'project:aquifer-serving-negative',
      });
      await aq.memory.upsertMemory({
        memoryType: 'decision',
        canonicalKey: 'decision:serving-negative:active',
        scopeId: scope.id,
        summary: 'serving negative active memory',
        status: 'active',
        authority: 'verified_summary',
        acceptedAt: '2026-04-28T00:00:00.000Z',
        visibleInBootstrap: true,
        visibleInRecall: true,
      });
      for (const status of ['incorrect', 'quarantined', 'superseded']) {
        const memory = await aq.memory.upsertMemory({
          memoryType: 'decision',
          canonicalKey: `decision:serving-negative:${status}`,
          scopeId: scope.id,
          summary: `serving negative ${status} memory`,
          status: 'active',
          authority: 'verified_summary',
          acceptedAt: '2026-04-28T00:01:00.000Z',
          visibleInBootstrap: true,
          visibleInRecall: true,
        });
        const updated = await records.updateMemoryStatus({
          memoryId: memory.id,
          status,
          visibleInBootstrap: true,
          visibleInRecall: true,
        });
        assert.equal(updated.status, status);
        assert.equal(updated.visible_in_bootstrap, false);
        assert.equal(updated.visible_in_recall, false);
      }

      const bootstrap = await aq.bootstrap({
        activeScopePath: ['global', 'project:aquifer-serving-negative'],
        format: 'text',
        maxChars: 2000,
      });
      assert.match(bootstrap.text, /serving negative active memory/);
      assert.doesNotMatch(bootstrap.text, /serving negative incorrect memory/);
      assert.doesNotMatch(bootstrap.text, /serving negative quarantined memory/);
      assert.doesNotMatch(bootstrap.text, /serving negative superseded memory/);

      const recalled = await aq.recall('serving negative', { limit: 10 });
      assert.deepEqual(
        recalled.map(row => row.summary),
        ['serving negative active memory'],
      );
      assert.equal(recalled.every(row => row.status === 'active'), true);

      await assert.rejects(
        () => pool.query(
          `UPDATE "${schema}".memory_records
              SET status = 'incorrect',
                  visible_in_bootstrap = true,
                  visible_in_recall = true
            WHERE tenant_id = $1
              AND id = $2`,
          ['test', recalled[0].id],
        ),
        /check constraint/i,
      );
    });

    it('keeps older state and open loop in DB bootstrap before newer decisions under limit', async () => {
      const scope = await aq.memory.upsertScope({
        scopeKind: 'project',
        scopeKey: 'project:aquifer-priority-limit',
      });
      await aq.memory.upsertMemory({
        memoryType: 'state',
        canonicalKey: 'state:priority-limit:current',
        scopeId: scope.id,
        summary: 'priority limit current state',
        status: 'active',
        authority: 'verified_summary',
        acceptedAt: '2026-04-27T00:00:00.000Z',
        visibleInBootstrap: true,
        visibleInRecall: true,
      });
      await aq.memory.upsertMemory({
        memoryType: 'open_loop',
        canonicalKey: 'open-loop:priority-limit:next',
        scopeId: scope.id,
        summary: 'priority limit open loop',
        status: 'active',
        authority: 'verified_summary',
        acceptedAt: '2026-04-27T00:01:00.000Z',
        visibleInBootstrap: true,
        visibleInRecall: true,
      });
      for (let i = 0; i < 6; i += 1) {
        await aq.memory.upsertMemory({
          memoryType: 'decision',
          canonicalKey: `decision:priority-limit:newer-${i}`,
          scopeId: scope.id,
          summary: `priority limit newer decision ${i}`,
          status: 'active',
          authority: 'verified_summary',
          acceptedAt: `2026-04-28T00:0${i}:00.000Z`,
          visibleInBootstrap: true,
          visibleInRecall: true,
        });
      }

      const bootstrap = await aq.bootstrap({
        activeScopePath: ['global', 'project:aquifer-priority-limit'],
        format: 'text',
        limit: 2,
        maxChars: 2000,
      });

      assert.match(bootstrap.text, /priority limit current state/);
      assert.match(bootstrap.text, /priority limit open loop/);
      assert.doesNotMatch(bootstrap.text, /priority limit newer decision/);
    });

    it('keeps terminal finalization audit fields immutable across retry upserts', async () => {
      const sessionId = 'codex-terminal-immutability';
      const transcriptHash = 'f'.repeat(64);
      await aq.commit(sessionId, [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
        { role: 'assistant', content: 'a3' },
      ], {
        agentId: 'main',
        source: 'codex',
        sessionKey: 'codex:recovery:smoke',
        rawMessages: {
          normalized: [],
          metadata: { transcript_hash: transcriptHash },
        },
      });

      const terminal = await aq.finalization.createTask({
        sessionId,
        agentId: 'main',
        source: 'codex',
        transcriptHash,
        mode: 'session_start_recovery',
        status: 'declined',
        finalizerModel: 'first-model',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        memoryResult: { promoted: 2 },
        error: 'user declined',
        metadata: { reason: 'first decision' },
        claimedAt: '2026-04-28T00:00:00.000Z',
        finalizedAt: '2026-04-28T00:00:01.000Z',
      });

      await aq.finalization.createTask({
        sessionId,
        agentId: 'main',
        source: 'codex',
        transcriptHash,
        mode: 'afterburn',
        status: 'pending',
        finalizerModel: 'second-model',
        scopeKind: 'session',
        scopeKey: 'session:overwritten',
        memoryResult: { promoted: 0 },
        error: 'should not overwrite',
        metadata: { reason: 'retry' },
        claimedAt: '2026-04-28T01:00:00.000Z',
        finalizedAt: '2026-04-28T01:00:01.000Z',
      });

      const row = await aq.finalization.get({
        sessionId,
        agentId: 'main',
        source: 'codex',
        transcriptHash,
      });

      assert.equal(row.status, 'declined');
      assert.equal(row.mode, terminal.mode);
      assert.equal(row.finalizer_model, terminal.finalizer_model);
      assert.equal(row.scope_kind, terminal.scope_kind);
      assert.equal(row.scope_key, terminal.scope_key);
      assert.deepEqual(row.memory_result, terminal.memory_result);
      assert.equal(row.error, terminal.error);
      assert.deepEqual(row.metadata, terminal.metadata);
      assert.equal(new Date(row.claimed_at).toISOString(), new Date(terminal.claimed_at).toISOString());
      assert.equal(new Date(row.finalized_at).toISOString(), new Date(terminal.finalized_at).toISOString());
      assert.equal(new Date(row.updated_at).toISOString(), new Date(terminal.updated_at).toISOString());
    });
  });
}
