'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCheckpointCoverageFromView,
  buildCheckpointSynthesisInput,
  buildCheckpointSynthesisPrompt,
  buildCheckpointRunInputFromSynthesis,
  createSessionCheckpoints,
} = require('../core/session-checkpoints');

function makeView() {
  return {
    status: 'ok',
    sessionId: 'codex-session-1',
    transcriptHash: 'transcript-hash-1',
    messages: [
      { role: 'user', content: 'scope question' },
      { role: 'assistant', content: 'scope answer' },
    ],
    text: '[user]\nscope question\n\n[assistant]\nscope answer',
    charCount: 46,
    approxPromptTokens: 16,
  };
}

function makeScopeEnvelope() {
  return {
    policyVersion: 'scope_envelope_v1',
    activeSlotId: 'project',
    activeScopeKey: 'project:aquifer',
    allowedScopeKeys: ['global', 'workspace:/home/mingko', 'project:aquifer'],
    slots: [{
      id: 'workspace',
      slot: 'workspace',
      scopeKind: 'workspace',
      scopeKey: 'workspace:/home/mingko',
      label: '/home/mingko',
      promotable: true,
      allowedScopeKeys: ['global', 'workspace:/home/mingko'],
    }, {
      id: 'project',
      slot: 'project',
      scopeKind: 'project',
      scopeKey: 'project:aquifer',
      label: 'Aquifer',
      promotable: true,
      allowedScopeKeys: ['global', 'workspace:/home/mingko', 'project:aquifer'],
    }],
    scopeById: {
      workspace: {
        id: 'workspace',
        slot: 'workspace',
        scopeKind: 'workspace',
        scopeKey: 'workspace:/home/mingko',
        label: '/home/mingko',
        promotable: true,
        allowedScopeKeys: ['global', 'workspace:/home/mingko'],
      },
      project: {
        id: 'project',
        slot: 'project',
        scopeKind: 'project',
        scopeKey: 'project:aquifer',
        label: 'Aquifer',
        promotable: true,
        allowedScopeKeys: ['global', 'workspace:/home/mingko', 'project:aquifer'],
      },
    },
  };
}

