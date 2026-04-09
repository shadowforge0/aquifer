'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// parseArgs is not exported, so we test by extracting it
// We'll inline a copy for unit testing
const VALUE_FLAGS = new Set(['limit', 'agent-id', 'source', 'date-from', 'date-to', 'output', 'format', 'config', 'status', 'concurrency']);
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { args._.push(...argv.slice(i + 1)); break; }
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.flags[key] = argv[++i];
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

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
    // limit is a VALUE_FLAG but no next arg — should be true (boolean)
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
});
