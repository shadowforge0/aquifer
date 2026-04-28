'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAquifer } = require('../index');
const { buildMemoryBootstrap, createMemoryBootstrap } = require('../core/memory-bootstrap');

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);

function memoryRow(overrides = {}) {
  return {
    id: 1,
    tenant_id: 'default',
    memory_type: 'state',
    canonical_key: 'state:project:aquifer:current',
    scope_key: 'project:aquifer',
    scope_kind: 'project',
    scope_inheritance_mode: 'defaultable',
    status: 'active',
    visible_in_bootstrap: true,
    visible_in_recall: true,
    authority: 'verified_summary',
    accepted_at: '2026-04-28T00:00:00Z',
    summary: 'Current Aquifer state.',
    ...overrides,
  };
}

function normalizeCurrentProjection(raw, surface = 'unknown') {
  const items = Array.isArray(raw)
    ? raw
    : raw.items || raw.records || raw.memories || [];
  const meta = {
    ...(raw && raw.meta ? raw.meta : {}),
    truncated: raw && raw.meta && raw.meta.truncated !== undefined
      ? raw.meta.truncated
      : !!(raw && raw.meta && raw.meta.overflow),
  };
  return {
    items,
    meta,
    surface,
    text: raw && raw.text ? raw.text : '',
  };
}

async function getCurrentProjectionCompat(aq, opts = {}) {
  if (typeof aq.memory.listCurrentMemory === 'function') {
    return normalizeCurrentProjection(await aq.memory.listCurrentMemory(opts), 'listCurrentMemory');
  }
  if (typeof aq.memory.current === 'function') {
    return normalizeCurrentProjection(await aq.memory.current(opts), 'current');
  }
  if (typeof aq.memory.bootstrap === 'function') {
    return normalizeCurrentProjection(
      await aq.memory.bootstrap({ format: 'both', ...opts }),
      'bootstrap_compat',
    );
  }
  throw new Error('current memory API missing: expected aquifer.memory.listCurrentMemory(opts) or aquifer.memory.current(opts)');
}

