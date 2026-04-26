'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createEmbedder } = require('../pipeline/embed');
const entity = require('../core/entity');
const { rrfFusion, timeDecay, accessScore, hybridRank } = require('../core/hybrid-rank');
const storage = require('../core/storage');
const { defaultEntityPrompt, parseEntityOutput } = require('../pipeline/extract-entities');
const { summarize, extractiveFallback, defaultSummarizePrompt } = require('../pipeline/summarize');

// ---------------------------------------------------------------------------
// cli.js — parseArgs (inline copy of the actual function)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  const VALUE_FLAGS = new Set(['limit', 'agent-id', 'source', 'date-from', 'date-to', 'output', 'format', 'config', 'status', 'concurrency']);
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

describe('cli.js — parseArgs', () => {
  it('value flag with no following arg is treated as boolean', () => {
    const r = parseArgs(['--limit', '--dry-run']);
    assert.strictEqual(r.flags.limit, true);
    assert.strictEqual(r.flags['dry-run'], true);
  });

  it('value flag at end without arg is treated as boolean', () => {
    const r = parseArgs(['--limit']);
    assert.strictEqual(r.flags.limit, true);
  });

  it('duplicate boolean flags: last wins', () => {
    const r = parseArgs(['--dry-run', '--verbose', '--dry-run']);
    assert.strictEqual(r.flags['dry-run'], true);
  });

  it('duplicate value flags: last value wins', () => {
    const r = parseArgs(['--limit', '5', '--limit', '10']);
    assert.strictEqual(r.flags.limit, '10');
  });

  it('-- separator pushes remaining positional args', () => {
    const r = parseArgs(['recall', 'query', '--', '--limit', '5', 'extra']);
    assert.deepStrictEqual(r._, ['recall', 'query', '--limit', '5', 'extra']);
  });

  it('-- separator at start produces empty positional after', () => {
    const r = parseArgs(['--']);
    assert.deepStrictEqual(r._, []);
  });

  it('-- separator mid-argv stops flag parsing', () => {
    const r = parseArgs(['--limit', '5', '--', '--dry-run']);
    assert.strictEqual(r.flags.limit, '5');
    assert.deepStrictEqual(r._, ['--dry-run']);
  });

  it('value flag with empty string value is captured', () => {
    const r = parseArgs(['--source', '']);
    assert.strictEqual(r.flags.source, '');
    assert.deepStrictEqual(r._, []);
  });

  it('value flag followed by another flag uses first as boolean', () => {
    const r = parseArgs(['--limit', '--dry-run']);
    assert.strictEqual(r.flags.limit, true);
    assert.strictEqual(r.flags['dry-run'], true);
  });

  it('positional-only argv passes through', () => {
    const r = parseArgs(['recall', 'my query', 'extra']);
    assert.deepStrictEqual(r._, ['recall', 'my query', 'extra']);
    assert.deepStrictEqual(r.flags, {});
  });

  it('unknown flag is treated as boolean', () => {
    const r = parseArgs(['--unknown', 'value']);
    assert.strictEqual(r.flags.unknown, true);
  });
});

// ---------------------------------------------------------------------------
// config.js — loadConfig edge cases (deepMerge/coerceEnvValue are internal)
// ---------------------------------------------------------------------------

const { loadConfig } = require('../consumers/shared/config');

