'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assessCandidate, extractCandidatesFromStructuredSummary } = require('../core/memory-promotion');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'memory-scope-v1', 'pollution-codex', 'input.json'),
  'utf8',
));

describe('v1 pollution promotion gate', () => {
  it('quarantines forbidden pollution tags before curated memory', () => {
    const secretCandidate = fixture.candidates.find(c => c.pollutionTags.includes('secret'));
    const result = assessCandidate(secretCandidate);
    assert.equal(result.action, 'quarantine');
    assert.equal(result.reason, 'forbidden_secret');
  });

  it('allows clean decision candidates with provenance in the foundation slice', () => {
    const cleanCandidate = fixture.candidates.find(c => c.pollutionTags.length === 0);
    const result = assessCandidate(cleanCandidate);
    assert.equal(result.action, 'promote');
    assert.equal(result.reason, 'v1_foundation_allowed');
  });

  it('does not promote unsupported memory types', () => {
    const unsupportedCandidate = {
      memoryType: 'reflection',
      canonicalKey: 'reflection:project:aquifer:db',
      summary: 'This is not a v1 memory type.',
      authority: 'verified_summary',
      evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 'session-1' }],
      scopeKey: 'project:aquifer',
    };
    const result = assessCandidate(unsupportedCandidate);
    assert.equal(result.action, 'quarantine');
    assert.equal(result.reason, 'unsupported_memory_type');
  });

  it('does not let raw transcript authority self-promote', () => {
    const candidate = {
      memoryType: 'decision',
      canonicalKey: 'decision:raw',
      summary: 'Raw transcript says this should be remembered.',
      authority: 'raw_transcript',
      evidenceRefs: [{ sourceKind: 'session', sourceRef: 'session-1' }],
    };
    const result = assessCandidate(candidate);
    assert.equal(result.action, 'quarantine');
    assert.equal(result.reason, 'raw_transcript_not_authoritative');
  });

  it('normalizes pollution tags and raw transcript authority before assessment', () => {
    const tagResult = assessCandidate({
      memoryType: 'decision',
      canonicalKey: 'decision:stack-trace',
      summary: 'Contains stack trace.',
      pollutionTags: [' Stack_Trace '],
      authority: 'verified_summary',
      evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 'session-1' }],
    });
    assert.equal(tagResult.action, 'quarantine');
    assert.equal(tagResult.reason, 'forbidden_stack_trace');

    const authorityResult = assessCandidate({
      memoryType: 'decision',
      canonicalKey: 'decision:raw-uppercase',
      summary: 'Raw transcript says this should be remembered.',
      authority: 'RAW_TRANSCRIPT',
      evidenceRefs: [{ sourceKind: 'session', sourceRef: 'session-1' }],
    });
    assert.equal(authorityResult.action, 'quarantine');
    assert.equal(authorityResult.reason, 'raw_transcript_not_authoritative');
  });

  it('extracts global scope consistently when no session id is provided', () => {
    const candidates = extractCandidatesFromStructuredSummary({
      structuredSummary: { decisions: ['Aquifer keeps curated memory separate.'] },
    });
    assert.equal(candidates[0].scopeKind, 'global');
    assert.equal(candidates[0].scopeKey, 'global');
  });

  it('requires scope and sufficient authority for typed memory promotion', () => {
    const lowAuthority = assessCandidate({
      memoryType: 'fact',
      canonicalKey: 'fact:project:aquifer:db',
      summary: 'Aquifer has a v1 fact claim.',
      authority: 'llm_inference',
      scopeKey: 'project:aquifer',
      evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 'session-1' }],
    });
    assert.equal(lowAuthority.action, 'quarantine');
    assert.equal(lowAuthority.reason, 'insufficient_authority');

    const missingScope = assessCandidate({
      memoryType: 'constraint',
      canonicalKey: 'constraint:no-raw-recall',
      summary: 'Recall must not read raw transcripts.',
      authority: 'verified_summary',
      evidenceRefs: [{ sourceKind: 'session_summary', sourceRef: 'session-1' }],
    });
    assert.equal(missingScope.action, 'quarantine');
    assert.equal(missingScope.reason, 'missing_scope');
  });
});