function makePool(rows, legacySummaryText = 'Legacy session summary must stay process material only.') {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params: params || [] });
      if (text.includes('FROM "aq".memory_records')) {
        return { rows, rowCount: rows.length };
      }
      if (text.includes('FROM "aq".scopes')) {
        return {
          rows: [{ id: 'scope-project', scope_key: 'project:aquifer', scope_kind: 'project' }],
          rowCount: 1,
        };
      }
      if (text.includes('session_summaries')) {
        return {
          rows: [{ summary_text: legacySummaryText, structured_summary: { state: legacySummaryText } }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        query: async (sql, params) => {
          const text = String(sql);
          queries.push({ sql: text, params: params || [] });
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
    async end() {},
  };
}

describe('v1 current memory first slice contract', () => {
  it('projects only active, visible, time-valid, and scope-applicable memory_records', () => {
    const result = buildMemoryBootstrap([
      memoryRow({
        id: 1,
        memory_type: 'constraint',
        canonical_key: 'constraint:user:mk:language',
        scope_key: 'user:mk',
        scope_kind: 'user',
        summary: 'Use Traditional Chinese in this workspace.',
        authority: 'user_explicit',
        accepted_at: '2026-04-28T01:00:00Z',
      }),
      memoryRow({
        id: 2,
        memory_type: 'state',
        canonical_key: 'state:project:aquifer:release',
        scope_key: 'project:aquifer',
        summary: 'Current release decision is still pending.',
        accepted_at: '2026-04-28T02:00:00Z',
      }),
      memoryRow({
        id: 3,
        canonical_key: 'state:project:aquifer:future',
        valid_from: '2026-04-29T00:00:00Z',
        summary: 'Future state must not serve yet.',
      }),
      memoryRow({
        id: 4,
        canonical_key: 'state:project:aquifer:stale',
        stale_after: '2026-04-27T23:59:59Z',
        summary: 'Stale state must not serve.',
      }),
      memoryRow({
        id: 5,
        canonical_key: 'state:project:aquifer:hidden',
        visible_in_bootstrap: false,
        summary: 'Hidden state must not serve.',
      }),
      memoryRow({
        id: 6,
        canonical_key: 'state:project:aquifer:revoked',
        status: 'revoked',
        summary: 'Revoked state must not serve.',
      }),
      memoryRow({
        id: 7,
        canonical_key: 'state:project:other:scope',
        scope_key: 'project:other',
        summary: 'Out-of-scope state must not serve.',
      }),
      memoryRow({
        id: 8,
        canonical_key: 'decision:global:non-inheritable',
        memory_type: 'decision',
        scope_key: 'global',
        scope_kind: 'global',
        scope_inheritance_mode: 'non_inheritable',
        summary: 'Non-inheritable global decision must not leak into project scope.',
      }),
    ], {
      activeScopePath: ['global', 'user:mk', 'project:aquifer'],
      activeScopeKey: 'project:aquifer',
      asOf: '2026-04-28T12:00:00Z',
      format: 'both',
    });

    assert.deepEqual(
      result.memories.map(row => row.canonical_key || row.canonicalKey),
      [
        'state:project:aquifer:release',
        'constraint:user:mk:language',
      ],
    );
    assert.doesNotMatch(result.text, /Future state must not serve yet|Stale state must not serve|Hidden state must not serve|Revoked state must not serve|Out-of-scope state must not serve|Non-inheritable global decision/);
  });

  it('orders scope-qualified current memory before applying bootstrap caller limit', async () => {
    let listInput;
    const memoryBootstrap = createMemoryBootstrap({
      records: {
        async listActive(input) {
          listInput = input;
          return [
            memoryRow({
              id: 1,
              canonical_key: 'state:global:aquifer:release',
              scope_key: 'global',
              scope_kind: 'global',
              summary: 'Global current memory must remain behind project scope under limit.',
            }),
            memoryRow({
              id: 2,
              canonical_key: 'state:project:aquifer:release',
              scope_key: 'project:aquifer',
              scope_kind: 'project',
              summary: 'Project scope current state is first.',
            }),
          ];
        },
      },
    });

    const result = await memoryBootstrap.bootstrap({
      activeScopePath: ['global', 'project:aquifer'],
      activeScopeKey: 'project:aquifer',
      limit: 1,
      format: 'both',
    });

    assert.equal(listInput.limit, 50);
    assert.deepEqual(
      result.memories.map(row => row.summary),
      ['Project scope current state is first.'],
    );
    assert.doesNotMatch(result.text, /Global current memory/);
  });

  it('trims deterministically under budget and reports truncation metadata', () => {
    const rows = [
      memoryRow({
        id: 1,
        memory_type: 'constraint',
        canonical_key: 'constraint:user:mk:language',
        scope_key: 'user:mk',
        scope_kind: 'user',
        summary: `Use Traditional Chinese in this workspace. ${'x'.repeat(100)}`,
        authority: 'user_explicit',
      }),
      memoryRow({
        id: 2,
        memory_type: 'state',
        canonical_key: 'state:project:aquifer:release',
        summary: `Current release decision is still pending. ${'y'.repeat(100)}`,
      }),
      memoryRow({
        id: 3,
        memory_type: 'open_loop',
        canonical_key: 'open_loop:project:aquifer:publish',
        scope_inheritance_mode: 'additive',
        summary: `Decide whether to cut 1.6.1. ${'z'.repeat(100)}`,
      }),
    ];
    const opts = {
      activeScopePath: ['global', 'user:mk', 'project:aquifer'],
      activeScopeKey: 'project:aquifer',
      maxChars: 210,
      format: 'both',
    };

    const a = normalizeCurrentProjection(buildMemoryBootstrap(rows, opts), 'bootstrap_compat');
    const b = normalizeCurrentProjection(buildMemoryBootstrap([...rows].reverse(), opts), 'bootstrap_compat');

    assert.equal(a.meta.truncated, true);
    assert.equal(a.meta.degraded, true);
    assert.equal(a.text, b.text);
    assert.deepEqual(
      a.items.map(row => row.canonical_key || row.canonicalKey),
      b.items.map(row => row.canonical_key || row.canonicalKey),
    );
  });

  it('does not read session summaries or turn empty current projection into current truth', async () => {
    const pool = makePool([]);
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated' },
    });

    const result = await getCurrentProjectionCompat(aq, {
      activeScopePath: ['global', 'project:aquifer'],
      activeScopeKey: 'project:aquifer',
      maxChars: 400,
      limit: 5,
    });

    assert.deepEqual(result.items, []);
    assert.equal(result.meta.source, 'memory_records');
    assert.equal(result.meta.servingContract, 'current_memory_v1');
    assert.equal(result.meta.count, 0);
    assert.equal(pool.queries.some(query => query.sql.includes('session_summaries')), false);
    assert.equal(pool.queries.some(query => query.sql.includes('FROM "aq".memory_records')), true);
    assert.doesNotMatch(result.text, /Legacy session summary must stay process material only/);
  });

  it('exposes a direct current memory projection API with current_memory_v1 metadata', async () => {
    const pool = makePool([
      memoryRow({
        id: 1,
        memory_type: 'constraint',
        canonical_key: 'constraint:user:mk:language',
        scope_key: 'user:mk',
        scope_kind: 'user',
        authority: 'user_explicit',
        summary: 'Use Traditional Chinese in this workspace.',
      }),
      memoryRow({
        id: 2,
        canonical_key: 'state:project:aquifer:current',
        summary: 'Current memory is a memory_records projection.',
      }),
      memoryRow({
        id: 3,
        canonical_key: 'state:project:aquifer:hidden',
        visible_in_bootstrap: false,
        visible_in_recall: false,
        summary: 'Hidden rows must not project.',
      }),
      memoryRow({
        id: 4,
        canonical_key: 'state:project:aquifer:stale',
        stale_after: '2026-04-27T00:00:00Z',
        summary: 'Stale rows must not project.',
      }),
    ]);
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated' },
    });

    const result = await aq.memory.current({
      activeScopePath: ['global', 'user:mk', 'project:aquifer'],
      activeScopeKey: 'project:aquifer',
      asOf: '2026-04-28T12:00:00Z',
      limit: 10,
    });

    assert.equal(result.meta.source, 'memory_records');
    assert.equal(result.meta.servingContract, 'current_memory_v1');
    assert.equal(result.meta.truncated, false);
    assert.deepEqual(result.meta.activeScopePath, ['global', 'user:mk', 'project:aquifer']);
    assert.deepEqual(
      result.memories.map(row => row.canonicalKey),
      ['state:project:aquifer:current', 'constraint:user:mk:language'],
    );
    assert.equal(pool.queries.some(query => query.sql.includes('session_summaries')), false);
  });

  it('supports scopeId-only current memory projection without falling back to global', async () => {
    const pool = makePool([
      memoryRow({
        id: 2,
        canonical_key: 'state:project:aquifer:scope-id',
        scope_key: 'project:aquifer',
        summary: 'ScopeId-only current memory resolves its scope key.',
      }),
    ]);
    const aq = createAquifer({
      db: pool,
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated' },
    });

    const result = await aq.memory.current({
      scopeId: 'scope-project',
      limit: 5,
    });

    assert.deepEqual(result.meta.activeScopePath, ['project:aquifer']);
    assert.equal(result.meta.activeScopeKey, 'project:aquifer');
    assert.deepEqual(
      result.memories.map(row => row.canonicalKey),
      ['state:project:aquifer:scope-id'],
    );
    assert.equal(pool.queries.some(query => query.sql.includes('FROM "aq".scopes')), true);
  });

  it('requires the intended current memory API instead of only bootstrap compatibility', () => {
    const aq = createAquifer({
      db: makePool([]),
      schema: 'aq',
      migrations: { mode: 'off' },
      memory: { servingMode: 'curated' },
    });

    assert.equal(
      typeof aq.memory.listCurrentMemory === 'function' || typeof aq.memory.current === 'function',
      true,
      'integration adjustment required: expose aquifer.memory.listCurrentMemory(opts) or aquifer.memory.current(opts)',
    );
  });

  it('does not define an app-managed current_memory base table or package surface', () => {
    const schemaDir = path.join(__dirname, '..', 'schema');
    const schemaSql = fs.readdirSync(schemaDir)
      .filter(name => name.endsWith('.sql'))
      .map(name => fs.readFileSync(path.join(schemaDir, name), 'utf8'))
      .join('\n');

    assert.doesNotMatch(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS \$\{schema\}\.current_memory\b/,
      '1.6.1 current memory must remain a memory_records projection, not a new base table',
    );
    assert.doesNotMatch(
      schemaSql,
      /ALTER TABLE \$\{schema\}\.current_memory\b/,
      'schema must not introduce an app-managed current_memory table lifecycle',
    );
    assert.equal(
      PACKAGE_JSON.files.some(entry => String(entry).includes('current_memory')),
      false,
    );
    assert.equal(
      Object.keys(PACKAGE_JSON.exports).some(entry => String(entry).includes('current_memory')),
      false,
    );
  });
});