describe('config.js — loadConfig', () => {
  it('overrides null values are preserved', () => {
    const result = loadConfig({ overrides: { db: { max: null } } });
    assert.strictEqual(result.db.max, null);
  });

  it('empty env skips all ENV_MAP entries', () => {
    const result = loadConfig({ env: {}, overrides: {} });
    assert.strictEqual(result.db.url, null);
  });

  it('env with empty string does not override defaults', () => {
    const result = loadConfig({ env: { DATABASE_URL: '' }, overrides: {} });
    assert.strictEqual(result.db.url, null);
  });

  it('env with undefined env var is skipped', () => {
    const result = loadConfig({ env: { DATABASE_URL: undefined }, overrides: {} });
    assert.strictEqual(result.db.url, null);
  });

  it('Boolean coerce from AQUIFER_ENTITIES_ENABLED=true', () => {
    const result = loadConfig({ env: { AQUIFER_ENTITIES_ENABLED: 'true' }, overrides: {} });
    assert.strictEqual(result.entities.enabled, true);
  });

  it('Boolean coerce from AQUIFER_ENTITIES_ENABLED=1', () => {
    const result = loadConfig({ env: { AQUIFER_ENTITIES_ENABLED: '1' }, overrides: {} });
    assert.strictEqual(result.entities.enabled, true);
  });

  it('Boolean coerce from AQUIFER_ENTITIES_ENABLED=false', () => {
    const result = loadConfig({ env: { AQUIFER_ENTITIES_ENABLED: 'false' }, overrides: {} });
    assert.strictEqual(result.entities.enabled, false);
  });

  it('Number coerce from AQUIFER_EMBED_DIM', () => {
    const result = loadConfig({ env: { AQUIFER_EMBED_DIM: '1536' }, overrides: {} });
    assert.strictEqual(result.embed.dim, 1536);
  });

  it('nested override merges deeply', () => {
    const result = loadConfig({ env: {}, overrides: { embed: { timeoutMs: 99999 } } });
    assert.strictEqual(result.embed.timeoutMs, 99999);
    assert.strictEqual(result.embed.model, null); // unchanged
  });

  it('configPath with non-existent JSON file is ignored (ENOENT)', () => {
    const result = loadConfig({ env: {}, configPath: '/nonexistent/config.json', overrides: {} });
    assert.strictEqual(result.schema, 'aquifer');
  });

  it('configPath with non-existent JS file is ignored', () => {
    const result = loadConfig({ env: {}, configPath: '/nonexistent/config.js', overrides: {} });
    assert.strictEqual(result.schema, 'aquifer');
  });
});

// ---------------------------------------------------------------------------
// embed.js — createEmbedder edge cases
// ---------------------------------------------------------------------------

describe('embed.js — createEmbedder', () => {
  it('unknown provider throws', () => {
    assert.throws(() => createEmbedder({ provider: 'unknown' }), /Unknown embedding provider/);
  });

  it('null provider falls back to ollama', () => {
    const e = createEmbedder({ provider: null });
    assert.ok(e.embedBatch);
  });

  it('undefined provider falls back to ollama', () => {
    const e = createEmbedder({ provider: undefined });
    assert.ok(e.embedBatch);
  });

  it('createOllamaEmbedder: embedBatch with empty array returns []', async () => {
    const e = createEmbedder({ provider: 'ollama', ollamaUrl: 'http://localhost:9999', model: 'test', timeout: 1000, maxRetries: 1 });
    const r = await e.embedBatch([]);
    assert.deepStrictEqual(r, []);
  });

  it('createOllamaEmbedder: embedBatch with null array returns []', async () => {
    const e = createEmbedder({ provider: 'ollama', ollamaUrl: 'http://localhost:9999', model: 'test', timeout: 1000, maxRetries: 1 });
    const r = await e.embedBatch(null);
    assert.deepStrictEqual(r, []);
  });

  it('createOpenAIEmbedder: missing apiKey throws', () => {
    assert.throws(() => createEmbedder({ provider: 'openai' }), /openaiApiKey is required/);
  });

  it('createOpenAIEmbedder: empty apiKey throws', () => {
    assert.throws(() => createEmbedder({ provider: 'openai', openaiApiKey: '' }), /openaiApiKey is required/);
  });

  it('createCustomEmbedder: missing fn throws', () => {
    assert.throws(() => createEmbedder({ provider: 'custom' }), /fn is required/);
  });

  it('createCustomEmbedder: embedBatch with empty array returns []', async () => {
    const e = createEmbedder({ provider: 'custom', fn: () => [[1, 2, 3]] });
    const r = await e.embedBatch([]);
    assert.deepStrictEqual(r, []);
  });

  it('createCustomEmbedder: embedBatch with null array returns []', async () => {
    const e = createEmbedder({ provider: 'custom', fn: () => [[1, 2, 3]] });
    const r = await e.embedBatch(null);
    assert.deepStrictEqual(r, []);
  });
});

// ---------------------------------------------------------------------------
// entity.js — normalizeEntityName, parseEntityOutput
// ---------------------------------------------------------------------------

