'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createEntityState,
  defaultIdempotencyKey,
  canonicalJson,
  validateChange,
} = require('../core/entity-state');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('entity-state.canonicalJson', () => {
  it('sorts object keys recursively', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { z: 2, y: 1 } }),
      '{"a":{"y":1,"z":2},"b":1}'
    );
  });
  it('preserves array order', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  });
  it('serialises null distinctly from undefined-key', () => {
    assert.equal(canonicalJson(null), 'null');
  });
  it('handles primitives', () => {
    assert.equal(canonicalJson('s'), '"s"');
    assert.equal(canonicalJson(42), '42');
    assert.equal(canonicalJson(true), 'true');
  });
});

describe('entity-state.defaultIdempotencyKey', () => {
  it('produces stable hash for equivalent inputs', () => {
    const a = defaultIdempotencyKey({
      tenantId: 't', agentId: 'main', entityId: 7,
      attribute: 'version.stable', value: { v: '1.3.0' },
      validFrom: '2026-04-19T00:00:00Z', source: 'llm', evidenceSessionId: 's1',
    });
    const b = defaultIdempotencyKey({
      tenantId: 't', agentId: 'main', entityId: 7,
      attribute: 'version.stable', value: { v: '1.3.0' },
      validFrom: '2026-04-19T00:00:00Z', source: 'llm', evidenceSessionId: 's1',
    });
    assert.equal(a, b);
  });
  it('differs when source changes (no cross-source merge)', () => {
    const llm = defaultIdempotencyKey({
      tenantId: 't', agentId: 'a', entityId: 1, attribute: 'k',
      value: 'v', validFrom: '2026-04-19T00:00:00Z', source: 'llm',
    });
    const manual = defaultIdempotencyKey({
      tenantId: 't', agentId: 'a', entityId: 1, attribute: 'k',
      value: 'v', validFrom: '2026-04-19T00:00:00Z', source: 'manual',
    });
    assert.notEqual(llm, manual);
  });
  it('differs when value-shape changes even at same canonical key set', () => {
    const a = defaultIdempotencyKey({
      tenantId: 't', agentId: 'a', entityId: 1, attribute: 'k',
      value: { x: 1, y: 2 }, validFrom: '2026-04-19T00:00:00Z', source: 'llm',
    });
    const b = defaultIdempotencyKey({
      tenantId: 't', agentId: 'a', entityId: 1, attribute: 'k',
      value: { x: 1, y: 3 }, validFrom: '2026-04-19T00:00:00Z', source: 'llm',
    });
    assert.notEqual(a, b);
  });
});

describe('entity-state.validateChange', () => {
  const valid = {
    entityId: 7,
    attribute: 'version.stable',
    value: { v: '1.3.0' },
    validFrom: '2026-04-19T00:00:00Z',
  };
  it('accepts a minimal valid change', () => {
    assert.equal(validateChange(valid, 0), null);
  });
  it('rejects missing entityId', () => {
    const r = validateChange({ ...valid, entityId: undefined }, 0);
    assert.match(r, /entityId/);
  });
  it('rejects bad attribute path', () => {
    assert.match(validateChange({ ...valid, attribute: 'Version.Stable' }, 0), /attribute/);
    assert.match(validateChange({ ...valid, attribute: '1bad' }, 0), /attribute/);
    assert.match(validateChange({ ...valid, attribute: '' }, 0), /attribute/);
  });
  it('rejects undefined value (must be explicit null)', () => {
    assert.match(validateChange({ ...valid, value: undefined }, 0), /value/);
  });
  it('accepts explicit null value', () => {
    assert.equal(validateChange({ ...valid, value: null }, 0), null);
  });
  it('rejects unparseable validFrom', () => {
    assert.match(validateChange({ ...valid, validFrom: 'yesterday' }, 0), /validFrom/);
  });
  it('rejects out-of-range confidence', () => {
    assert.match(validateChange({ ...valid, confidence: 1.5 }, 0), /confidence/);
    assert.match(validateChange({ ...valid, confidence: -0.1 }, 0), /confidence/);
  });
  it('rejects unknown source', () => {
    assert.match(validateChange({ ...valid, source: 'guess' }, 0), /source/);
  });
});

