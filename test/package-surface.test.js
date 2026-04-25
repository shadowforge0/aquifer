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
      '/consumers/claude-code',
      '/consumers/default',
      '/consumers/miranda',
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

  it('keeps consumers/miranda as a deprecated optional-adapter shim', () => {
    const miranda = require(PKG + '/consumers/miranda');

    assert.equal(miranda.deprecated, true);
    assert.equal(miranda.adapterPackage, '@mingko/aquifer-miranda-adapter');
    assert.equal(typeof miranda.mountOnOpenClaw, 'function');
    assert.throws(
      () => miranda.mountOnOpenClaw({}, {}),
      /@mingko\/aquifer-miranda-adapter/
    );
  });

  it('packs generic consumer files and only the Miranda shim', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: __dirname + '/..',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [pack] = JSON.parse(raw);
    const paths = new Set(pack.files.map(f => f.path));

    assert.ok(paths.has('consumers/shared/summary-parser.js'));
    assert.ok(paths.has('consumers/default/index.js'));
    assert.ok(paths.has('consumers/miranda/index.js'));
    const mirandaPaths = [...paths].filter(p => p.startsWith('consumers/miranda/')).sort();
    assert.deepEqual(mirandaPaths, ['consumers/miranda/index.js']);
  });
});
