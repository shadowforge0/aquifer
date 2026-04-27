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
    const args = parseArgs(['recall', 'q', '--limit', '10', '--agent-id', 'cc', '--mode', 'fts']);
    assert.equal(args.flags.limit, '10');
    assert.equal(args.flags['agent-id'], 'cc');
    assert.equal(args.flags.mode, 'fts');
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

  it('parses curated memory scope and feedback flags as values', () => {
    const args = parseArgs([
      'recall',
      'curated',
      '--active-scope-key',
      'project:aquifer',
      '--active-scope-path',
      'global,project:aquifer',
      '--memory-id',
      '42',
      '--feedback-type',
      'incorrect',
      '--canonical-key',
      'decision:project:aquifer:scope-safe-serving',
    ]);
    assert.equal(args.flags['active-scope-key'], 'project:aquifer');
    assert.equal(args.flags['active-scope-path'], 'global,project:aquifer');
    assert.equal(args.flags['memory-id'], '42');
    assert.equal(args.flags['feedback-type'], 'incorrect');
    assert.equal(args.flags['canonical-key'], 'decision:project:aquifer:scope-safe-serving');
  });

  it('parses compaction operator value flags', () => {
    const args = parseArgs([
      'compact',
      '--cadence',
      'daily',
      '--period-start',
      '2026-04-27T00:00:00Z',
      '--period-end',
      '2026-04-28T00:00:00Z',
      '--policy-version',
      'v1',
      '--worker-id',
      'worker-a',
    ]);
    assert.equal(args.flags.cadence, 'daily');
    assert.equal(args.flags['period-start'], '2026-04-27T00:00:00Z');
    assert.equal(args.flags['period-end'], '2026-04-28T00:00:00Z');
    assert.equal(args.flags['policy-version'], 'v1');
    assert.equal(args.flags['worker-id'], 'worker-a');
  });
});
