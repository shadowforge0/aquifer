'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const plugin = require('../consumers/openclaw-plugin');

function mockApi(overrides = {}) {
  const events = {};
  const tools = [];
  const logs = [];
  return {
    pluginConfig: overrides.pluginConfig || {},
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      debug: () => {},
    },
    on(name, fn) { events[name] = fn; },
    registerTool(factory, opts) { tools.push({ factory, opts }); },
    _events: events,
    _tools: tools,
    _logs: logs,
  };
}

describe('openclaw-plugin shape', () => {
  it('exports { id, name, register }', () => {
    assert.equal(plugin.id, 'aquifer-memory');
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.register, 'function');
  });
});

describe('openclaw-plugin persona delegation', () => {
  it('delegates to persona.mountOnOpenClaw when AQUIFER_PERSONA set', () => {
    const personaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-persona-'));
    const personaPath = path.join(personaDir, 'index.js');
    fs.writeFileSync(personaPath, `
      let mounted = false;
      module.exports = {
        mountOnOpenClaw(api, opts) {
          mounted = true;
          api.logger.info('persona-was-here');
        },
        _isMounted: () => mounted,
      };
    `);

    const prev = process.env.AQUIFER_PERSONA;
    process.env.AQUIFER_PERSONA = personaPath;
    try {
      const api = mockApi();
      plugin.register(api);
      const persona = require(personaPath);
      assert.equal(persona._isMounted(), true);
      const info = api._logs.filter(([lvl]) => lvl === 'info').map(([, m]) => m);
      assert.ok(info.some((m) => m.includes('persona-was-here')));
      assert.ok(info.some((m) => m.includes('via persona')));
    } finally {
      if (prev === undefined) delete process.env.AQUIFER_PERSONA;
      else process.env.AQUIFER_PERSONA = prev;
      fs.rmSync(personaDir, { recursive: true, force: true });
    }
  });

  it('falls back to default path when persona lacks mountOnOpenClaw', () => {
    const personaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-persona-'));
    const personaPath = path.join(personaDir, 'index.js');
    fs.writeFileSync(personaPath, `module.exports = { mountOnOpenClaw: 'not a function' };`);

    const prev = { p: process.env.AQUIFER_PERSONA, db: process.env.DATABASE_URL };
    process.env.AQUIFER_PERSONA = personaPath;
    delete process.env.DATABASE_URL;
    delete process.env.AQUIFER_DB_URL;
    try {
      const api = mockApi();
      plugin.register(api);
      const warns = api._logs.filter(([lvl]) => lvl === 'warn').map(([, m]) => m);
      assert.ok(warns.some((m) => m.includes('falling back')));
      // And then default path tried createAquiferFromConfig, which should
      // have warned again because there is no DATABASE_URL.
      assert.ok(warns.some((m) => m.includes('disabled')));
    } finally {
      if (prev.p === undefined) delete process.env.AQUIFER_PERSONA;
      else process.env.AQUIFER_PERSONA = prev.p;
      if (prev.db) process.env.DATABASE_URL = prev.db;
      fs.rmSync(personaDir, { recursive: true, force: true });
    }
  });

  it('no persona, no env → default path disables gracefully when no DB', () => {
    const prev = { db: process.env.DATABASE_URL, aq: process.env.AQUIFER_DB_URL, p: process.env.AQUIFER_PERSONA };
    delete process.env.DATABASE_URL;
    delete process.env.AQUIFER_DB_URL;
    delete process.env.AQUIFER_PERSONA;
    try {
      const api = mockApi();
      plugin.register(api);
      const warns = api._logs.filter(([lvl]) => lvl === 'warn').map(([, m]) => m);
      assert.ok(warns.some((m) => m.includes('disabled')));
    } finally {
      if (prev.db) process.env.DATABASE_URL = prev.db;
      if (prev.aq) process.env.AQUIFER_DB_URL = prev.aq;
      if (prev.p) process.env.AQUIFER_PERSONA = prev.p;
    }
  });
});

describe('openclaw-ext drop-in module', () => {
  it('loads and re-exports the plugin', () => {
    const ext = require('../consumers/openclaw-ext');
    assert.equal(ext.id, 'aquifer-memory');
    assert.equal(typeof ext.register, 'function');
  });
});
