'use strict';

// P3-e — MCP manifest + file writer unit tests.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  MCP_SERVER_NAME, MCP_TOOL_MANIFEST, getMcpManifest, writeMcpManifestFile,
} = require('../index');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-mcp-'));

describe('MCP_TOOL_MANIFEST', () => {
  it('declares all 8 canonical tools', () => {
    const names = MCP_TOOL_MANIFEST.map(t => t.name);
    for (const req of ['session_recall', 'session_feedback', 'memory_stats',
                       'memory_pending', 'session_bootstrap', 'evidence_recall',
                       'memory_feedback']) {
      assert.ok(names.includes(req), `missing tool ${req}`);
    }
    assert.equal(names.length, 8);
  });

  it('every tool has name + description + inputSchema', () => {
    for (const tool of MCP_TOOL_MANIFEST) {
      assert.equal(typeof tool.name, 'string');
      assert.equal(typeof tool.description, 'string');
      assert.equal(typeof tool.inputSchema, 'object');
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  it('session_recall input schema declares query as required', () => {
    const tool = MCP_TOOL_MANIFEST.find(t => t.name === 'session_recall');
    assert.ok(tool.inputSchema.required.includes('query'));
    assert.ok(tool.inputSchema.properties.query);
    assert.equal(tool.inputSchema.properties.query.type, 'string');
  });

  it('declares curated serving scope and memory feedback inputs', () => {
    const recall = MCP_TOOL_MANIFEST.find(t => t.name === 'session_recall');
    assert.ok(recall.inputSchema.properties.activeScopeKey);
    assert.ok(recall.inputSchema.properties.activeScopePath);

    const bootstrap = MCP_TOOL_MANIFEST.find(t => t.name === 'session_bootstrap');
    assert.ok(bootstrap.inputSchema.properties.activeScopeKey);

    const feedback = MCP_TOOL_MANIFEST.find(t => t.name === 'session_feedback');
    assert.ok(feedback.inputSchema.properties.sessionId);
    assert.ok(!feedback.inputSchema.properties.memoryId);

    const memoryFeedback = MCP_TOOL_MANIFEST.find(t => t.name === 'memory_feedback');
    assert.ok(memoryFeedback.inputSchema.properties.memoryId);
    assert.ok(memoryFeedback.inputSchema.properties.canonicalKey);
    assert.ok(memoryFeedback.inputSchema.properties.feedbackType);
  });

  it('evidence_recall declares an explicit unsafe debug override', () => {
    const tool = MCP_TOOL_MANIFEST.find(t => t.name === 'evidence_recall');
    assert.ok(tool.inputSchema.properties.allowUnsafeDebug);
  });

  it('describes curated recall and evidence recall boundaries', () => {
    const recall = MCP_TOOL_MANIFEST.find(t => t.name === 'session_recall');
    const evidence = MCP_TOOL_MANIFEST.find(t => t.name === 'evidence_recall');

    assert.match(recall.description, /curated/i);
    assert.match(recall.description, /evidence_recall/);
    assert.match(evidence.description, /legacy\/evidence/i);
    assert.match(evidence.description, /audit\/debug/i);
  });

  it('manifest is frozen (immutable)', () => {
    assert.ok(Object.isFrozen(MCP_TOOL_MANIFEST));
    assert.throws(() => {
      MCP_TOOL_MANIFEST.push({ name: 'bogus' });
    });
  });
});

describe('getMcpManifest', () => {
  it('returns envelope with serverName + tools + generatedAt', () => {
    const m = getMcpManifest();
    assert.equal(m.serverName, MCP_SERVER_NAME);
    assert.equal(m.tools.length, 8);
    assert.equal(m.manifestVersion, 1);
    assert.ok(m.generatedAt.match(/^\d{4}-\d{2}-\d{2}T/));
  });

  it('returns a deep clone — mutating the result does not leak', () => {
    const m = getMcpManifest();
    m.tools[0].description = 'MUTATED';
    const clean = getMcpManifest();
    assert.notEqual(clean.tools[0].description, 'MUTATED');
  });
});

describe('writeMcpManifestFile', () => {
  const outFile = path.join(outDir, 'contract.json');

  after(() => {
    try { fs.rmSync(outDir, { recursive: true, force: true }); }
    catch { /* ignore */ }
  });

  it('writes parseable JSON with all tools', () => {
    writeMcpManifestFile(outFile);
    assert.ok(fs.existsSync(outFile));
    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(parsed.serverName, MCP_SERVER_NAME);
    assert.equal(parsed.tools.length, 8);
  });

  it('creates parent directory if missing', () => {
    const nested = path.join(outDir, 'a', 'b', 'c.json');
    writeMcpManifestFile(nested);
    assert.ok(fs.existsSync(nested));
  });

  it('rejects empty path', () => {
    assert.throws(() => writeMcpManifestFile(''));
  });
});
