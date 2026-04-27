'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionStartContext } = require('../core/finalization-review');

describe('v1 SessionStart injection context', () => {
  it('only renders active curated memory and excludes audit/debug/inactive content', () => {
    const text = buildSessionStartContext([
      {
        status: 'active',
        visibleInBootstrap: true,
        memoryType: 'decision',
        summary: 'SessionStart 只帶 active curated memory',
      },
      {
        status: 'active',
        visibleInBootstrap: true,
        memoryType: 'open_loop',
        summary: '補 render snapshot',
      },
      {
        status: 'incorrect',
        visibleInBootstrap: true,
        memoryType: 'fact',
        summary: '錯誤 handoff JSON 可以當下一段上下文',
      },
      {
        status: 'quarantined',
        visibleInBootstrap: true,
        memoryType: 'fact',
        summary: '工具輸出要進 SessionStart',
      },
      {
        status: 'superseded',
        visibleInBootstrap: true,
        memoryType: 'decision',
        summary: '舊 spec 仍然有效',
      },
      {
        status: 'active',
        visibleInBootstrap: false,
        memoryType: 'fact',
        summary: 'debug audit 欄位',
      },
    ]);

    assert.equal(text, [
      '下一段只需要帶：',
      '- 未完成：補 render snapshot',
      '- 決策：SessionStart 只帶 active curated memory',
      '',
    ].join('\n'));
    assert.doesNotMatch(text, /錯誤 handoff/);
    assert.doesNotMatch(text, /工具輸出/);
    assert.doesNotMatch(text, /舊 spec/);
    assert.doesNotMatch(text, /debug audit/);
    assert.doesNotMatch(text, /sessionId|transcriptHash|DB Write Plan/);
  });

  it('renders an explicit empty minimal context when no active visible records exist', () => {
    const text = buildSessionStartContext([
      { status: 'incorrect', visibleInBootstrap: true, memoryType: 'fact', summary: 'x' },
      { status: 'quarantined', visibleInBootstrap: true, memoryType: 'fact', summary: 'y' },
      { status: 'superseded', visibleInBootstrap: true, memoryType: 'decision', summary: 'z' },
      { status: 'active', visibleInBootstrap: false, memoryType: 'open_loop', summary: 'hidden' },
    ]);

    assert.equal(text, '下一段只需要帶：\n無\n');
  });

  it('keeps older state and open loop ahead of newer decisions when compressed', () => {
    const records = [
      {
        status: 'active',
        visibleInBootstrap: true,
        memoryType: 'state',
        summary: 'current state stays pinned',
        acceptedAt: '2026-04-27T00:00:00.000Z',
      },
      {
        status: 'active',
        visibleInBootstrap: true,
        memoryType: 'open_loop',
        summary: 'open loop stays pinned',
        acceptedAt: '2026-04-27T00:01:00.000Z',
      },
    ];
    for (let i = 0; i < 8; i += 1) {
      records.push({
        status: 'active',
        visibleInBootstrap: true,
        memoryType: 'decision',
        summary: `newer low priority decision ${i} with enough text to be trimmed before pinned state or open loop disappears from the minimal context`,
        acceptedAt: `2026-04-28T00:0${i}:00.000Z`,
      });
    }

    const text = buildSessionStartContext(records, { maxChars: 160 });

    assert.match(text, /current state stays pinned/);
    assert.match(text, /open loop stays pinned/);
    assert.doesNotMatch(text, /newer low priority decision/);
  });
});