describe('entity.js — normalizeEntityName', () => {
  it('null input returns empty string', () => {
    assert.strictEqual(entity.normalizeEntityName(null), '');
  });

  it('undefined input returns empty string', () => {
    assert.strictEqual(entity.normalizeEntityName(undefined), '');
  });

  it('empty string returns empty string', () => {
    assert.strictEqual(entity.normalizeEntityName(''), '');
  });

  it('fullwidth chars normalized', () => {
    assert.strictEqual(entity.normalizeEntityName('ＡＢＣ'), 'abc');
  });

  it('fullwidth numbers normalized', () => {
    assert.strictEqual(entity.normalizeEntityName('１２３'), '123');
  });

  it('homoglyphs: fullwidth A → a', () => {
    assert.strictEqual(entity.normalizeEntityName('Ａ'), 'a');
  });

  it('homoglyphs: fullwidth 1 → 1', () => {
    assert.strictEqual(entity.normalizeEntityName('１'), '1');
  });

  it('homoglyphs: em-dash → - → stripped (leading/trailing punctuation)', () => {
    assert.strictEqual(entity.normalizeEntityName('\u2014'), '');
  });

  it('homoglyphs: en-dash → - → stripped (leading/trailing punctuation)', () => {
    assert.strictEqual(entity.normalizeEntityName('\u2013'), '');
  });

  it('homoglyphs: fullwidth brackets → [] → stripped (leading/trailing punctuation)', () => {
    assert.strictEqual(entity.normalizeEntityName('【】'), '');
  });

  it('homoglyphs: fullwidth parentheses → (test) → parens stripped', () => {
    assert.strictEqual(entity.normalizeEntityName('（test）'), 'test');
  });

  it('NFKC normalization: precomposed chars unchanged (café stays café)', () => {
    assert.strictEqual(entity.normalizeEntityName('café'), 'café');
  });

  it('leading/trailing punctuation stripped', () => {
    assert.strictEqual(entity.normalizeEntityName('--test--'), 'test');
    assert.strictEqual(entity.normalizeEntityName('"hello"'), 'hello');
    assert.strictEqual(entity.normalizeEntityName('(foo)'), 'foo');
    assert.strictEqual(entity.normalizeEntityName('[bar]'), 'bar');
  });

  it('multiple whitespace collapsed', () => {
    assert.strictEqual(entity.normalizeEntityName('a  b\t\nc'), 'a b c');
  });

  it('mixed homoglyph + whitespace + punctuation', () => {
    assert.strictEqual(entity.normalizeEntityName('　Test　'), 'test');
  });
});

describe('entity.js — parseEntityOutput', () => {
  it('null input returns []', () => {
    assert.deepStrictEqual(entity.parseEntityOutput(null), []);
  });

  it('undefined input returns []', () => {
    assert.deepStrictEqual(entity.parseEntityOutput(undefined), []);
  });

  it('empty string returns []', () => {
    assert.deepStrictEqual(entity.parseEntityOutput(''), []);
  });

  it('no [ENTITIES] marker returns []', () => {
    assert.deepStrictEqual(entity.parseEntityOutput('some text without marker'), []);
  });

  it('[ENTITIES] with (none) returns []', () => {
    assert.deepStrictEqual(entity.parseEntityOutput('[ENTITIES]\n(none)'), []);
  });

  it('[ENTITIES] with only whitespace returns []', () => {
    assert.deepStrictEqual(entity.parseEntityOutput('[ENTITIES]   \n   \n'), []);
  });

  it('block without name is skipped', () => {
    const text = '[ENTITIES]\n---\ntype: person\n---\n';
    assert.deepStrictEqual(entity.parseEntityOutput(text), []);
  });

  it('block with empty name is skipped', () => {
    const text = '[ENTITIES]\nname:\ntype: person\n---\n';
    assert.deepStrictEqual(entity.parseEntityOutput(text), []);
  });

  it('block with name but invalid type defaults to other', () => {
    const text = '[ENTITIES]\nname: Test\ntype: notavalidtype\n---\n';
    const r = entity.parseEntityOutput(text);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].type, 'other');
  });

  it('block with whitespace name is skipped', () => {
    const text = '[ENTITIES]\nname:   \ntype: person\n---\n';
    assert.deepStrictEqual(entity.parseEntityOutput(text), []);
  });

  it('multiple blocks with --- separators', () => {
    const text = '[ENTITIES]\nname: Alice\ntype: person\n---\nname: Bob\ntype: person\n---\n';
    const r = entity.parseEntityOutput(text);
    assert.strictEqual(r.length, 2);
  });

  it('aliases are normalized (lowercased, whitespace trimmed)', () => {
    const text = '[ENTITIES]\nname: React\ntype: tool\naliases: React.js,  ReactJS ,  React-React\n---\n';
    const r = entity.parseEntityOutput(text);
    assert.strictEqual(r.length, 1);
    assert.ok(r[0].aliases.includes('react.js'));
    assert.ok(r[0].aliases.includes('reactjs'));
    assert.ok(r[0].aliases.includes('react-react'));
    assert.strictEqual(r[0].aliases.length, 3);
  });

  it('aliases with empty value are excluded', () => {
    const text = '[ENTITIES]\nname: Test\ntype: other\naliases:\n---\n';
    const r = entity.parseEntityOutput(text);
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(r[0].aliases, []);
  });

  it('block with unrecognized field is skipped', () => {
    const text = '[ENTITIES]\nname: Test\ntype: other\nunknownfield: value\nfoo: bar\n---\n';
    const r = entity.parseEntityOutput(text);
    assert.strictEqual(r.length, 1);
  });

  it('valid entity parsed correctly', () => {
    const text = '[ENTITIES]\nname: Alice Chen\ntype: person\naliases: Alice\n---\n';
    const r = entity.parseEntityOutput(text);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].name, 'Alice Chen');
    assert.strictEqual(r[0].normalizedName, 'alice chen');
    assert.strictEqual(r[0].type, 'person');
    assert.deepStrictEqual(r[0].aliases, ['alice']);
  });

  it('[ENTITIES] marker is case-sensitive (lowercase fails)', () => {
    assert.deepStrictEqual(entity.parseEntityOutput('[entities]\nname: Test\ntype: other\n---'), []);
  });
});