describe('session checkpoint producer contract', () => {
  it('builds deterministic synthesis input with explicit scope, range, and coverage', () => {
    const base = {
      view: makeView(),
      scopeEnvelope: makeScopeEnvelope(),
      targetScopeEnvelopeId: 'project',
      fromFinalizationIdExclusive: 10,
      toFinalizationIdInclusive: 14,
      coveredUntilMessageIndex: 1,
      coveredUntilChar: 46,
      currentMemory: {
        memories: [{
          memoryType: 'decision',
          canonicalKey: 'decision:project:aquifer:model-default',
          scopeKey: 'project:aquifer',
          summary: 'Aquifer default model change belongs to Aquifer scope.',
          payload: { confidence: 'high' },
        }],
      },
      previousCheckpoints: [{
        checkpointKey: 'scope:7:finalization:6-10',
        summaryText: 'Earlier checkpoint captured current-memory design.',
        coverage: { coveredUntilChar: 20 },
      }],
    };
    const inputA = buildCheckpointSynthesisInput(base);
    const inputB = buildCheckpointSynthesisInput({
      previousCheckpoints: base.previousCheckpoints,
      currentMemory: base.currentMemory,
      coveredUntilChar: 46,
      coveredUntilMessageIndex: 1,
      toFinalizationIdInclusive: 14,
      fromFinalizationIdExclusive: 10,
      targetScopeEnvelopeId: 'project',
      scopeEnvelope: makeScopeEnvelope(),
      view: makeView(),
    });

    assert.equal(inputA.inputHash, inputB.inputHash);
    assert.equal(inputA.kind, 'session_checkpoint_synthesis_input_v1');
    assert.deepEqual(inputA.range, {
      fromFinalizationIdExclusive: 10,
      toFinalizationIdInclusive: 14,
    });
    assert.equal(inputA.targetScope.scopeKey, 'project:aquifer');
    assert.equal(inputA.coverage.coordinateSystem, 'codex_sanitized_view_v1');
    assert.equal(inputA.coverage.coveredUntilMessageIndex, 1);
    assert.equal(inputA.coverage.coveredUntilChar, 46);
    assert.equal(inputA.currentMemory[0].canonicalKey, 'decision:project:aquifer:model-default');
    assert.equal(inputA.previousCheckpoints[0].checkpointKey, 'scope:7:finalization:6-10');
    assert.equal(inputA.guards.checkpointIsProcessMaterial, true);
  });

  it('defaults coverage to the full sanitized transcript view', () => {
    const coverage = buildCheckpointCoverageFromView(makeView());

    assert.equal(coverage.coveredUntilMessageIndex, 1);
    assert.equal(coverage.coveredUntilChar, makeView().text.length);
    assert.match(coverage.semantics, /first uncovered/);
  });

  it('builds a prompt that treats checkpoints as proposals instead of active truth', () => {
    const input = buildCheckpointSynthesisInput({
      view: makeView(),
      scopeEnvelope: makeScopeEnvelope(),
      targetScopeEnvelopeId: 'project',
      fromFinalizationIdExclusive: 10,
      toFinalizationIdInclusive: 14,
    });
    const prompt = buildCheckpointSynthesisPrompt(input);

    assert.match(prompt, /session checkpoint proposal/);
    assert.match(prompt, /producer process material, not active current memory/);
    assert.match(prompt, /scopeEnvelope\.slots/);
    assert.match(prompt, /project:aquifer/);
    assert.match(prompt, /fromFinalizationIdExclusive/);
    assert.match(prompt, /coveredUntilChar/);
    assert.doesNotMatch(prompt, /memoryId/);
    assert.doesNotMatch(prompt, /storage/);
    assert.doesNotMatch(prompt, /inputHash/);
    assert.doesNotMatch(prompt, /transcriptHash/);
  });

  it('turns a synthesis summary into storage input without finalizing active memory', () => {
    const input = buildCheckpointSynthesisInput({
      view: makeView(),
      scopeEnvelope: makeScopeEnvelope(),
      targetScopeEnvelopeId: 'project',
      storageScopeId: 7,
      fromFinalizationIdExclusive: 10,
      toFinalizationIdInclusive: 14,
    });
    const runInput = buildCheckpointRunInputFromSynthesis(input, {
      summaryText: 'Checkpoint captured Aquifer scope contract.',
      structuredSummary: {
        decisions: [{ decision: 'Checkpoint output stays process material.' }],
      },
      coverage: {
        coordinateSystem: 'codex_sanitized_view_v1',
        coveredUntilMessageIndex: 1,
        coveredUntilChar: 46,
      },
    });

    assert.equal(runInput.scopeId, 7);
    assert.equal(runInput.status, 'processing');
    assert.equal(runInput.fromFinalizationIdExclusive, 10);
    assert.equal(runInput.toFinalizationIdInclusive, 14);
    assert.equal(runInput.scopeSnapshot.scopeKind, 'project');
    assert.equal(runInput.scopeSnapshot.scopeKey, 'project:aquifer');
    assert.equal(runInput.checkpointPayload.promotionGate, 'operator_required');
    assert.equal(runInput.checkpointPayload.checkpointRole, 'handoff_process_material');
    assert.equal(runInput.checkpointPayload.coverage.coveredUntilChar, 46);
    assert.equal(runInput.metadata.source, 'session_checkpoint_producer');
  });

  it('rejects unbounded scope and invalid finalization ranges', () => {
    assert.throws(
      () => buildCheckpointSynthesisInput({
        view: makeView(),
        fromFinalizationIdExclusive: 10,
        toFinalizationIdInclusive: 14,
      }),
      /bounded scope envelope/,
    );
    assert.throws(
      () => buildCheckpointSynthesisInput({
        view: makeView(),
        scopeEnvelope: makeScopeEnvelope(),
        fromFinalizationIdExclusive: 14,
        toFinalizationIdInclusive: 14,
      }),
      /toFinalizationIdInclusive must be greater/,
    );
  });

  it('exposes producer helpers from the checkpoint service facade', () => {
    const checkpoints = createSessionCheckpoints({
      pool: { async query() { throw new Error('not used'); } },
      schema: 'aq',
      defaultTenantId: 'default',
    });

    assert.equal(typeof checkpoints.buildSynthesisInput, 'function');
    assert.equal(typeof checkpoints.buildSynthesisPrompt, 'function');
    assert.equal(typeof checkpoints.buildRunInputFromSynthesis, 'function');
  });
});
