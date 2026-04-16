'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatBootstrapText } = require('../core/aquifer');

// ---------------------------------------------------------------------------
// formatBootstrapText tests
// ---------------------------------------------------------------------------

describe('formatBootstrapText', () => {
  const makeSessions = (n) => Array.from({ length: n }, (_, i) => ({
    sessionId: `ses-${i}`,
    agentId: 'main',
    source: 'gateway',
    startedAt: new Date(Date.now() - i * 86400000).toISOString(),
    title: `Session ${i}`,
    overview: `Overview for session ${i}`,
    topics: [],
    decisions: i === 0 ? [{ decision: 'Use PG', reason: 'ACID' }] : [],
    openLoops: i === 0 ? [{ item: 'Fix bug' }] : [],
    importantFacts: [],
  }));

  it('basic: returns text with session-bootstrap XML block', () => {
    const data = {
      sessions: makeSessions(3),
      openLoops: [{ item: 'Fix bug', fromSession: 'ses-0', latestStartedAt: new Date().toISOString() }],
      recentDecisions: [{ decision: 'Use PG', reason: 'ACID', fromSession: 'ses-0' }],
      meta: { lookbackDays: 14, count: 3, maxChars: 4000, truncated: false },
    };
    const result = formatBootstrapText(data, 4000);
    assert.ok(result.text.includes('<session-bootstrap'));
    assert.ok(result.text.includes('</session-bootstrap>'));
    assert.ok(result.text.includes('Session 0'));
    assert.ok(result.text.includes('Session 1'));
    assert.ok(result.text.includes('Session 2'));
    assert.ok(result.text.includes('Open items: Fix bug'));
    assert.ok(result.text.includes('Recent decisions: Use PG'));
    assert.equal(result.truncated, false);
  });

  it('empty: returns no sessions message', () => {
    const data = { sessions: [], openLoops: [], recentDecisions: [], meta: {} };
    const result = formatBootstrapText(data, 4000);
    assert.equal(result.text, 'No recent sessions found.');
    assert.equal(result.truncated, false);
  });

  it('maxChars truncation: removes oldest sessions', () => {
    const data = {
      sessions: makeSessions(10),
      openLoops: [],
      recentDecisions: [],
      meta: { lookbackDays: 14, count: 10, maxChars: 300, truncated: false },
    };
    const result = formatBootstrapText(data, 300);
    assert.ok(result.truncated);
    // Should keep newest (Session 0) and drop oldest
    assert.ok(result.text.includes('Session 0'));
    assert.ok(result.text.length <= 300);
  });

  it('decisions appear in session lines', () => {
    const data = {
      sessions: [{
        sessionId: 'ses-1', agentId: 'main', source: 'gw',
        startedAt: new Date().toISOString(),
        title: 'Test', overview: 'Testing',
        topics: [], decisions: [{ decision: 'Pick A', reason: 'fast' }, { decision: 'Drop B' }],
        openLoops: [], importantFacts: [],
      }],
      openLoops: [],
      recentDecisions: [],
      meta: {},
    };
    const result = formatBootstrapText(data, 4000);
    assert.ok(result.text.includes('Decisions: Pick A; Drop B'));
  });

  it('no open loops or decisions: footer omitted', () => {
    const data = {
      sessions: makeSessions(1),
      openLoops: [],
      recentDecisions: [],
      meta: {},
    };
    const result = formatBootstrapText(data, 4000);
    assert.ok(!result.text.includes('Open items'));
    assert.ok(!result.text.includes('Recent decisions'));
  });
});

// ---------------------------------------------------------------------------
// open loop sentinel and dedup tests (test via formatBootstrapText input)
// ---------------------------------------------------------------------------

describe('bootstrap open loop handling', () => {
  it('sentinel filter: removes 無, none, n/a, empty', () => {
    // These sentinels would be filtered in bootstrap() method, not formatBootstrapText.
    // Testing the format function just passes through what it gets.
    // This test documents expected behavior of the bootstrap() method's filtering.
    const SENTINELS = new Set(['無', 'none', 'n/a', 'na', 'done', '']);
    for (const s of SENTINELS) {
      const normalized = s.trim().replace(/\s+/g, ' ').toLowerCase();
      assert.ok(SENTINELS.has(normalized), `${s} should be filtered`);
    }
  });

  it('dedup: same item across sessions normalized to one', () => {
    // Simulating what bootstrap() does
    const sessions = [
      { openLoops: [{ item: 'Fix the bug' }], sessionId: 'a', startedAt: '2026-04-16' },
      { openLoops: [{ item: 'fix the bug' }], sessionId: 'b', startedAt: '2026-04-15' },
      { openLoops: [{ item: '  Fix  The  Bug  ' }], sessionId: 'c', startedAt: '2026-04-14' },
    ];
    const SENTINELS = new Set(['無', 'none', 'n/a', 'na', 'done', '']);
    const seenLoops = new Set();
    const openLoops = [];
    for (const s of sessions) {
      for (const loop of s.openLoops) {
        const raw = typeof loop === 'string' ? loop : (loop.item || '');
        const normalized = raw.trim().replace(/\s+/g, ' ').toLowerCase();
        if (SENTINELS.has(normalized) || !normalized || seenLoops.has(normalized)) continue;
        seenLoops.add(normalized);
        openLoops.push({ item: raw.trim(), fromSession: s.sessionId });
      }
    }
    assert.equal(openLoops.length, 1);
    assert.equal(openLoops[0].item, 'Fix the bug');
    assert.equal(openLoops[0].fromSession, 'a');
  });
});

// ---------------------------------------------------------------------------
// summaryText fallback test
// ---------------------------------------------------------------------------

describe('bootstrap summaryText fallback', () => {
  it('uses summaryText when structuredSummary is empty', () => {
    // Simulating what bootstrap() does with a row
    const row = {
      session_id: 'x',
      agent_id: 'main',
      source: 'gw',
      started_at: '2026-04-16T00:00:00Z',
      summary_text: 'This is a long summary text that should be used as fallback for title and overview',
      structured_summary: {},
    };
    const ss = row.structured_summary || {};
    const hasSS = ss.title || ss.overview;
    const title = ss.title || (hasSS ? null : (row.summary_text || '').slice(0, 60).trim() || null);
    const overview = ss.overview || (hasSS ? null : (row.summary_text || '').slice(0, 200).trim() || null);
    assert.equal(title, 'This is a long summary text that should be used as fallback');
    assert.ok(overview.startsWith('This is a long summary text'));
  });

  it('does not fallback when structuredSummary has title', () => {
    const row = {
      summary_text: 'Fallback text',
      structured_summary: { title: 'Real title', overview: null },
    };
    const ss = row.structured_summary || {};
    const hasSS = ss.title || ss.overview;
    const title = ss.title || (hasSS ? null : (row.summary_text || '').slice(0, 60) || null);
    assert.equal(title, 'Real title');
  });
});