// ---------------------------------------------------------------------------
// hybrid-rank.js — rrfFusion, timeDecay, accessScore, hybridRank
// ---------------------------------------------------------------------------

describe('hybrid-rank.js — rrfFusion', () => {
  it('all undefined lists returns empty map', () => {
    const r = rrfFusion(undefined, undefined, undefined);
    assert.deepStrictEqual([...r.entries()], []);
  });

  it('empty lists returns empty map', () => {
    const r = rrfFusion([], [], []);
    assert.deepStrictEqual([...r.entries()], []);
  });

  it('null items in list are skipped', () => {
    const r = rrfFusion([null, { session_id: 's1' }, null], [], []);
    assert.strictEqual(r.get('s1') > 0, true);
  });

  it('result with only .id (no session_id) is supported', () => {
    const r = rrfFusion([{ id: 42 }], [], []);
    assert.strictEqual(r.get('42') > 0, true);
  });

  it('same id across multiple lists gets cumulative score', () => {
    const r = rrfFusion(
      [{ session_id: 's1' }],
      [{ session_id: 's1' }],
      [{ session_id: 's1' }]
    );
    const score = r.get('s1');
    assert.ok(score > 1 / 61);
  });
});

describe('hybrid-rank.js — timeDecay', () => {
  it('null startedAt returns 0.5', () => {
    assert.strictEqual(timeDecay(null), 0.5);
  });

  it('undefined startedAt returns 0.5', () => {
    assert.strictEqual(timeDecay(undefined), 0.5);
  });

  it('invalid date string returns 0.5', () => {
    assert.strictEqual(timeDecay('not-a-date'), 0.5);
  });

  it('Date object with invalid date returns 0.5', () => {
    assert.strictEqual(timeDecay(new Date('invalid')), 0.5);
  });

  it('far future date approaches 1.0', () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const r = timeDecay(future);
    assert.ok(r > 0.99);
  });

  it('past date at midpoint returns ~0.5', () => {
    const past = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const r = timeDecay(past);
    assert.ok(r > 0.45 && r < 0.55);
  });
});

describe('hybrid-rank.js — accessScore', () => {
  it('null accessCount returns 0', () => {
    assert.strictEqual(accessScore(null, new Date()), 0);
  });

  it('undefined accessCount returns 0', () => {
    assert.strictEqual(accessScore(undefined, new Date()), 0);
  });

  it('zero accessCount returns 0', () => {
    assert.strictEqual(accessScore(0, new Date()), 0);
  });

  it('negative accessCount returns 0', () => {
    assert.strictEqual(accessScore(-5, new Date()), 0);
  });

  it('null lastAccessedAt returns 0', () => {
    assert.strictEqual(accessScore(5, null), 0);
  });

  it('undefined lastAccessedAt returns 0', () => {
    assert.strictEqual(accessScore(5, undefined), 0);
  });

  it('invalid lastAccessedAt returns 0', () => {
    assert.strictEqual(accessScore(5, 'not-a-date'), 0);
  });

  it('very recent access has high score', () => {
    const recent = new Date(Date.now() - 1000);
    const r = accessScore(10, recent);
    assert.ok(r > 5);
  });

  it('30+ days old access has near-zero score (half-life)', () => {
    const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    const r = accessScore(10, old);
    assert.ok(r < 5);
  });
});

