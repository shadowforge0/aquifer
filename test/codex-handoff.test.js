'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const handoff = require('../consumers/codex-handoff');

function samplePayload(overrides = {}) {
  return {
    sessionId: 'handoff-session',
    sessionKey: 'codex:wrapper:run',
    source: 'codex-wrapper',
    model: 'gpt-5.5',
    title: 'Aquifer handoff finalization',
    overview: '本輪把 Codex handoff 推進到 v1 finalization。',
    status: 'completed',
    lastStep: '完成 handoff finalization helper',
    next: '補 DB-backed smoke',
    stopReason: 'natural',
    decisions: [{ decision: 'handoff 要走 core finalization', reason: '避免第二套 semantics' }],
    decided: ['SessionStart recovery 不可偷讀 JSONL'],
    openLoops: [{ item: '補 session-end hook', owner: 'Miranda' }],
    topics: [{ name: 'Aquifer', summary: 'handoff 只可作為 finalization trigger' }],
    todoNew: ['補 handoff UX'],
    todoDone: ['接上 recovery hook'],
    ...overrides,
  };
}

function sampleView(overrides = {}) {
  return {
    status: 'ok',
    sessionId: 'codex-session-1',
    fileSessionId: 'rollout-file-1',
    filePath: '/tmp/rollout-file-1.jsonl',
    transcriptHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    messages: [
      { role: 'user', content: '請修 Aquifer handoff' },
      { role: 'assistant', content: '已改成整段 session finalization。' },
    ],
    text: '[user]\n請修 Aquifer handoff\n\n[assistant]\n已改成整段 session finalization。',
    charCount: 58,
    approxPromptTokens: 20,
    safetyGate: { redacted: 0, dropped: 0 },
    counts: {
      messageCount: 2,
      safeMessageCount: 2,
      userCount: 1,
      assistantCount: 1,
    },
    metadata: {
      model: 'gpt-5.5',
      startedAt: '2026-04-26T00:00:00.000Z',
      lastMessageAt: '2026-04-26T00:01:00.000Z',
    },
    ...overrides,
  };
}

function sampleSummary() {
  return {
    summaryText: '本段完成 Codex handoff finalization 修正，handoff 現在必須使用整段 sanitized transcript view。',
    structuredSummary: {
      decisions: [{ decision: 'handoff 必須以 real transcript hash 作為 finalization identity' }],
      open_loops: [{ item: '補 DB-backed smoke', owner: 'Miranda' }],
      conclusions: [{ subject: 'Aquifer', conclusion: 'payload-only handoff 不可寫入 v1 curated memory' }],
    },
  };
}

