'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPersona } = require('../consumers/default');

describe('createPersona — default opts', () => {
  it('produces a persona module with standard shape', () => {
    const p = createPersona();
    assert.equal(typeof p.mountOnOpenClaw, 'function');
    assert.equal(typeof p.registerAfterburn, 'function');
    assert.equal(typeof p.registerContextInject, 'function');
    assert.equal(typeof p.registerRecallTool, 'function');
    assert.equal(typeof p.buildSummaryFn, 'function');
    assert.equal(typeof p.buildPostProcess, 'function');
    assert.equal(p.persona.agentName, 'Assistant');
    assert.equal(p.persona.observedOwner, null);
    assert.equal(p.persona.schema, 'aquifer');
    assert.equal(p.persona.dailyTable, null);
  });
});

describe('createPersona — prompt templating', () => {
  it('defaults: no observation section, english prompt', () => {
    const p = createPersona();
    const prompt = p.summary.buildSummaryPrompt({
      conversationText: 'hi', agentId: 'demo', now: new Date('2026-04-18T00:00:00Z'), dailyContext: '',
      persona: p.persona,
    });
    assert.ok(!prompt.includes('對 MK'));
    assert.ok(!prompt.includes('Observation of'));  // null owner → omitted
    assert.ok(prompt.includes('agent "demo"'));
  });

  it('with observedOwner=evan: observation section present', () => {
    const p = createPersona({ observedOwner: 'evan' });
    const prompt = p.summary.buildSummaryPrompt({
      conversationText: 'x', agentId: 'dobby', now: new Date('2026-04-18T00:00:00Z'), dailyContext: '',
      persona: p.persona,
    });
    assert.ok(prompt.includes('Observation of evan'));
    assert.match(prompt, /OPEN owner enum: evan,/);
  });

  it('zh-TW language: 繁體中文 prompt', () => {
    const p = createPersona({ observedOwner: 'evan', language: 'zh-TW' });
    const prompt = p.summary.buildSummaryPrompt({
      conversationText: '嗨', agentId: 'dobby', now: new Date('2026-04-18T00:00:00Z'), dailyContext: '',
      persona: p.persona,
    });
    assert.ok(prompt.includes('對 evan 的觀察'));
    assert.ok(prompt.includes('繁體中文') || prompt.includes('繁體'));
    assert.ok(!prompt.includes('對 MK 的觀察'));
  });

  it('no observedOwner: OPEN owner enum omits the owner slot', () => {
    const p = createPersona({ language: 'en' });
    const prompt = p.summary.buildSummaryPrompt({
      conversationText: 'x', agentId: 'a', now: new Date('2026-04-18T00:00:00Z'), dailyContext: '',
      persona: p.persona,
    });
    assert.match(prompt, /OPEN owner enum: agent, unknown/);
  });
});

describe('createPersona — buildSummaryFn', () => {
  it('requires llmFn', () => {
    const p = createPersona({ agentName: 'Dobby' });
    assert.throws(() => p.buildSummaryFn({ agentId: 'x', now: new Date() }), /llmFn/);
  });

  it('calls llmFn and parses RECAP sections', async () => {
    const p = createPersona({ agentName: 'Dobby', observedOwner: 'evan' });
    const llmFn = async (_prompt) => [
      '===SESSION_ENTRIES===',
      '- (14:05) Did something',
      '===EMOTIONAL_STATE===',
      '---',
      'updated: 2026-04-18T14:00',
      'session_mood: calm',
      '---',
      '## Session state',
      'fine',
      '===RECAP===',
      'TITLE: Test title',
      'OVERVIEW: eighty char overview text padded so the length gate in default persona is satisfied OK.',
    ].join('\n');
    const fn = p.buildSummaryFn({ agentId: 'dobby', now: new Date(), dailyContext: '', llmFn });
    const out = await fn([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    assert.equal(out.structuredSummary.title, 'Test title');
    assert.match(out.summaryText, /overview/);
  });
});

describe('createPersona — daily-entries toggle', () => {
  it('skips write when dailyTable is null', async () => {
    const p = createPersona();
    // pool unused because dailyTable is null
    await p.dailyEntries.writeDailyEntries({
      sections: { session_entries: '- (14:05) x' },
      recap: null, pool: null, sessionId: 's1', agentId: 'a',
      dailyTable: null, logger: { info: () => {}, warn: () => {} },
    });
    // No throw = ok
    assert.ok(true);
  });
});