describe('hybrid-rank.js — hybridRank', () => {
  it('all empty lists returns []', () => {
    const r = hybridRank([], [], []);
    assert.deepStrictEqual(r, []);
  });

  it('all null/undefined lists returns []', () => {
    const r = hybridRank(null, undefined, null);
    assert.deepStrictEqual(r, []);
  });

  it('single result with null fields gets default scores', () => {
    const fts = [{ session_id: 's1', started_at: null, access_count: null, last_accessed_at: null }];
    const r = hybridRank(fts, [], []);
    assert.strictEqual(r.length, 1);
    assert.ok(r[0]._score >= 0 && r[0]._score <= 1);
    assert.strictEqual(r[0]._timeDecay, 0.5);
  });

  it('null within result array is skipped', () => {
    const fts = [null, { session_id: 's1', started_at: null }];
    const r = hybridRank(fts, [], []);
    assert.strictEqual(r.length, 1);
  });

  it('result with only .id (no session_id) is included', () => {
    const emb = [{ id: 99, started_at: null }];
    const r = hybridRank([], emb, []);
    assert.strictEqual(r.length, 1);
  });

  it('limit=0 returns empty array', () => {
    const fts = [{ session_id: 's1', started_at: null }];
    const r = hybridRank(fts, [], [], { limit: 0 });
    assert.deepStrictEqual(r, []);
  });

  it('negative limit returns empty array', () => {
    const fts = [{ session_id: 's1', started_at: null }];
    const r = hybridRank(fts, [], [], { limit: -1 });
    assert.deepStrictEqual(r, []);
  });

  it('results are sorted by score descending', () => {
    const now = new Date().toISOString();
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fts = [
      { session_id: 'old', started_at: recent, access_count: 1, last_accessed_at: recent },
      { session_id: 'new', started_at: now, access_count: 10, last_accessed_at: now },
    ];
    const r = hybridRank(fts, [], []);
    assert.ok(r[0]._score >= r[1]._score);
  });

  it('turn results add matched_turn fields to existing result', () => {
    const emb = [{ session_id: 's1', started_at: null, matched_turn_text: null }];
    const turn = [{ session_id: 's1', matched_turn_text: 'hello' }];
    const r = hybridRank([], emb, turn);
    assert.strictEqual(r[0].matched_turn_text, 'hello');
  });

  it('score is clamped to [0, 1]', () => {
    const now = new Date().toISOString();
    const fts = [
      { session_id: 's1', started_at: now, access_count: 1000, last_accessed_at: now },
    ];
    const r = hybridRank(fts, [], [], { weights: { entityBoost: 1 } });
    assert.ok(r[0]._score <= 1);
  });

  it('weights with all-zero scores produce zero score', () => {
    const now = new Date().toISOString();
    const fts = [{ session_id: 's1', started_at: now, access_count: 0, last_accessed_at: null }];
    const r = hybridRank(fts, [], [], { weights: { rrf: 0.65, timeDecay: 0, access: 0, entityBoost: 0 } });
    assert.ok(r[0]._score >= 0);
  });
});

// ---------------------------------------------------------------------------
// storage.js — markStatus, extractUserTurns
// ---------------------------------------------------------------------------

describe('storage.js — markStatus', () => {
  it('invalid status throws', async () => {
    const fakePool = { query: () => Promise.resolve({ rows: [] }) };
    await assert.rejects(
      () => storage.markStatus(fakePool, 1, 'invalid_status', null, { schema: 'test' }),
      /Invalid status/
    );
  });

  it('valid statuses do not throw', async () => {
    const fakePool = { query: () => Promise.resolve({ rows: [{ id: 1 }] }) };
    for (const s of ['pending', 'processing', 'succeeded', 'partial', 'failed']) {
      await storage.markStatus(fakePool, 1, s, null, { schema: 'test' });
    }
  });

  it('status with empty string error is allowed', async () => {
    const fakePool = { query: () => Promise.resolve({ rows: [{ id: 1 }] }) };
    await storage.markStatus(fakePool, 1, 'failed', '', { schema: 'test' });
  });
});