describe('Codex handoff finalization helper', () => {
  it('maps handoff payload into metadata only', () => {
    const metadata = handoff.buildHandoffMetadata(samplePayload());

    assert.equal(metadata.source, 'codex_handoff');
    assert.equal(metadata.handoff.title, 'Aquifer handoff finalization');
    assert.equal(metadata.handoff.decisions.length, 2);
    assert.ok(metadata.handoff.openLoops.some(loop => loop.item === '補 DB-backed smoke'));
    assert.ok(metadata.handoff.openLoops.some(loop => loop.item === '補 session-end hook'));
    assert.ok(metadata.handoff.openLoops.some(loop => loop.item === '補 handoff UX'));
    assert.equal(metadata.handoff.topics[0].summary, 'handoff 只可作為 finalization trigger');
  });

  it('rejects manual handoff finalization without a real transcript view', async () => {
    const calls = [];
    const aquifer = {
      finalization: {
        async finalizeSession(input) {
          calls.push(input);
        },
      },
    };

    await assert.rejects(
      () => handoff.finalizeHandoff(aquifer, samplePayload(), sampleSummary()),
      /normalized transcript view/,
    );
    assert.equal(calls.length, 0);
  });

  it('requires an explicit session summary even when payload contains overview fields', async () => {
    const calls = [];
    const aquifer = {
      async commit() {},
      finalization: {
        async finalizeSession(input) {
          calls.push(input);
        },
      },
    };

    await assert.rejects(
      () => handoff.finalizeHandoff(aquifer, samplePayload(), { view: sampleView() }),
      /summaryText or structuredSummary is required/,
    );
    assert.equal(calls.length, 0);
  });

  it('finalizes manual handoff from a normalized Codex transcript view and explicit summary', async () => {
    const calls = [];
    const aquifer = {
      async getSession() {
        return {
          session_id: 'codex-session-1',
          processing_status: 'pending',
          msg_count: view.counts.safeMessageCount,
          user_count: view.counts.userCount,
          assistant_count: view.counts.assistantCount,
          messages: {
            normalized: view.messages,
            metadata: { transcript_hash: view.transcriptHash },
          },
        };
      },
      finalization: {
        async finalizeSession(input) {
          calls.push(input);
          return {
            status: 'finalized',
            finalization: { id: 42 },
            memoryResult: { candidates: 3, promoted: 3 },
          };
        },
      },
    };
    const view = sampleView();
    const summary = sampleSummary();

    const result = await handoff.finalizeHandoff(aquifer, samplePayload(), {
      view,
      ...summary,
      agentId: 'main',
      source: 'codex-wrapper',
      tenantId: 'default',
      embedding: [0.1, 0.2],
    });

    assert.equal(result.status, 'finalized');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, 'handoff');
    assert.equal(calls[0].source, 'codex-wrapper');
    assert.equal(calls[0].sessionId, view.sessionId);
    assert.equal(calls[0].transcriptHash, view.transcriptHash);
    assert.doesNotMatch(calls[0].transcriptHash, /^handoff-/);
    assert.equal(calls[0].summaryText, summary.summaryText);
    assert.equal(calls[0].structuredSummary, summary.structuredSummary);
    assert.equal(calls[0].authority, 'manual');
    assert.equal(calls[0].msgCount, view.counts.safeMessageCount);
    assert.equal(calls[0].userCount, view.counts.userCount);
    assert.equal(calls[0].assistantCount, view.counts.assistantCount);
    assert.equal(calls[0].metadata.source, 'codex_handoff');
    assert.equal(calls[0].metadata.handoff.title, 'Aquifer handoff finalization');
  });

  it('surfaces committed core review and SessionStart text for handoff parity', async () => {
    const view = sampleView();
    const summary = sampleSummary();
    const aquifer = {
      async getSession() {
        return {
          session_id: view.sessionId,
          processing_status: 'pending',
          msg_count: view.counts.safeMessageCount,
          user_count: view.counts.userCount,
          assistant_count: view.counts.assistantCount,
          messages: {
            normalized: view.messages,
            metadata: { transcript_hash: view.transcriptHash },
          },
        };
      },
      finalization: {
        async finalizeSession() {
          return {
            status: 'finalized',
            finalization: { id: 43 },
            summary,
            memoryResult: { promoted: 1 },
            memoryResults: [],
            humanReviewText: '已整理進 DB：handoff wrapper parity smoke',
            sessionStartText: '下一段只需要帶：\n- 決策：handoff wrapper parity smoke\n',
          };
        },
      },
    };

    const result = await handoff.finalizeHandoff(aquifer, samplePayload(), {
      view,
      ...summary,
    });

    assert.equal(result.reviewText, '已整理進 DB：handoff wrapper parity smoke');
    assert.equal(result.humanReviewText, '已整理進 DB：handoff wrapper parity smoke');
    assert.equal(result.sessionStartText, '下一段只需要帶：\n- 決策：handoff wrapper parity smoke\n');
  });

  it('returns sanitized committed summary instead of raw handoff input summary', async () => {
    const view = sampleView();
    const rawSummary = {
      summaryText: 'DATABASE_URL=postgresql://user:pass@example/db',
      structuredSummary: {
        decisions: [{
          decision: 'raw secret sk-1234567890abcdefghijklmnop must not echo',
        }],
      },
    };
    const safeSummary = {
      summaryText: '[REDACTED_SECRET]',
      structuredSummary: {
        decisions: [{
          decision: 'raw secret [REDACTED_SECRET] must not echo',
        }],
      },
    };
    const aquifer = {
      async getSession() {
        return {
          session_id: view.sessionId,
          processing_status: 'pending',
          msg_count: view.counts.safeMessageCount,
          user_count: view.counts.userCount,
          assistant_count: view.counts.assistantCount,
          messages: {
            normalized: view.messages,
            metadata: { transcript_hash: view.transcriptHash },
          },
        };
      },
      finalization: {
        async finalizeSession() {
          return {
            status: 'finalized',
            finalization: { id: 44 },
            summary: safeSummary,
            memoryResult: { promoted: 1 },
            humanReviewText: '已整理進 DB：sanitized',
            sessionStartText: '下一段只需要帶：\n- 決策：sanitized\n',
          };
        },
      },
    };

    const result = await handoff.finalizeHandoff(aquifer, samplePayload(), {
      view,
      ...rawSummary,
    });

    assert.deepEqual(result.summary, safeSummary);
    assert.deepEqual(result.structuredSummary, safeSummary.structuredSummary);
    assert.notDeepEqual(result.structuredSummary, rawSummary.structuredSummary);
  });

  it('refuses stale or invalid transcript views for manual handoff finalization', async () => {
    const calls = [];
    const aquifer = {
      finalization: {
        async finalizeSession(input) {
          calls.push(input);
        },
      },
    };

    await assert.rejects(
      () => handoff.finalizeHandoff(aquifer, samplePayload(), {
        view: { status: 'hash_mismatch', sessionId: 'codex-session-1' },
        ...sampleSummary(),
      }),
      /hash_mismatch/,
    );
    assert.equal(calls.length, 0);
  });
});
