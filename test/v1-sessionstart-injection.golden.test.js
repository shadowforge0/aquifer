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
      '- 決策：SessionStart 只帶 active curated memory',
      '- 未完成：補 render snapshot',
      '',
    ].join('\n'));
    assert.doesNotMatch(text, /錯誤 handoff/);
    assert.doesNotMatch(text, /工具輸出/);
    assert.doesNotMatch(text, /舊 spec/);
    assert.doesNotMatch(text, /debug audit/);
    assert.doesNotMatch(text, /sessionId|transcriptHash|DB Write Plan/);
  });
});
