'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../consumers/cli');

describe('parseArgs', () => {
  it('parses positional args', () => {
    const args = parseArgs(['recall', 'hello world']);
    assert.deepEqual(args._, ['recall', 'hello world']);
  });

  it('parses value flags', () => {
    const args = parseArgs(['recall', 'q', '--limit', '10', '--agent-id', 'cc']);
    assert.equal(args.flags.limit, '10');
    assert.equal(args.flags['agent-id'], 'cc');
  });

  it('parses boolean flags', () => {
    const args = parseArgs(['backfill', '--dry-run', '--json']);
    assert.equal(args.flags['dry-run'], true);
    assert.equal(args.flags.json, true);
  });

  it('handles --limit at end without value as boolean', () => {
    const args = parseArgs(['recall', 'q', '--limit']);
    assert.equal(args.flags.limit, true);
  });

  it('supports -- separator', () => {
    const args = parseArgs(['recall', '--', '--not-a-flag', 'more']);
    assert.deepEqual(args._, ['recall', '--not-a-flag', 'more']);
    assert.deepEqual(args.flags, {});
  });

  it('handles mixed positional and flags', () => {
    const args = parseArgs(['recall', 'my query', '--limit', '5', '--json']);
    assert.deepEqual(args._, ['recall', 'my query']);
    assert.equal(args.flags.limit, '5');
    assert.equal(args.flags.json, true);
  });

  it('last flag wins on duplicates', () => {
    const args = parseArgs(['recall', 'q', '--limit', '5', '--limit', '10']);
    assert.equal(args.flags.limit, '10');
  });

  it('handles empty argv', () => {
    const args = parseArgs([]);
    assert.deepEqual(args._, []);
    assert.deepEqual(args.flags, {});
  });

  it('unknown flags are boolean', () => {
    const args = parseArgs(['--unknown-flag', 'some-value']);
    assert.equal(args.flags['unknown-flag'], true);
    assert.deepEqual(args._, ['some-value']);
  });

  // New: flags added after original test was written
  it('parses --entities as value flag', () => {
    const args = parseArgs(['recall', 'q', '--entities', 'Aquifer,Miranda']);
    assert.equal(args.flags.entities, 'Aquifer,Miranda');
  });

  it('parses --entity-mode as value flag', () => {
    const args = parseArgs(['recall', 'q', '--entity-mode', 'all']);
    assert.equal(args.flags['entity-mode'], 'all');
  });

  it('parses --session-id as value flag', () => {
    const args = parseArgs(['feedback', '--session-id', 'abc-123', '--verdict', 'helpful']);
    assert.equal(args.flags['session-id'], 'abc-123');
    assert.equal(args.flags.verdict, 'helpful');
  });

  it('parses --note as value flag', () => {
    const args = parseArgs(['feedback', '--session-id', 'x', '--verdict', 'unhelpful', '--note', 'bad quality']);
    assert.equal(args.flags.note, 'bad quality');
  });
});
