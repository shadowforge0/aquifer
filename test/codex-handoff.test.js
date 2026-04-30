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

  it('builds handoff synthesis prompt from transcript, handoff context, and current memory', () => {
    const prompt = handoff.buildHandoffSynthesisPrompt(samplePayload(), sampleView(), {
      currentMemory: {
        memories: [{
          memoryType: 'state',
          canonicalKey: 'state:handoff:current',
          scopeKey: 'project:aquifer',
          summary: 'Existing current memory must be reconciled.',
          memoryId: '42',
          evidenceRefs: [{ sourceRef: 'private' }],
        }],
        meta: {
          source: 'memory_records',
          servingContract: 'current_memory_v1',
          count: 1,
        },
      },
    });

    assert.match(prompt, /handoff_context/);
    assert.match(prompt, /handoff_synthesis_rules/);
    assert.match(prompt, /process material, not current truth/);
    assert.match(prompt, /Existing current memory must be reconciled/);
    assert.match(prompt, /sanitized_transcript/);
    assert.match(prompt, /Return compact JSON/);
    assert.doesNotMatch(prompt, /memoryId/);
    assert.doesNotMatch(prompt, /evidenceRefs/);
  });

  it('adds checkpoint context as process material without leaking lineage internals', () => {
    const prompt = handoff.buildHandoffSynthesisPrompt(samplePayload(), sampleView(), {
      checkpoints: [{
        id: 42,
        inputHash: 'secret-hash',
        transcriptHash: 'private-transcript-hash',
        scopeKey: 'project:aquifer',
        topicKey: 'rolling-checkpoint',
        triggerKind: 'boundary',
        summaryText: 'Aquifer checkpoint captured scoped release state.',
        structuredSummary: {
          decisions: [{ decision: 'Checkpoints stay process material until finalization.' }],
          open_loops: [{ item: 'Wire checkpoint ledger into handoff combiner.' }],
        },
      }],
    });

    assert.match(prompt, /checkpoint_context/);
    assert.match(prompt, /scope=project:aquifer/);
    assert.match(prompt, /Aquifer checkpoint captured scoped release state/);
    assert.match(prompt, /Checkpoints stay process material until finalization/);
    assert.match(prompt, /Treat checkpoint_context as producer process material/);
    assert.doesNotMatch(prompt, /secret-hash/);
    assert.doesNotMatch(prompt, /private-transcript-hash/);
    assert.doesNotMatch(prompt, /id: 42/);
  });

  it('adds previous bootstrap context as process material without promoting it directly', () => {
    const prompt = handoff.buildHandoffSynthesisPrompt(samplePayload(), sampleView(), {
      previousBootstrap: {
        text: [
          '<memory-bootstrap memories="2">',
          '- open_loop: Prior run said to verify candidate envelope.',
          '- decision: Prior bootstrap context is continuity material.',
          '</memory-bootstrap>',
        ].join('\n'),
        meta: {
          source: 'session_bootstrap',
          activeScopePath: ['global', 'project:aquifer'],
          generatedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    });

    assert.match(prompt, /previous_bootstrap_context/);
    assert.match(prompt, /Prior run said to verify candidate envelope/);
    assert.match(prompt, /Treat previous_bootstrap_context as producer process material/);
    assert.match(prompt, /reconcile it against current_memory and the transcript/);
    assert.doesNotMatch(prompt, /generatedAt/);
  });

  it('uses only uncovered transcript tail when checkpoint coverage is explicit', () => {
    const view = sampleView({
      messages: [
        { role: 'user', content: 'covered user request' },
        { role: 'assistant', content: 'covered assistant work' },
        { role: 'user', content: 'tail user correction' },
        { role: 'assistant', content: 'tail assistant result' },
      ],
      text: '[user]\ncovered user request\n\n[assistant]\ncovered assistant work\n\n[user]\ntail user correction\n\n[assistant]\ntail assistant result',
    });
    const prompt = handoff.buildHandoffSynthesisPrompt(samplePayload(), view, {
      checkpoints: [{
        scopeKey: 'project:aquifer',
        summaryText: 'Prior range was checkpointed.',
        coverage: { messageIndex: 1 },
      }],
    });

    assert.match(prompt, /sessionId: codex-session-1/);
    assert.match(prompt, new RegExp(`transcriptHash: ${view.transcriptHash}`));
    assert.match(prompt, /checkpoint_context/);
    assert.match(prompt, /tail user correction/);
    assert.match(prompt, /tail assistant result/);
    assert.doesNotMatch(prompt, /\[user\]\ncovered user request/);
    assert.doesNotMatch(prompt, /\[assistant\]\ncovered assistant work/);
  });

  it('falls back to the full transcript when checkpoint coverage is invalid', () => {
    const view = sampleView({
      messages: [
        { role: 'user', content: 'first full transcript message' },
        { role: 'assistant', content: 'second full transcript message' },
      ],
      text: '[user]\nfirst full transcript message\n\n[assistant]\nsecond full transcript message',
    });
    const prompt = handoff.buildHandoffSynthesisPrompt(samplePayload(), view, {
      checkpoints: [{
        scopeKey: 'project:aquifer',
        summaryText: 'Invalid checkpoint coverage should not trim the prompt.',
        coverage: { messageIndex: 9 },
      }],
    });

    assert.match(prompt, /first full transcript message/);
    assert.match(prompt, /second full transcript message/);
  });

  it('prepares handoff synthesis with compact current memory snapshot', async () => {
    const view = sampleView();
    const currentCalls = [];
    const aquifer = {
      memory: {
        async current(input) {
          currentCalls.push(input);
          return {
            memories: [{
              memoryType: 'decision',
              scopeKey: 'project:aquifer',
              summary: 'Current memory enters prompt only as compact text.',
              memoryId: '99',
            }, {
              memoryType: 'state',
              scopeKey: 'project:other',
              summary: input.activeScopeKey === 'project:other'
                ? 'Other project memory would be a scope leak.'
                : '',
            }],
            meta: {
              source: 'memory_records',
              servingContract: 'current_memory_v1',
              count: 1,
            },
          };
        },
      },
    };

    const prepared = await handoff.prepareHandoffSynthesis(aquifer, samplePayload(), {
      view,
      activeScopeKey: 'project:aquifer',
      activeScopePath: ['global', 'project:aquifer'],
      scopeId: 12,
    });

    assert.equal(prepared.status, 'needs_agent_summary');
    assert.equal(prepared.view, view);
    assert.deepEqual(currentCalls[0].activeScopePath, ['global', 'project:aquifer']);
    assert.equal(currentCalls[0].activeScopeKey, 'project:aquifer');
    assert.equal(currentCalls[0].scopeId, 12);
    assert.equal(prepared.currentMemory.meta.servingContract, 'current_memory_v1');
    assert.match(prepared.prompt, /Current memory enters prompt only as compact text/);
    assert.doesNotMatch(prepared.prompt, /Other project memory would be a scope leak/);
    assert.doesNotMatch(prepared.prompt, /memoryId/);
  });

  it('prepares handoff synthesis with DB-backed checkpoint context and uncovered line tail when available', async () => {
    const view = sampleView({
      messages: [
        { role: 'user', content: 'covered planning note' },
        { role: 'assistant', content: 'covered implementation detail' },
        { role: 'user', content: 'remaining release question' },
        { role: 'assistant', content: 'remaining release answer' },
      ],
      text: [
        '[user]',
        'covered planning note',
        '',
        '[assistant]',
        'covered implementation detail',
        '',
        '[user]',
        'remaining release question',
        '',
        '[assistant]',
        'remaining release answer',
      ].join('\n'),
    });
    const checkpointCalls = [];
    const aquifer = {
      memory: {
        async current() {
          return { memories: [], meta: { servingContract: 'current_memory_v1' } };
        },
      },
      checkpoints: {
        async listForHandoff(input) {
          checkpointCalls.push(input);
          return [{
            scopeKey: 'project:aquifer',
            triggerKind: 'boundary',
            summaryText: 'DB checkpoint enters handoff prompt as process material.',
            coverage: {
              transcript: {
                line: 6,
                char: 0,
              },
            },
            structuredSummary: {
              decisions: [{ decision: 'Checkpoint rows do not bypass finalization.' }],
            },
          }];
        },
      },
    };

    const prepared = await handoff.prepareHandoffSynthesis(aquifer, samplePayload({ sessionId: 'payload-session' }), {
      view,
      activeScopeKey: 'project:aquifer',
      activeScopePath: ['global', 'project:aquifer'],
      checkpointLimit: 3,
    });

    assert.equal(checkpointCalls.length, 1);
    assert.deepEqual(checkpointCalls[0].activeScopePath, ['global', 'project:aquifer']);
    assert.equal(checkpointCalls[0].activeScopeKey, 'project:aquifer');
    assert.equal(checkpointCalls[0].sessionId, 'payload-session');
    assert.equal(checkpointCalls[0].limit, 3);
    assert.equal(prepared.checkpoints.meta.source, 'checkpoint_runs');
    assert.equal(prepared.view, view);
    assert.match(prepared.prompt, /checkpoint_context/);
    assert.match(prepared.prompt, /sessionId: codex-session-1/);
    assert.match(prepared.prompt, new RegExp(`transcriptHash: ${view.transcriptHash}`));
    assert.match(prepared.prompt, /DB checkpoint enters handoff prompt as process material/);
    assert.match(prepared.prompt, /Checkpoint rows do not bypass finalization/);
    assert.match(prepared.prompt, /\[user\]\nremaining release question/);
    assert.match(prepared.prompt, /\[assistant\]\nremaining release answer/);
    assert.doesNotMatch(prepared.prompt, /\[user\]\ncovered planning note/);
    assert.doesNotMatch(prepared.prompt, /\[assistant\]\ncovered implementation detail/);
  });

  it('marks the handoff synthesis output schema for operator promotion', async () => {
    const prepared = await handoff.prepareHandoffSynthesis({
      memory: { async current() { return { memories: [], meta: { count: 0 } }; } },
    }, samplePayload(), { view: sampleView() });

    assert.equal(prepared.outputSchemaVersion, 'handoff_current_memory_synthesis_v1');
  });

  it('passes previous bootstrap context into handoff synthesis preparation', async () => {
    const prepared = await handoff.prepareHandoffSynthesis({
      memory: { async current() { return { memories: [], meta: { count: 0 } }; } },
    }, samplePayload(), {
      view: sampleView(),
      previousBootstrap: {
        text: 'Prior bootstrap carried a scope-specific open loop.',
        meta: { source: 'session_bootstrap' },
      },
    });

    assert.equal(prepared.previousBootstrap.meta.source, 'previous_bootstrap');
    assert.match(prepared.prompt, /previous_bootstrap_context/);
    assert.match(prepared.prompt, /Prior bootstrap carried a scope-specific open loop/);
  });

  it('auto-loads previous bootstrap from current-memory bootstrap when not provided', async () => {
    const bootstrapCalls = [];
    const prepared = await handoff.prepareHandoffSynthesis({
      memory: {
        async current() {
          return { memories: [], meta: { servingContract: 'current_memory_v1' } };
        },
        async bootstrap(input) {
          bootstrapCalls.push(input);
          return {
            text: '<memory-bootstrap memories="1">\n- open_loop: Auto-loaded bootstrap should be reconciled.\n</memory-bootstrap>',
            memories: [{
              memoryType: 'open_loop',
              summary: 'Auto-loaded bootstrap should be reconciled.',
            }],
            meta: {
              source: 'current_memory_bootstrap',
              activeScopePath: input.activeScopePath,
            },
          };
        },
      },
    }, samplePayload(), {
      view: sampleView(),
      activeScopeKey: 'project:aquifer',
      activeScopePath: ['global', 'project:aquifer'],
      previousBootstrapLimit: 7,
      previousBootstrapMaxChars: 900,
    });

    assert.equal(bootstrapCalls.length, 1);
    assert.deepEqual(bootstrapCalls[0].activeScopePath, ['global', 'project:aquifer']);
    assert.equal(bootstrapCalls[0].activeScopeKey, 'project:aquifer');
    assert.equal(bootstrapCalls[0].limit, 7);
    assert.equal(bootstrapCalls[0].maxChars, 900);
    assert.equal(prepared.previousBootstrap.meta.originalSource, 'current_memory_bootstrap');
    assert.match(prepared.prompt, /Auto-loaded bootstrap should be reconciled/);
    assert.match(prepared.prompt, /previous_bootstrap_context/);
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
      memory: {
        async current() {
          return {
            memories: [{
              memoryType: 'state',
              canonicalKey: 'state:handoff:current',
              scopeKey: 'project:aquifer',
              summary: 'Existing handoff current memory.',
            }],
            meta: {
              source: 'memory_records',
              servingContract: 'current_memory_v1',
              count: 1,
            },
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
    assert.equal(calls[0].metadata.currentMemory.meta.servingContract, 'current_memory_v1');
    assert.equal(calls[0].metadata.currentMemory.memories[0].summary, 'Existing handoff current memory.');
    assert.equal(calls[0].metadata.currentMemory.memories[0].memoryId, undefined);
    assert.equal(calls[0].metadata.currentMemory.memories[0].evidenceRefs, undefined);
  });

  it('promotes explicit handoff synthesis output instead of raw handoff payload', async () => {
    const calls = [];
    const bootstrapCalls = [];
    const view = sampleView();
    const synthesisSummary = {
      summaryText: 'Reviewed handoff synthesis summary.',
      structuredSummary: {
        states: [{ state: 'Reviewed synthesis output should become the candidate source.' }],
      },
      candidates: [{
        memoryType: 'state',
        canonicalKey: 'state:project:aquifer:handoff-reviewed',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        title: 'Reviewed synthesis output should become the candidate source.',
        summary: 'Reviewed synthesis output should become the candidate source.',
        payload: { state: 'Reviewed synthesis output should become the candidate source.' },
        authority: 'verified_summary',
        evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: view.sessionId, relationKind: 'primary' }],
      }],
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
        async finalizeSession(input) {
          calls.push(input);
          return {
            status: 'finalized',
            finalization: { id: 45 },
            summary: {
              summaryText: input.summaryText,
              structuredSummary: input.structuredSummary,
            },
            memoryResult: { candidates: input.candidates.length, promoted: input.candidates.length },
            memoryResults: [],
            humanReviewText: '已整理進 DB：reviewed handoff synthesis',
            sessionStartText: '下一段只需要帶：\n- 狀態：reviewed handoff synthesis\n',
          };
        },
      },
      memory: {
        async bootstrap(input) {
          bootstrapCalls.push(input);
          return {
            text: '<memory-bootstrap memories="1">\n- decision: Previous bootstrap enters only as envelope input context.\n</memory-bootstrap>',
            meta: { source: 'current_memory_bootstrap' },
          };
        },
      },
    };

    const result = await handoff.finalizeHandoff(aquifer, samplePayload({
      summaryText: 'Raw handoff text must stay process metadata only.',
      structuredSummary: {
        states: [{ state: 'Raw handoff payload must not become the candidate source.' }],
      },
    }), {
      view,
      synthesisSummary,
    });

    assert.equal(result.status, 'finalized');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].summaryText, 'Reviewed handoff synthesis summary.');
    assert.equal(calls[0].structuredSummary, synthesisSummary.structuredSummary);
    assert.equal(calls[0].authority, 'verified_summary');
    assert.equal(calls[0].metadata.handoffSynthesis.kind, 'handoff_current_memory_synthesis_v1');
    assert.equal(calls[0].candidatePayload.kind, 'handoff_synthesis');
    assert.equal(calls[0].candidatePayload.synthesisKind, 'handoff_current_memory_synthesis_v1');
    assert.equal(calls[0].candidates[0].canonicalKey, 'state:project:aquifer:handoff-reviewed');
    assert.equal(bootstrapCalls.length, 1);
    assert.equal(calls[0].candidateEnvelope.version, 'handoff_current_memory_synthesis_v1');
    assert.equal(calls[0].candidateEnvelope.inputContext.previousBootstrap.originalSource, 'current_memory_bootstrap');
    assert.equal(calls[0].candidateEnvelope.inputContext.previousBootstrap.hash.length, 64);
    assert.doesNotMatch(calls[0].summaryText, /Raw handoff/);
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