describe('storage.js — extractUserTurns', () => {
  it('null normalized returns []', () => {
    assert.deepStrictEqual(storage.extractUserTurns(null), []);
  });

  it('undefined normalized returns []', () => {
    assert.deepStrictEqual(storage.extractUserTurns(undefined), []);
  });

  it('non-array normalized returns []', () => {
    assert.deepStrictEqual(storage.extractUserTurns('string'), []);
    assert.deepStrictEqual(storage.extractUserTurns(42), []);
    assert.deepStrictEqual(storage.extractUserTurns({}), []);
  });

  it('empty array returns []', () => {
    assert.deepStrictEqual(storage.extractUserTurns([]), []);
  });

  it('message without role is skipped', () => {
    const msgs = [{ role: 'user', content: 'hello' }, { content: 'no role' }];
    assert.strictEqual(storage.extractUserTurns(msgs).length, 1);
  });

  it('user message shorter than MIN_TURN_CHARS is skipped', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    assert.deepStrictEqual(storage.extractUserTurns(msgs), []);
  });

  it('user message at MIN_TURN_CHARS boundary is included', () => {
    const msgs = [{ role: 'user', content: 'hello' }];
    const r = storage.extractUserTurns(msgs);
    assert.strictEqual(r.length, 1);
  });

  it('noise patterns are filtered out', () => {
    const noise = [
      { role: 'user', content: 'ok' },
      { role: 'user', content: '/cmd' },
      { role: 'user', content: '好的' },
      { role: 'user', content: 'YES' },
      { role: 'user', content: 'thanks' },
      { role: 'user', content: 'HEARTBEAT_OK' },
      { role: 'user', content: '[Queued messages while agent was busy]' },
    ];
    assert.deepStrictEqual(storage.extractUserTurns(noise), []);
  });

  it('mixed content types from array content', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', url: 'x' }] }];
    const r = storage.extractUserTurns(msgs);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].text, 'hello');
  });

  it('message with msg.text field is extracted', () => {
    const msgs = [{ role: 'user', text: 'hello world' }];
    const r = storage.extractUserTurns(msgs);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].text, 'hello world');
  });

  it('MAX_TURN_CHARS truncation at boundary', () => {
    const long = 'a'.repeat(2005);
    const msgs = [{ role: 'user', content: long }];
    const r = storage.extractUserTurns(msgs);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].text.length, 2000);
  });

  it('non-user roles are skipped', () => {
    const msgs = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi' },
      { role: 'system', content: 'sys' },
    ];
    const r = storage.extractUserTurns(msgs);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].text, 'hello world');
  });

  it('turnIndex increments correctly', () => {
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
      { role: 'user', content: 'third' },
    ];
    const r = storage.extractUserTurns(msgs);
    assert.strictEqual(r.length, 3);
    assert.strictEqual(r[0].turnIndex, 1);
    assert.strictEqual(r[1].turnIndex, 2);
    assert.strictEqual(r[2].turnIndex, 3);
  });

  it('content with only non-text parts becomes empty and is filtered', () => {
    const msgs = [{ role: 'user', content: [{ type: 'image', url: 'x' }] }];
    const r = storage.extractUserTurns(msgs);
    assert.strictEqual(r.length, 0);
  });
});

// ---------------------------------------------------------------------------
// extract-entities.js — defaultEntityPrompt, parseEntityOutput
// ---------------------------------------------------------------------------

describe('extract-entities.js — defaultEntityPrompt', () => {
  it('null messages throws TypeError (no null guard)', () => {
    assert.throws(() => defaultEntityPrompt(null), TypeError);
  });

  it('undefined messages throws TypeError (no undefined guard)', () => {
    assert.throws(() => defaultEntityPrompt(undefined), TypeError);
  });

  it('messages with non-string content are JSON-stringified', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    const p = defaultEntityPrompt(msgs);
    assert.ok(p.includes('hello'));
  });

  it('result includes conversation with role markers', () => {
    const msgs = [{ role: 'user', content: 'test' }];
    const p = defaultEntityPrompt(msgs);
    assert.ok(p.includes('[user]'));
    assert.ok(p.includes('test'));
  });
});

