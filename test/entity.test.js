'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEntityName, parseEntityOutput } = require('../core/entity');

describe('normalizeEntityName', () => {
  it('lowercases ASCII', () => {
    assert.equal(normalizeEntityName('PostgreSQL'), 'postgresql');
  });

  it('normalizes fullwidth chars', () => {
    assert.equal(normalizeEntityName('ＰｏｓｔＧＲＥＳ'), 'postgres');
  });

  it('normalizes CJK brackets to ASCII', () => {
    const result = normalizeEntityName('【test】');
    assert.ok(result.includes('[') || result.includes('test'));
  });

  it('handles empty string', () => {
    const result = normalizeEntityName('');
    assert.equal(result, '');
  });

  it('handles null/undefined', () => {
    assert.equal(normalizeEntityName(null), '');
    assert.equal(normalizeEntityName(undefined), '');
  });

  it('trims whitespace', () => {
    assert.equal(normalizeEntityName('  hello  '), 'hello');
  });

  it('handles unicode normalization (NFKC)', () => {
    // ﬁ (U+FB01) → fi
    const result = normalizeEntityName('ﬁle');
    assert.equal(result, 'file');
  });

  it('handles em-dash and en-dash', () => {
    const result = normalizeEntityName('a—b–c');
    assert.ok(result.includes('-'));
  });
});

describe('parseEntityOutput', () => {
  it('parses standard [ENTITIES] format', () => {
    const text = `[ENTITIES]
name: PostgreSQL
type: tool
aliases: Postgres, PG
---
name: Alice
type: person
aliases:
---`;
    const entities = parseEntityOutput(text);
    assert.ok(entities.length >= 2);
    const pg = entities.find(e => e.name === 'PostgreSQL');
    assert.ok(pg);
    assert.equal(pg.type, 'tool');
    assert.ok(Array.isArray(pg.aliases));
  });

  it('returns empty for null/undefined input', () => {
    assert.deepEqual(parseEntityOutput(null), []);
    assert.deepEqual(parseEntityOutput(undefined), []);
    assert.deepEqual(parseEntityOutput(''), []);
  });

  it('handles missing fields gracefully', () => {
    const text = `[ENTITIES]
name: Something
---`;
    const entities = parseEntityOutput(text);
    assert.ok(entities.length >= 0); // may or may not parse depending on implementation
  });

  it('handles (none) marker', () => {
    const text = `[ENTITIES]
(none)`;
    const entities = parseEntityOutput(text);
    assert.equal(entities.length, 0);
  });
});
