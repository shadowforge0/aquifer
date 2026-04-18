'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildSummaryPrompt,
    parseSummaryOutput,
    parseRecapLines,
    parseWorkingFacts,
    parseHandoffSection,
    SUMMARY_MARKERS,
} = require('../consumers/miranda/prompts/summary');

// ---------------------------------------------------------------------------

describe('buildSummaryPrompt', () => {
    it('includes agent name + current time + conversation text', () => {
        const now = new Date('2026-04-18T10:30:00Z');
        const p = buildSummaryPrompt({
            conversationText: '[user] hi\n[assistant] hello',
            agentId: 'main',
            now,
            dailyContext: '',
        });
        assert.ok(p.includes('agent "main"'));
        assert.ok(p.includes('(UTC+8)'));
        assert.ok(p.includes('[user] hi'));
        assert.ok(p.includes('[assistant] hello'));
    });

    it('skips daily context section when empty', () => {
        const p = buildSummaryPrompt({ conversationText: 'x', agentId: 'main', dailyContext: '' });
        // The header "## Today's daily log so far:" only appears when context exists
        assert.ok(!p.includes("## Today's daily log so far:"));
    });

    it('includes daily context section when provided', () => {
        const p = buildSummaryPrompt({ conversationText: 'x', agentId: 'main', dailyContext: '當前焦點: 寫 spec' });
        assert.ok(p.includes("## Today's daily log so far:"));
        assert.ok(p.includes('當前焦點'));
    });

    it('contains all six section markers', () => {
        const p = buildSummaryPrompt({ conversationText: 'x', agentId: 'main' });
        for (const m of SUMMARY_MARKERS) assert.ok(p.includes(m), `missing ${m}`);
    });

    it('is 繁體中文 by directive', () => {
        const p = buildSummaryPrompt({ conversationText: 'x', agentId: 'main' });
        assert.ok(p.includes('繁體中文'));
    });
});

// ---------------------------------------------------------------------------

describe('parseSummaryOutput', () => {
    it('splits output into six sections', () => {
        const out = `===SESSION_ENTRIES===
- (10:00) 寫完 spec
焦點: a, b

===EMOTIONAL_STATE===
---
session_mood: focused
---

## 情緒狀態
Solid.

===RECAP===
TITLE: Foo
OVERVIEW: Did stuff.

===ENTITIES===
ENTITY: Aquifer | project | -

===WORKING_FACTS===
WFACT: Aquifer | 正在補完

===HANDOFF===
STATUS: in_progress
LAST_STEP: 寫 spec
NEXT: commit
STOP_REASON: natural`;
        const sections = parseSummaryOutput(out);
        assert.ok(sections.session_entries.includes('寫完 spec'));
        assert.ok(sections.emotional_state.includes('session_mood'));
        assert.ok(sections.recap.includes('TITLE: Foo'));
        assert.ok(sections.entities.includes('Aquifer'));
        assert.ok(sections.working_facts.includes('WFACT'));
        assert.ok(sections.handoff.includes('STATUS'));
    });

    it('tolerates missing sections', () => {
        const sections = parseSummaryOutput('===RECAP===\nTITLE: Only this');
        assert.ok(sections.recap.includes('TITLE: Only this'));
        assert.equal(sections.emotional_state, undefined);
    });

    it('trims whitespace from each section', () => {
        const sections = parseSummaryOutput('===RECAP===\n\n  TITLE: X  \n\n===HANDOFF===\nSTATUS: completed');
        assert.ok(sections.recap.startsWith('TITLE'));
    });
});

// ---------------------------------------------------------------------------