// ---------------------------------------------------------------------------
// applyChanges with mock client (no real DB)
// ---------------------------------------------------------------------------

function makeMockClient(state = {}) {
  // Simulates one (entity, attribute) row in a "table".
  // state.current = {id, value, valid_from, source} or null
  // Returns: queries[], current after each apply.
  const queries = [];
  let nextId = 1000;
  let currentRow = state.current ? { ...state.current } : null;
  let history = state.history ? state.history.slice() : [];
  const idemMap = new Map(state.idem || []);

  return {
    queries,
    state: { get current() { return currentRow; }, get history() { return history.slice(); } },
    query: async (sql, params = []) => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 80), params });
      if (sql.includes('idempotency_key = $1')) {
        const k = params[0];
        return idemMap.has(k) ? { rowCount: 1, rows: [idemMap.get(k)] } : { rowCount: 0, rows: [] };
      }
      if (/SELECT \* FROM .*entity_state_history/.test(sql) && sql.includes('FOR UPDATE')) {
        return currentRow ? { rowCount: 1, rows: [currentRow] } : { rowCount: 0, rows: [] };
      }
      if (sql.startsWith('UPDATE')) {
        // Close the current row.
        if (currentRow && currentRow.id === params[1]) {
          currentRow = { ...currentRow, valid_to: params[0] };
          history.push(currentRow);
          currentRow = null;
        }
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith('INSERT INTO')) {
        const isHistorical = /VALUES \(\$1,\$2,\$3,\$4,\$5, \$6,\$7::jsonb,\$8,\$9, \$10,\$11,\$12, \$13,NULL\)/.test(sql.replace(/\s+/g, ' '));
        const id = nextId++;
        const row = isHistorical
          ? {
              id, tenant_id: params[0], agent_id: params[1], entity_id: params[2],
              session_row_id: params[3], evidence_session_id: params[4],
              attribute: params[5], value: JSON.parse(params[6]), valid_from: params[7], valid_to: params[8],
              evidence_text: params[9], confidence: params[10], source: params[11],
              idempotency_key: params[12], supersedes_state_id: null, created_at: '2026-04-19T00:00:00Z',
            }
          : {
              id, tenant_id: params[0], agent_id: params[1], entity_id: params[2],
              session_row_id: params[3], evidence_session_id: params[4],
              attribute: params[5], value: JSON.parse(params[6]), valid_from: params[7], valid_to: null,
              evidence_text: params[8], confidence: params[9], source: params[10],
              idempotency_key: params[11], supersedes_state_id: params[12], created_at: '2026-04-19T00:00:00Z',
            };
        if (!isHistorical) {
          currentRow = row;
        } else {
          history.push(row);
        }
        if (row.idempotency_key) idemMap.set(row.idempotency_key, row);
        return { rowCount: 1, rows: [row] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

describe('createEntityState.applyChanges', () => {
  function makeApi(extra = {}) {
    // Pool not used by applyChanges (only resolveEntity / get* APIs need it),
    // but createEntityState insists on a pool object — pass a stub.
    return createEntityState({
      pool: { query: async () => ({ rows: [] }) },
      schema: '"test"',
      defaultTenantId: 'default',
      ...extra,
    });
  }

  it('inserts current when no prior row', async () => {
    const api = makeApi();
    const client = makeMockClient();
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{
        entityId: 7,
        attribute: 'version.stable',
        value: '1.3.0',
        validFrom: '2026-04-19T00:00:00Z',
      }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.applied[0].action, 'inserted_current');
    assert.equal(client.state.current.value, '1.3.0');
  });

  it('noop on same value replay', async () => {
    const api = makeApi();
    const client = makeMockClient({
      current: {
        id: 1, tenant_id: 'default', agent_id: 'main', entity_id: 7,
        attribute: 'version.stable', value: '1.3.0',
        valid_from: '2026-04-18T00:00:00Z', valid_to: null,
        confidence: 0.9, source: 'llm', idempotency_key: 'OLDKEY',
      },
    });
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{
        entityId: 7,
        attribute: 'version.stable',
        value: '1.3.0',
        validFrom: '2026-04-19T00:00:00Z',  // newer ts but same value
      }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.applied[0].action, 'noop_same_value');
    assert.equal(client.state.current.value, '1.3.0');
    assert.equal(client.state.current.id, 1, 'current row unchanged');
  });

  it('noop on idempotent replay', async () => {
    const api = makeApi();
    const idemKey = defaultIdempotencyKey({
      tenantId: 'default', agentId: 'main', entityId: 7, attribute: 'version.stable',
      value: '1.3.0', validFrom: '2026-04-19T00:00:00Z', source: 'llm',
    });
    const client = makeMockClient({
      idem: [[idemKey, { id: 99, value: '1.3.0', idempotency_key: idemKey, valid_from: '2026-04-19T00:00:00Z' }]],
    });
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{
        entityId: 7,
        attribute: 'version.stable',
        value: '1.3.0',
        validFrom: '2026-04-19T00:00:00Z',
      }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.applied[0].action, 'noop_idempotent');
    assert.equal(r.data.applied[0].row.stateId, 99);
  });

  it('forward supersede: closes current and inserts new', async () => {
    const api = makeApi();
    const client = makeMockClient({
      current: {
        id: 1, tenant_id: 'default', agent_id: 'main', entity_id: 7,
        attribute: 'version.stable', value: '1.2.1',
        valid_from: '2026-04-18T00:00:00Z', valid_to: null,
        confidence: 0.9, source: 'llm',
      },
    });
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{
        entityId: 7,
        attribute: 'version.stable',
        value: '1.3.0',
        validFrom: '2026-04-19T00:00:00Z',
      }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.applied[0].action, 'closed_and_inserted');
    assert.equal(r.data.applied[0].row.value, '1.3.0');
    assert.equal(r.data.applied[0].row.supersedesStateId, 1);
    assert.equal(client.state.current.value, '1.3.0', 'new current is the new value');
    assert.equal(client.state.history.length, 1, '1 closed historical row exists');
  });

  it('out-of-order backfill: inserts historical interval without touching current', async () => {
    const api = makeApi();
    const client = makeMockClient({
      current: {
        id: 1, tenant_id: 'default', agent_id: 'main', entity_id: 7,
        attribute: 'version.stable', value: '1.3.0',
        valid_from: '2026-04-19T00:00:00Z', valid_to: null,
        confidence: 0.9, source: 'llm',
      },
    });
    // Backfill overlap check adds two extra SELECTs (predecessor + successor);
    // extend the mock to answer them.
    const origQuery = client.query;
    client.query = async (sql, params) => {
      if (/valid_from\s*<=\s*\$5[\s\S]*LIMIT 1/.test(sql)) {
        return { rowCount: 0, rows: [] };  // no predecessor (fresh timeline)
      }
      if (/valid_from\s*>\s*\$5[\s\S]*ASC LIMIT 1/.test(sql)) {
        return { rowCount: 1, rows: [{ id: 1, valid_from: '2026-04-19T00:00:00Z' }] };
      }
      return origQuery(sql, params);
    };
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{
        entityId: 7,
        attribute: 'version.stable',
        value: '1.2.1',
        validFrom: '2026-04-10T00:00:00Z',  // older than current
      }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.applied[0].action, 'inserted_historical');
    assert.equal(client.state.current.value, '1.3.0', 'current untouched');
    assert.equal(client.state.history.length, 1, 'historical row appended');
  });

  it('out-of-order backfill overlap: predecessor valid_to extends past incoming → AQ_CONFLICT', async () => {
    const api = makeApi();
    const client = makeMockClient({
      current: {
        id: 10, tenant_id: 'default', agent_id: 'main', entity_id: 7,
        attribute: 'version.stable', value: '1.3.0',
        valid_from: '2026-04-19T00:00:00Z', valid_to: null,
        confidence: 0.9, source: 'llm',
      },
    });
    const origQuery = client.query;
    client.query = async (sql, params) => {
      if (/valid_from\s*<=\s*\$5[\s\S]*LIMIT 1/.test(sql)) {
        // Predecessor row closes on 2026-04-15 but incoming is 2026-04-10 →
        // incoming lands INSIDE the predecessor's interval → overlap.
        return { rowCount: 1, rows: [{
          id: 5, valid_from: '2026-04-01T00:00:00Z', valid_to: '2026-04-15T00:00:00Z',
          value: '1.2.0', source: 'llm',
        }] };
      }
      return origQuery(sql, params);
    };
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{
        entityId: 7,
        attribute: 'version.stable',
        value: '1.2.5',
        validFrom: '2026-04-10T00:00:00Z',
      }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_CONFLICT');
    assert.match(r.error.message, /overlaps predecessor/);
  });

  it('backfill equal-timestamp with predecessor → AQ_CONFLICT', async () => {
    const api = makeApi();
    const client = makeMockClient({
      current: {
        id: 10, tenant_id: 'default', agent_id: 'main', entity_id: 7,
        attribute: 'version.stable', value: '1.3.0',
        valid_from: '2026-04-19T00:00:00Z', valid_to: null,
        confidence: 0.9, source: 'llm',
      },
    });
    const origQuery = client.query;
    client.query = async (sql, params) => {
      if (/valid_from\s*<=\s*\$5[\s\S]*LIMIT 1/.test(sql)) {
        return { rowCount: 1, rows: [{
          id: 5, valid_from: '2026-04-10T00:00:00Z', valid_to: '2026-04-15T00:00:00Z',
          value: '1.2.0', source: 'llm',
        }] };
      }
      return origQuery(sql, params);
    };
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{
        entityId: 7,
        attribute: 'version.stable',
        value: '1.2.5',
        validFrom: '2026-04-10T00:00:00Z',  // same as predecessor.valid_from
      }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_CONFLICT');
    assert.match(r.error.message, /equal-timestamp historical conflict/);
  });

  it('source conflict: same key, different source, different value → AQ_CONFLICT', async () => {
    const api = makeApi();
    const client = makeMockClient({
      current: {
        id: 1, tenant_id: 'default', agent_id: 'main', entity_id: 7,
        attribute: 'editor.preference', value: 'vim',
        valid_from: '2026-04-18T00:00:00Z', valid_to: null,
        confidence: 1.0, source: 'manual',
      },
    });
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{
        entityId: 7,
        attribute: 'editor.preference',
        value: 'nvim',
        validFrom: '2026-04-19T00:00:00Z',
        source: 'llm',
      }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_CONFLICT');
    assert.match(r.error.message, /source conflict/);
    assert.equal(client.state.current.value, 'vim', 'current untouched on conflict');
  });

  it('equal-timestamp different-value → AQ_CONFLICT', async () => {
    const api = makeApi();
    const client = makeMockClient({
      current: {
        id: 1, tenant_id: 'default', agent_id: 'main', entity_id: 7,
        attribute: 'version.stable', value: '1.2.1',
        valid_from: '2026-04-19T00:00:00Z', valid_to: null,
        confidence: 0.9, source: 'llm',
      },
    });
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{
        entityId: 7,
        attribute: 'version.stable',
        value: '1.3.0',
        validFrom: '2026-04-19T00:00:00Z',  // same timestamp, different value
      }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_CONFLICT');
    assert.match(r.error.message, /equal-timestamp/);
  });

  it('invalid input rejected before any DB work', async () => {
    const api = makeApi();
    const client = makeMockClient();
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [{ entityId: 7, attribute: 'BADCASE', value: 'x', validFrom: '2026-04-19T00:00:00Z' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INVALID_INPUT');
    assert.equal(client.queries.length, 0, 'no DB query issued on validation failure');
  });

  it('sorts batch by validFrom ASC so historical→current chain is correct', async () => {
    const api = makeApi();
    const client = makeMockClient();
    const r = await api.applyChanges(client, {
      agentId: 'main',
      changes: [
        // Out of order — newest first
        { entityId: 7, attribute: 'version.stable', value: '1.3.0', validFrom: '2026-04-19T00:00:00Z' },
        { entityId: 7, attribute: 'version.stable', value: '1.2.1', validFrom: '2026-04-15T00:00:00Z' },
        { entityId: 7, attribute: 'version.stable', value: '1.1.0', validFrom: '2026-04-10T00:00:00Z' },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.applied.length, 3);
    // After sorting and applying: 1.1.0 inserted_current, then 1.2.1 closes 1.1.0,
    // then 1.3.0 closes 1.2.1.
    assert.deepEqual(
      r.data.applied.map(a => a.action),
      ['inserted_current', 'closed_and_inserted', 'closed_and_inserted']
    );
    assert.equal(client.state.current.value, '1.3.0');
  });
});
