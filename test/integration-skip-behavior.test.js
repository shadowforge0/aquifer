'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const DB_GATED_SMOKE_MATRIX = Object.freeze([
  'artifacts.integration.test.js',
  'bundles.integration.test.js',
  'completion.integration.test.js',
  'consolidation.integration.test.js',
  'consumer-cli.integration.test.js',
  'consumer-mcp.integration.test.js',
  'consumer-opencode.integration.test.js',
  'decisions.integration.test.js',
  'handoff.integration.test.js',
  'insights-semantic-dedup.integration.test.js',
  'integration.test.js',
  'migration-fts.integration.test.js',
  'migration-handshake.integration.test.js',
  'narratives.integration.test.js',
  'profiles.integration.test.js',
  'session-ended-at.integration.test.js',
  'state.integration.test.js',
  'timeline.integration.test.js',
  'v1-compaction-claim.integration.test.js',
  'v1-curated-writer.integration.test.js',
]);

function runNodeTest(file) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('NODE_TEST_')) {
      env[key] = value;
    }
  }
  delete env.AQUIFER_TEST_DB_URL;

  const result = spawnSync(
    process.execPath,
    ['--test', path.join(__dirname, file)],
    {
      cwd: path.join(__dirname, '..'),
      env,
      encoding: 'utf8',
      timeout: 30000,
    }
  );

  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('DB-gated integration smoke matrix', () => {
  for (const file of DB_GATED_SMOKE_MATRIX) {
    it(`${file} reports a node:test skip when AQUIFER_TEST_DB_URL is missing`, () => {
      const result = runNodeTest(file);
      const output = `${result.stdout}\n${result.stderr}`;

      assert.equal(result.signal, null, `${file} terminated unexpectedly`);
      assert.equal(result.code, 0, `${file} exited non-zero:\n${output}`);
      assert.match(
        output,
        /requires AQUIFER_TEST_DB_URL/,
        `${file} did not explain the missing DB requirement:\n${output}`
      );
      assert.match(
        output,
        /# SKIP|skipped\s+1\b/i,
        `${file} did not surface a node:test skip:\n${output}`
      );
    });
  }
});