describe('parseRecapLines', () => {
    it('extracts TITLE and OVERVIEW', () => {
        const r = parseRecapLines('TITLE: My title\nOVERVIEW: My overview');
        assert.equal(r.title, 'My title');
        assert.equal(r.overview, 'My overview');
    });

    it('parses multiple TOPIC lines', () => {
        const r = parseRecapLines('TOPIC: A | summary a\nTOPIC: B | summary b');
        assert.equal(r.topics.length, 2);
        assert.equal(r.topics[0].name, 'A');
        assert.equal(r.topics[1].summary, 'summary b');
    });

    it('parses DECISION with reason', () => {
        const r = parseRecapLines('DECISION: pick Redis | faster');
        assert.deepEqual(r.decisions, [{ decision: 'pick Redis', reason: 'faster' }]);
    });

    it('parses ACTION status (done/partial default done)', () => {
        const r = parseRecapLines('ACTION: x | done\nACTION: y | partial\nACTION: z');
        assert.equal(r.actions_completed[0].status, 'done');
        assert.equal(r.actions_completed[1].status, 'partial');
        assert.equal(r.actions_completed[2].status, 'done');
    });

    it('parses OPEN with owner normalized to mk/agent/unknown', () => {
        const r = parseRecapLines('OPEN: a | mk\nOPEN: b | junk\nOPEN: c');
        assert.equal(r.open_loops[0].owner, 'mk');
        assert.equal(r.open_loops[1].owner, 'unknown');
        assert.equal(r.open_loops[2].owner, 'unknown');
    });

    it('parses PATTERN durability', () => {
        const r = parseRecapLines('PATTERN: p | trig | act | invariant');
        assert.equal(r.reusable_patterns[0].durability, 'invariant');
    });

    it('parses FOCUS_DECISION + FOCUS', () => {
        const r = parseRecapLines('FOCUS_DECISION: update\nFOCUS: a, b');
        assert.equal(r.focus_decision, 'update');
        assert.equal(r.focus, 'a, b');
    });

    it('defaults focus_decision to keep', () => {
        const r = parseRecapLines('TITLE: X');
        assert.equal(r.focus_decision, 'keep');
    });

    it('collects TODO_NEW + TODO_DONE lines', () => {
        const r = parseRecapLines('TODO_NEW: 寫 spec\nTODO_NEW: commit\nTODO_DONE: 裝 eslint');
        assert.deepEqual(r.todo_new, ['寫 spec', 'commit']);
        assert.deepEqual(r.todo_done, ['裝 eslint']);
    });
});

// ---------------------------------------------------------------------------

describe('parseWorkingFacts', () => {
    it('extracts facts matching WFACT: subject | statement', () => {
        const facts = parseWorkingFacts('WFACT: Aquifer | shipped\nWFACT: Gateway | running');
        assert.equal(facts.length, 2);
        assert.equal(facts[0].subject, 'Aquifer');
        assert.equal(facts[1].statement, 'running');
    });

    it('caps at 5 facts', () => {
        const lines = Array.from({ length: 10 }, (_, i) => `WFACT: S${i} | st${i}`).join('\n');
        assert.equal(parseWorkingFacts(lines).length, 5);
    });

    it('ignores non-matching lines', () => {
        assert.deepEqual(parseWorkingFacts('NOISE\nWFACT: A | B'), [{ subject: 'A', statement: 'B' }]);
    });

    it('tolerates null/empty', () => {
        assert.deepEqual(parseWorkingFacts(''), []);
        assert.deepEqual(parseWorkingFacts(null), []);
    });
});

// ---------------------------------------------------------------------------

describe('parseHandoffSection', () => {
    it('parses full handoff', () => {
        const h = parseHandoffSection(`STATUS: in_progress
LAST_STEP: 寫 summary prompt
NEXT: 加測試
STOP_REASON: natural
DECIDED: 走 persona path`);
        assert.equal(h.status, 'in_progress');
        assert.equal(h.lastStep, '寫 summary prompt');
        assert.equal(h.next, '加測試');
        assert.equal(h.stopReason, 'natural');
        assert.equal(h.decided, '走 persona path');
    });

    it('returns null when LAST_STEP or NEXT missing', () => {
        assert.equal(parseHandoffSection('STATUS: completed'), null);
    });

    it('normalizes invalid status to completed, invalid stop_reason to natural', () => {
        const h = parseHandoffSection('STATUS: weird\nLAST_STEP: x\nNEXT: y\nSTOP_REASON: weird');
        assert.equal(h.status, 'completed');
        assert.equal(h.stopReason, 'natural');
    });

    it('tolerates null', () => {
        assert.equal(parseHandoffSection(null), null);
    });
});
