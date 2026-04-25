'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const parser = require('../consumers/shared/summary-parser');

describe('consumers/shared/summary-parser', () => {
  it('keeps the legacy SUMMARY_MARKERS alias', () => {
    assert.equal(parser.SUMMARY_MARKERS, parser.DEFAULT_SUMMARY_MARKERS);
    assert.ok(parser.SUMMARY_MARKERS.includes('===RECAP==='));
  });

  it('extracts known sections and ignores missing markers', () => {
    const sections = parser.parseSummaryOutput([
      'preamble',
      '===SESSION_ENTRIES===',
      '- (10:00) did work',
      '===RECAP===',
      'TITLE: Parser test',
      'OVERVIEW: Parser overview',
      '===HANDOFF===',
      'STATUS: completed',
      'LAST_STEP: parser moved',
      'NEXT: verify',
      'STOP_REASON: natural',
    ].join('\n'));

    assert.equal(sections.session_entries, '- (10:00) did work');
    assert.match(sections.recap, /TITLE: Parser test/);
    assert.match(sections.handoff, /NEXT: verify/);
    assert.equal(sections.entities, undefined);
  });

  it('parses recap tags into the structured summary shape', () => {
    const recap = parser.parseRecapLines([
      'TITLE: 標題',
      'OVERVIEW: 摘要',
      'TOPIC: Aquifer | DB fallback',
      'DECISION: 保留 shim | 避免 package break',
      'ACTION: 補測試 | partial',
      'OPEN: 跑 DB integration | agent',
      'FACT: shared parser is generic',
      'PATTERN: review gate | package surface | add test | invariant',
      'FOCUS_DECISION: update',
      'FOCUS: Aquifer DB',
      'TODO_NEW: 補 live DB 驗證',
      'TODO_DONE: 刪錯誤 handoff',
    ].join('\n'));

    assert.equal(recap.title, '標題');
    assert.equal(recap.overview, '摘要');
    assert.deepEqual(recap.topics, [{ name: 'Aquifer', summary: 'DB fallback' }]);
    assert.deepEqual(recap.decisions, [{ decision: '保留 shim', reason: '避免 package break' }]);
    assert.deepEqual(recap.actions_completed, [{ action: '補測試', status: 'partial' }]);
    assert.deepEqual(recap.open_loops, [{ item: '跑 DB integration', owner: 'agent' }]);
    assert.deepEqual(recap.important_facts, ['shared parser is generic']);
    assert.deepEqual(recap.reusable_patterns, [{
      pattern: 'review gate',
      trigger: 'package surface',
      action: 'add test',
      durability: 'invariant',
    }]);
    assert.equal(recap.focus_decision, 'update');
    assert.equal(recap.focus, 'Aquifer DB');
    assert.deepEqual(recap.todo_new, ['補 live DB 驗證']);
    assert.deepEqual(recap.todo_done, ['刪錯誤 handoff']);
  });

  it('parses up to five working facts', () => {
    const facts = parser.parseWorkingFacts([
      'WFACT: A | one',
      'WFACT: B | two',
      'WFACT: C | three',
      'WFACT: D | four',
      'WFACT: E | five',
      'WFACT: F | six',
    ].join('\n'));

    assert.equal(facts.length, 5);
    assert.deepEqual(facts[0], { subject: 'A', statement: 'one' });
    assert.deepEqual(facts[4], { subject: 'E', statement: 'five' });
  });

  it('preserves safe named open-loop owners', () => {
    const recap = parser.parseRecapLines([
      'OPEN: follow up with Evan | Evan',
      'OPEN: route to agent | agent',
      'OPEN: unsafe owner fallback | Evan Smith',
    ].join('\n'));

    assert.deepEqual(recap.open_loops, [
      { item: 'follow up with Evan', owner: 'evan' },
      { item: 'route to agent', owner: 'agent' },
      { item: 'unsafe owner fallback', owner: 'unknown' },
    ]);
  });

  it('normalizes handoff enums and rejects incomplete handoff sections', () => {
    const handoff = parser.parseHandoffSection([
      'STATUS: in-progress',
      'LAST_STEP: finish parser',
      'NEXT: run tests',
      'STOP_REASON: context full',
      'DECIDED: keep alias',
      'BLOCKER: none',
    ].join('\n'));

    assert.deepEqual(handoff, {
      status: 'in_progress',
      lastStep: 'finish parser',
      next: 'run tests',
      stopReason: 'context_full',
      decided: 'keep alias',
      blocker: 'none',
    });
    assert.equal(parser.parseHandoffSection('STATUS: completed\nNEXT: missing last step'), null);
  });
});