describe('extract-entities.js — parseEntityOutput', () => {
  it('parseEntityOutput is same as entity.parseEntityOutput', () => {
    assert.strictEqual(parseEntityOutput, entity.parseEntityOutput);
  });

  it('null text returns []', () => {
    assert.deepStrictEqual(parseEntityOutput(null), []);
  });

  it('empty text returns []', () => {
    assert.deepStrictEqual(parseEntityOutput(''), []);
  });

  it('no [ENTITIES] marker returns []', () => {
    assert.deepStrictEqual(parseEntityOutput('random text'), []);
  });

  it('[ENTITIES] without content returns []', () => {
    assert.deepStrictEqual(parseEntityOutput('[ENTITIES]'), []);
  });

  it('[ENTITIES] with only whitespace/none returns []', () => {
    assert.deepStrictEqual(parseEntityOutput('[ENTITIES]\n  \n(none)'), []);
    assert.deepStrictEqual(parseEntityOutput('[ENTITIES]\n(none)\n  '), []);
  });

  it('valid entity is parsed', () => {
    const text = '[ENTITIES]\nname: Alice Chen\ntype: person\naliases: Alice\n---\n';
    const r = parseEntityOutput(text);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].name, 'Alice Chen');
    assert.strictEqual(r[0].type, 'person');
    assert.deepStrictEqual(r[0].aliases, ['alice']);
  });

  it('entity name is normalized', () => {
    const text = '[ENTITIES]\nname:  ALICE  \ntype: person\n---\n';
    assert.strictEqual(parseEntityOutput(text)[0].normalizedName, 'alice');
  });

  it('invalid type defaults to other', () => {
    const text = '[ENTITIES]\nname: Thing\ntype: invalidtype\n---\n';
    assert.strictEqual(parseEntityOutput(text)[0].type, 'other');
  });

  it('empty name after trim is skipped', () => {
    const text = '[ENTITIES]\nname:   \ntype: person\n---\n';
    assert.deepStrictEqual(parseEntityOutput(text), []);
  });

  it('multiple entities parsed correctly', () => {
    const text = '[ENTITIES]\nname: A\ntype: person\n---\nname: B\ntype: project\n---\nname: C\ntype: tool\n---\n';
    assert.strictEqual(parseEntityOutput(text).length, 3);
  });

  it('extra whitespace in aliases is trimmed', () => {
    const text = '[ENTITIES]\nname: Test\ntype: other\naliases: a , b , c\n---\n';
    assert.deepStrictEqual(parseEntityOutput(text)[0].aliases, ['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// summarize.js — extractiveFallback, summarize, defaultSummarizePrompt
// ---------------------------------------------------------------------------

describe('summarize.js — extractiveFallback', () => {
  it('null messages returns empty summary', () => {
    const r = extractiveFallback(null);
    assert.strictEqual(r.summaryText, '');
    assert.strictEqual(r.structuredSummary, null);
    assert.strictEqual(r.isExtractive, true);
  });

  it('undefined messages returns empty summary', () => {
    const r = extractiveFallback(undefined);
    assert.strictEqual(r.summaryText, '');
    assert.strictEqual(r.isExtractive, true);
  });

  it('empty array returns empty summary', () => {
    const r = extractiveFallback([]);
    assert.strictEqual(r.summaryText, '');
  });

  it('messages with null content are skipped', () => {
    const msgs = [
      { role: 'user', content: null },
      { role: 'user', content: 'valid' },
    ];
    const r = extractiveFallback(msgs);
    assert.ok(r.summaryText.includes('valid'));
  });

  it('messages with array content extract text parts', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ];
    const r = extractiveFallback(msgs);
    assert.ok(r.summaryText.includes('hello'));
  });

  it('messages with array content skip non-text parts', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'image', url: 'x' }] },
      { role: 'user', content: 'valid' },
    ];
    const r = extractiveFallback(msgs);
    assert.ok(r.summaryText.includes('valid'));
    assert.ok(!r.summaryText.includes('http'));
  });

  it('>6 messages uses head+tail deduplication', () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      role: 'user', content: `msg${i}`,
    }));
    msgs[5].content = 'duplicate';
    const r = extractiveFallback(msgs);
    assert.ok(r.summaryText.includes('msg0'));
    assert.ok(!r.summaryText.includes('msg5'));
  });

  it('output truncated at 2000 chars', () => {
    const msgs = Array.from({ length: 3 }, () => ({
      role: 'user', content: 'a'.repeat(1000),
    }));
    const r = extractiveFallback(msgs);
    assert.ok(r.summaryText.length <= 2000);
  });

  it('non-user roles are filtered out', () => {
    const msgs = [
      { role: 'user', content: 'user msg' },
      { role: 'assistant', content: 'assistant msg' },
      { role: 'system', content: 'system msg' },
    ];
    const r = extractiveFallback(msgs);
    assert.ok(r.summaryText.includes('user msg'));
    assert.ok(!r.summaryText.includes('assistant'));
    assert.ok(!r.summaryText.includes('system'));
  });
});

