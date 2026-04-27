'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const PKG = '@shadowforge0/aquifer-memory';

describe('package surface', () => {
  it('exports supported public subpaths', () => {
    const subpaths = [
      '',
      '/consumers/mcp',
      '/consumers/openclaw-plugin',
      '/consumers/opencode',
      '/consumers/codex',
      '/consumers/codex-handoff',
      '/consumers/claude-code',
      '/consumers/default',
      '/consumers/openclaw-ext',
      '/consumers/shared/config',
      '/consumers/shared/factory',
      '/consumers/shared/entity-parser',
      '/consumers/shared/normalize',
      '/consumers/shared/ingest',
      '/consumers/shared/recall-format',
      '/consumers/shared/summary-parser',
      '/consumers/shared/llm-autodetect',
    ];

    for (const subpath of subpaths) {
      assert.doesNotThrow(() => require(PKG + subpath), `require(${PKG}${subpath})`);
    }
  });

  it('does not publish private persona adapter shims', () => {
    assert.throws(
      () => require(PKG + '/consumers/miranda'),
      /Package subpath '\.\/consumers\/miranda' is not defined/
    );
  });

  it('packs release docs/config while excluding internal and destructive helpers', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: __dirname + '/..',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [pack] = JSON.parse(raw);
    const paths = new Set(pack.files.map(f => f.path));

    assert.ok(paths.has('consumers/shared/summary-parser.js'));
    assert.ok(paths.has('consumers/default/index.js'));
    assert.ok(paths.has('consumers/codex-handoff.js'));
    assert.ok(paths.has('scripts/codex-recovery.js'));
    assert.ok(paths.has('.env.example'));
    assert.ok(paths.has('README_TW.md'));
    assert.ok(paths.has('README_CN.md'));
    assert.ok(paths.has('aquifer.config.example.json'));
    assert.ok(paths.has('docs/getting-started.md'));
    assert.ok(paths.has('docs/postprocess-contract.md'));
    assert.ok(paths.has('docs/setup.md'));
    assert.ok(!paths.has('docs/memory-scope-v1.md'));
    assert.ok(!paths.has('docs/memory-v1-roadmap.md'));
    assert.ok(!paths.has('scripts/drop-entity-state-history.sql'));
    assert.ok(!paths.has('scripts/drop-insights.sql'));
    assert.ok(!paths.has('scripts/install-openclaw.sh'));
    const mirandaPaths = [...paths].filter(p => p.startsWith('consumers/miranda/')).sort();
    assert.deepEqual(mirandaPaths, []);
  });
});
