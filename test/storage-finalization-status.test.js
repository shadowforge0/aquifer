'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../core/storage');

function makePool() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      return { rows: [{ id: 1, status: params[9] || params[1] || 'pending' }], rowCount: 1 };
    },
  };
}

describe('storage finalization lifecycle guard', () => {
  it('keeps terminal finalization rows from being overwritten by upsert conflict paths', async () => {
    const pool = makePool();

    await storage.upsertSessionFinalization(pool, {
      sessionRowId: 1,
      sessionId: 's1',
      agentId: 'main',
      source: 'codex',
      transcriptHash: 'a'.repeat(64),
      status: 'declined',
    }, { schema: 'aq', tenantId: 'default' });

    const sql = pool.queries[0].sql;
    assert.match(sql, /CASE\s+WHEN "aq"\.session_finalizations\.status IN \('finalized','skipped','declined','deferred'\)/);
    assert.match(sql, /THEN "aq"\.session_finalizations\.status\s+ELSE EXCLUDED\.status/);
    assert.match(sql, /THEN "aq"\.session_finalizations\.mode\s+ELSE EXCLUDED\.mode/);
    assert.match(sql, /THEN "aq"\.session_finalizations\.memory_result\s+ELSE COALESCE/);
    assert.match(sql, /THEN "aq"\.session_finalizations\.claimed_at\s+ELSE COALESCE/);
    assert.match(sql, /THEN "aq"\.session_finalizations\.updated_at\s+ELSE now\(\)/);
    assert.match(sql, /THEN "aq"\.session_finalizations\.metadata\s+ELSE COALESCE/);
  });

  it('guards status updates from changing terminal rows to a different status', async () => {
    const pool = makePool();

    await storage.updateSessionFinalizationStatus(pool, {
      sessionId: 's1',
      agentId: 'main',
      source: 'codex',
      transcriptHash: 'b'.repeat(64),
      status: 'failed',
    }, { schema: 'aq', tenantId: 'default' });

    const sql = pool.queries[0].sql;
    assert.match(sql, /status NOT IN \('finalized','skipped','declined','deferred'\)/);
    assert.match(sql, /OR status = \$2/);
  });
});