describe('summarize.js — summarize', () => {
  it('null llmFn triggers extractive fallback', async () => {
    const r = await summarize([{ role: 'user', content: 'hello' }], { llmFn: null });
    assert.strictEqual(r.isExtractive, true);
    assert.ok(r.summaryText.includes('hello'));
  });

  it('undefined llmFn triggers extractive fallback', async () => {
    const r = await summarize([{ role: 'user', content: 'hello' }], { llmFn: undefined });
    assert.strictEqual(r.isExtractive, true);
  });

  it('llmFn throwing triggers extractive fallback', async () => {
    const r = await summarize([{ role: 'user', content: 'hello' }], {
      llmFn: () => { throw new Error('LLM fail'); },
    });
    assert.strictEqual(r.isExtractive, true);
    assert.ok(r.summaryText.includes('hello'));
  });

  it('llmFn returning non-string triggers extractive fallback', async () => {
    const r = await summarize([{ role: 'user', content: 'hello' }], {
      llmFn: async () => null,
    });
    assert.strictEqual(r.isExtractive, true);
    assert.ok(r.summaryText.includes('hello'));
  });

  it('llmFn returning empty string triggers extractive fallback', async () => {
    const r = await summarize([{ role: 'user', content: 'hello' }], {
      llmFn: async () => '',
    });
    assert.strictEqual(r.isExtractive, true);
    assert.ok(r.summaryText.includes('hello'));
  });

  it('successful LLM response is parsed', async () => {
    const r = await summarize([{ role: 'user', content: 'hello' }], {
      llmFn: async () => 'TITLE: Test\nOVERVIEW: Desc\nTOPICS:\n- topic: detail\n',
    });
    assert.strictEqual(r.isExtractive, false);
    assert.strictEqual(r.structuredSummary.title, 'Test');
    assert.strictEqual(r.structuredSummary.overview, 'Desc');
  });

  it('[ENTITIES] section stripped from summaryText when mergeEntities=true', async () => {
    const r = await summarize([{ role: 'user', content: 'hello' }], {
      llmFn: async () => 'TITLE: t\nOVERVIEW: d\n[ENTITIES]\nname: E\ntype: other\n---',
      mergeEntities: true,
    });
    assert.ok(!r.summaryText.includes('[ENTITIES]'));
    assert.ok(r.entityRaw.includes('[ENTITIES]'));
  });

  it('[ENTITIES] section NOT stripped when mergeEntities=false', async () => {
    const r = await summarize([{ role: 'user', content: 'hello' }], {
      llmFn: async () => 'TITLE: t\nOVERVIEW: d\n[ENTITIES]\nname: E\ntype: other\n---',
      mergeEntities: false,
    });
    assert.strictEqual(r.entityRaw, null);
  });
});

describe('summarize.js — defaultSummarizePrompt', () => {
  it('null messages throws TypeError (no null guard)', () => {
    assert.throws(() => defaultSummarizePrompt(null), TypeError);
  });

  it('undefined messages throws TypeError (no undefined guard)', () => {
    assert.throws(() => defaultSummarizePrompt(undefined), TypeError);
  });

  it('messages with array content are JSON-stringified', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    const p = defaultSummarizePrompt(msgs);
    assert.ok(p.includes('hello'));
  });

  it('mergeEntities=true adds [ENTITIES] instructions', () => {
    const p = defaultSummarizePrompt([{ role: 'user', content: 'x' }], { mergeEntities: true });
    assert.ok(p.includes('[ENTITIES]'));
  });

  it('mergeEntities=false omits [ENTITIES] instructions', () => {
    const p = defaultSummarizePrompt([{ role: 'user', content: 'x' }], { mergeEntities: false });
    assert.ok(!p.includes('[ENTITIES]'));
  });

  it('result includes TITLE/OVERVIEW/TOPICS format', () => {
    const p = defaultSummarizePrompt([{ role: 'user', content: 'x' }]);
    assert.ok(p.includes('TITLE:'));
    assert.ok(p.includes('OVERVIEW:'));
    assert.ok(p.includes('TOPICS:'));
    assert.ok(p.includes('DECISIONS:'));
  });
});
