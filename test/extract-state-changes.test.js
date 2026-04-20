'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultStateChangePrompt,
  extractJsonBlock,
  normalizeChange,
  extractStateChanges,
} = require('../pipeline/extract-state-changes');

describe('extract-state-changes.defaultStateChangePrompt', () => {
  it('mentions strict rules and includes entity scope list', () => {
    const p = defaultStateChangePrompt(
      [{ role: 'user', content: 'I upgraded Node to 22 today.' }],
      { entities: [{ id: 7, name: 'Node' }], sessionStartedAt: '2026-04-19T00:00:00Z' }
    );
    assert.match(p, /TEMPORAL STATE-CHANGE/);
    assert.match(p, /REJECT/);
    assert.match(p, /snake_case/);
    assert.match(p, /"Node" \(id=7\)/);
    assert.match(p, /Session started at: 2026-04-19T00:00:00Z/);
  });
  it('says no entities when scope is empty', () => {
    const p = defaultStateChangePrompt([], { entities: [], sessionStartedAt: 'now' });
    assert.match(p, /no entities resolved yet/);
  });
});

describe('extract-state-changes.extractJsonBlock', () => {
  it('parses bare JSON', () => {
    assert.deepEqual(extractJsonBlock('{"state_changes":[]}'), { state_changes: [] });
  });
  it('strips ```json fences', () => {
    assert.deepEqual(
      extractJsonBlock('```json\n{"a":1}\n```'),
      { a: 1 }
    );
  });
  it('strips bare ``` fences', () => {
    assert.deepEqual(
      extractJsonBlock('```\n{"a":1}\n```'),
      { a: 1 }
    );
  });
  it('recovers JSON from leading prose', () => {
    assert.deepEqual(
      extractJsonBlock('Here is the result: {"x":42}'),
      { x: 42 }
    );
  });
  it('returns null on garbage', () => {
    assert.equal(extractJsonBlock('not json'), null);
    assert.equal(extractJsonBlock(''), null);
    assert.equal(extractJsonBlock(null), null);
  });
  it('returns null on truncated JSON', () => {
    assert.equal(extractJsonBlock('{"a":1,'), null);
  });
});

describe('extract-state-changes.normalizeChange', () => {
  const ctx = {
    scopeNames: new Set(['aquifer', 'node']),
    sessionStartedAt: '2026-04-19T00:00:00Z',
    evidenceSessionId: 'sess-1',
  };

  it('accepts a well-formed change', () => {
    const r = normalizeChange({
      entity_name: 'Aquifer',
      attribute: 'version.stable',
      value: '1.3.0',
      valid_from: '2026-04-19T08:00:00Z',
      evidence_text: 'I shipped 1.3.0 this morning',
      confidence: 0.9,
    }, ctx);
    assert.equal(r.entityName, 'Aquifer');
    assert.equal(r.attribute, 'version.stable');
    assert.equal(r.value, '1.3.0');
    assert.equal(r.confidence, 0.9);
    assert.equal(r.source, 'llm');
    assert.equal(r.evidenceSessionId, 'sess-1');
  });

  it('rejects entity not in scope', () => {
    const r = normalizeChange({
      entity_name: 'OutOfScope',
      attribute: 'foo.bar',
      value: 'x',
      valid_from: '2026-04-19T00:00:00Z',
    }, ctx);
    assert.equal(r, null);
  });

  it('rejects malformed attribute', () => {
    const r = normalizeChange({
      entity_name: 'Aquifer',
      attribute: 'Version Stable',
      value: 'x',
      valid_from: '2026-04-19T00:00:00Z',
    }, ctx);
    assert.equal(r, null);
  });

  it('rejects undefined value (null is OK)', () => {
    assert.equal(normalizeChange({
      entity_name: 'Aquifer', attribute: 'a.b', valid_from: 'now',
    }, ctx), null);
    assert.notEqual(normalizeChange({
      entity_name: 'Aquifer', attribute: 'a.b', value: null, valid_from: '2026-04-19',
    }, ctx), null);
  });

  it('clamps confidence to [0,1]', () => {
    const a = normalizeChange({
      entity_name: 'Node', attribute: 'a.b', value: 'x',
      valid_from: '2026-04-19', confidence: 1.5,
    }, ctx);
    assert.equal(a.confidence, 1);
    const b = normalizeChange({
      entity_name: 'Node', attribute: 'a.b', value: 'x',
      valid_from: '2026-04-19', confidence: -0.1,
    }, ctx);
    assert.equal(b.confidence, 0);
  });

  it('truncates evidence_text to 240 chars', () => {
    const longText = 'x'.repeat(500);
    const r = normalizeChange({
      entity_name: 'Aquifer', attribute: 'a.b', value: 'x',
      valid_from: '2026-04-19', evidence_text: longText,
    }, ctx);
    assert.equal(r.evidenceText.length, 240);
  });

  it('falls back to sessionStartedAt when valid_from is missing', () => {
    const r = normalizeChange({
      entity_name: 'Node', attribute: 'a.b', value: 'x',
    }, ctx);
    assert.equal(r.validFrom, new Date('2026-04-19T00:00:00Z').toISOString());
  });
});

