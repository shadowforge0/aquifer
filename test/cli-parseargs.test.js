'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseArgs,
  selectedBackendInfo,
  cmdLocalQuickstart,
  cmdOperator,
  readSynthesisSummaryFromFlags,
} = require('../consumers/cli');

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

  it('reports local backend info without database config', () => {
    const info = selectedBackendInfo({
      env: {
        AQUIFER_BACKEND: 'local',
        AQUIFER_LOCAL_PATH: '/tmp/aquifer-local.json',
      },
      cwd: '/nonexistent',
    });
    assert.equal(info.backendKind, 'local');
    assert.equal(info.backendProfile, 'starter');
    assert.equal(info.storage.postgresUrlConfigured, false);
    assert.equal(info.storage.localPath, '/tmp/aquifer-local.json');
    assert.equal(info.capabilities.zeroConfig, 'full');
  });

  it('runs backend-info --json without requiring PostgreSQL env', () => {
    const result = spawnSync(process.execPath, ['consumers/cli.js', 'backend-info', '--json'], {
      cwd: path.join(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        AQUIFER_BACKEND: 'local',
        AQUIFER_LOCAL_PATH: '/tmp/aquifer-local.json',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const info = JSON.parse(result.stdout);
    assert.equal(info.backendKind, 'local');
    assert.equal(info.backendProfile, 'starter');
    assert.equal(info.storage.postgresUrlConfigured, false);
  });

  it('runs local quickstart without PostgreSQL and cleans up the test session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquifer-local-quickstart-'));
    const filePath = path.join(dir, 'aquifer.local.json');
    const { createAquiferFromConfig } = require('../consumers/shared/factory');
    const aquifer = createAquiferFromConfig({
      db: { url: null },
      storage: {
        backend: 'local',
        local: { path: filePath },
      },
    });
    const logs = [];
    const originalLog = console.log;
    console.log = (...items) => logs.push(items.join(' '));
    try {
      await cmdLocalQuickstart(aquifer);
    } finally {
      console.log = originalLog;
      await aquifer.close();
    }

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(raw.sessions.length, 0);
    assert.match(logs.join('\n'), /local starter is working/);
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

  it('parses timer synthesis operator flags', () => {
    const args = parseArgs([
      'operator',
      'compaction',
      'daily',
      '--include-synthesis-prompt',
      '--synthesis-summary-file',
      '/tmp/timer-summary.json',
      '--promote-candidates',
    ]);
    assert.equal(args.flags['include-synthesis-prompt'], true);
    assert.equal(args.flags['synthesis-summary-file'], '/tmp/timer-summary.json');
    assert.equal(args.flags['promote-candidates'], true);
  });

  it('parses checkpoint producer operator flags', () => {
    const args = parseArgs([
      'operator',
      'checkpoint',
      '--scope-id',
      '7',
      '--scope-key',
      'project:aquifer',
      '--min-finalizations',
      '10',
      '--checkpoint-key',
      'manual-checkpoint',
      '--synthesis-summary-file',
      '/tmp/checkpoint-summary.json',
      '--apply',
      '--finalize',
    ]);
    assert.equal(args.flags['scope-id'], '7');
    assert.equal(args.flags['scope-key'], 'project:aquifer');
    assert.equal(args.flags['min-finalizations'], '10');
    assert.equal(args.flags['checkpoint-key'], 'manual-checkpoint');
    assert.equal(args.flags['synthesis-summary-file'], '/tmp/checkpoint-summary.json');
    assert.equal(args.flags.apply, true);
    assert.equal(args.flags.finalize, true);
  });

  it('reads synthesis summary JSON from a flag file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquifer-cli-'));
    const filePath = path.join(dir, 'summary.json');
    fs.writeFileSync(filePath, JSON.stringify({
      summaryText: 'Timer summary',
      structuredSummary: { states: [{ state: 'CLI can read timer synthesis JSON.' }] },
    }));
    const summary = readSynthesisSummaryFromFlags({ 'synthesis-summary-file': filePath });
    assert.equal(summary.summaryText, 'Timer summary');
    assert.equal(summary.structuredSummary.states[0].state, 'CLI can read timer synthesis JSON.');
  });

  it('passes timer synthesis producer controls into operator runJob', async () => {
    const args = parseArgs([
      'operator',
      'compaction',
      'daily',
      '--scope-kind',
      'project',
      '--scope-key',
      'project:aquifer',
      '--synthesis-summary',
      '{"summaryText":"Timer","structuredSummary":{"states":[{"state":"CLI end-to-end timer producer state."}]}}',
      '--include-synthesis-prompt',
      '--apply',
      '--promote-candidates',
    ]);
    let receivedInput = null;
    const fakeAquifer = {
      memory: {
        consolidation: {
          async runJob(input) {
            receivedInput = input;
            return {
              dryRun: false,
              cadence: input.cadence,
              periodStart: '2026-04-27T00:00:00.000Z',
              periodEnd: '2026-04-28T00:00:00.000Z',
              snapshotCount: 1,
              snapshotTruncated: false,
              plan: {
                statusUpdates: [],
                candidates: [{ memoryType: 'state' }],
              },
              synthesisPrompt: 'timer prompt',
              promotionReview: 'Promotion review:\ncandidates: planned=1 promoted=1 quarantined=0 errored=0',
              run: { id: 7, status: 'applied' },
            };
          },
        },
      },
    };
    const logs = [];
    const originalLog = console.log;
    console.log = (...items) => logs.push(items.join(' '));
    try {
      await cmdOperator(fakeAquifer, args);
    } finally {
      console.log = originalLog;
    }

    assert.equal(receivedInput.job, 'compaction');
    assert.equal(receivedInput.cadence, 'daily');
    assert.equal(receivedInput.scopeKind, 'project');
    assert.equal(receivedInput.scopeKey, 'project:aquifer');
    assert.equal(receivedInput.includeSynthesisPrompt, true);
    assert.equal(receivedInput.apply, true);
    assert.equal(receivedInput.promoteCandidates, true);
    assert.equal(receivedInput.synthesisSummary.summaryText, 'Timer');
    assert.equal(receivedInput.synthesisSummary.structuredSummary.states[0].state, 'CLI end-to-end timer producer state.');
    assert.match(logs.join('\n'), /Synthesis prompt/);
    assert.match(logs.join('\n'), /Promotion review/);
  });

  it('passes checkpoint producer controls into operator runProducer', async () => {
    const args = parseArgs([
      'operator',
      'checkpoint',
      '--scope-id',
      '7',
      '--min-finalizations',
      '3',
      '--synthesis-summary',
      '{"summaryText":"Checkpoint","structuredSummary":{"states":[{"state":"CLI checkpoint producer state."}]}}',
      '--include-synthesis-prompt',
      '--apply',
      '--finalize',
    ]);
    let receivedInput = null;
    const fakeAquifer = {
      checkpoints: {
        async runProducer(input) {
          receivedInput = input;
          return {
            due: true,
            scope: { scopeKey: 'project:aquifer' },
            sourceFinalizationCount: 3,
            minFinalizations: 3,
            range: {
              fromFinalizationIdExclusive: 10,
              toFinalizationIdInclusive: 13,
            },
            synthesisPrompt: 'checkpoint prompt',
            run: { id: 9, status: 'finalized' },
          };
        },
      },
    };
    const logs = [];
    const originalLog = console.log;
    console.log = (...items) => logs.push(items.join(' '));
    try {
      await cmdOperator(fakeAquifer, args);
    } finally {
      console.log = originalLog;
    }

    assert.equal(receivedInput.scopeId, '7');
    assert.equal(receivedInput.minFinalizations, 3);
    assert.equal(receivedInput.includeSynthesisPrompt, true);
    assert.equal(receivedInput.apply, true);
    assert.equal(receivedInput.finalize, true);
    assert.equal(receivedInput.synthesisSummary.summaryText, 'Checkpoint');
    assert.match(logs.join('\n'), /Checkpoint due/);
    assert.match(logs.join('\n'), /Checkpoint synthesis prompt/);
    assert.match(logs.join('\n'), /Run: #9 status=finalized/);
  });
});