describe('extract-state-changes.extractStateChanges', () => {
  it('returns no_llm warning when llmFn is missing', async () => {
    const r = await extractStateChanges([], { llmFn: null, entities: [{ id: 1, name: 'X' }] });
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.warnings, ['no_llm']);
  });

  it('returns no_entities_in_scope when no entities passed', async () => {
    const r = await extractStateChanges([], { llmFn: async () => '{}', entities: [] });
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.warnings, ['no_entities_in_scope']);
  });

  it('parses well-formed LLM output and resolves names', async () => {
    const llmFn = async () => JSON.stringify({
      state_changes: [{
        entity_name: 'Aquifer',
        attribute: 'version.stable',
        value: '1.3.0',
        valid_from: '2026-04-19T08:00:00Z',
        evidence_text: 'shipped 1.3.0',
        confidence: 0.9,
      }],
    });
    const r = await extractStateChanges([], {
      llmFn,
      entities: [{ id: 7, name: 'Aquifer' }],
      sessionStartedAt: '2026-04-19T00:00:00Z',
      evidenceSessionId: 'sess-x',
    });
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].entityName, 'Aquifer');
    assert.equal(r.changes[0].attribute, 'version.stable');
    assert.equal(r.changes[0].value, '1.3.0');
  });

  it('drops low-confidence changes by threshold', async () => {
    const llmFn = async () => JSON.stringify({
      state_changes: [
        { entity_name: 'A', attribute: 'a.b', value: 1, valid_from: '2026-04-19', confidence: 0.5 },
        { entity_name: 'A', attribute: 'a.c', value: 2, valid_from: '2026-04-19', confidence: 0.8 },
      ],
    });
    const r = await extractStateChanges([], {
      llmFn,
      entities: [{ id: 1, name: 'A' }],
      confidenceThreshold: 0.7,
    });
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].attribute, 'a.c');
    assert.match(r.warnings[0], /dropped_1/);
  });

  it('drops out-of-scope entity names', async () => {
    const llmFn = async () => JSON.stringify({
      state_changes: [
        { entity_name: 'NotInScope', attribute: 'a.b', value: 1, valid_from: '2026-04-19', confidence: 0.9 },
      ],
    });
    const r = await extractStateChanges([], {
      llmFn,
      entities: [{ id: 1, name: 'OnlyMe' }],
    });
    assert.equal(r.changes.length, 0);
  });

  it('returns malformed_json warning on garbage LLM output', async () => {
    const llmFn = async () => 'I cannot do that';
    const r = await extractStateChanges([], {
      llmFn,
      entities: [{ id: 1, name: 'X' }],
    });
    assert.equal(r.changes.length, 0);
    assert.deepEqual(r.warnings, ['malformed_json']);
  });

  it('returns llm_error warning on llmFn rejection', async () => {
    const llmFn = async () => { throw new Error('rate limited'); };
    const r = await extractStateChanges([], {
      llmFn,
      entities: [{ id: 1, name: 'X' }],
    });
    assert.equal(r.changes.length, 0);
    assert.match(r.warnings[0], /llm_error: rate limited/);
  });

  it('honours timeout', async () => {
    const llmFn = () => new Promise(resolve => setTimeout(() => resolve('{}'), 200));
    const r = await extractStateChanges([], {
      llmFn,
      entities: [{ id: 1, name: 'X' }],
      timeoutMs: 30,
    });
    assert.equal(r.changes.length, 0);
    assert.match(r.warnings[0], /llm_timeout/);
  });

  it('accepts aliases as valid entity match', async () => {
    const llmFn = async () => JSON.stringify({
      state_changes: [{ entity_name: 'PG', attribute: 'a.b', value: 1, valid_from: '2026-04-19', confidence: 0.9 }],
    });
    const r = await extractStateChanges([], {
      llmFn,
      entities: [{ id: 1, name: 'PostgreSQL', aliases: ['Postgres', 'PG'] }],
    });
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].entityName, 'PG');
  });
});
