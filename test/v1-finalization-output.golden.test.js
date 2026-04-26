'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildFinalizationReview } = require('../core/finalization-review');

describe('v1 finalization human review output', () => {
  it('renders the human-facing handoff review without audit/debug payload fields', () => {
    const text = buildFinalizationReview({
      summary: {
        summaryText: '本輪把 Codex handoff 改成 transcript-backed finalization，並新增 render-only 預覽。',
        structuredSummary: {
          decisions: [{ decision: 'handoff 要以整段 Codex transcript view 做 v1 finalization' }],
          conclusions: [{ conclusion: 'payload-only handoff 不可寫入 curated memory' }],
          open_loops: [{ item: '補 DB-backed smoke', owner: 'Miranda' }],
        },
      },
      next: '補正式 DB-backed integration test',
      sessionId: '019dca6b-f1b9-79b3-a2ab-646a020a99d0',
      transcriptHash: '005f95c290e25c621a5baebf98d3307b026f02dc652be14a4d679f6f8ac557c0',
      memoryResult: { promoted: 3, quarantined: 1, skipped: 0 },
      memoryResults: [
        {
          action: 'promote',
          reason: 'v1_foundation_allowed',
          memory: {
            memoryType: 'decision',
            summary: 'handoff 要以整段 Codex transcript view 做 v1 finalization',
          },
        },
        {
          action: 'promote',
          reason: 'v1_foundation_allowed',
          memory: {
            memoryType: 'conclusion',
            summary: 'payload-only handoff 不可寫入 curated memory',
          },
        },
        {
          action: 'promote',
          reason: 'v1_foundation_allowed',
          memory: {
            memoryType: 'open_loop',
            summary: '補 DB-backed smoke',
            payload: { owner: 'Miranda' },
          },
        },
        {
          action: 'quarantine',
          reason: 'forbidden_tool_output',
          candidate: {
            memoryType: 'fact',
            summary: '不要把 tool output 當 memory',
          },
        },
      ],
    });

    assert.equal(text, [
      '已整理進 DB：',
      '',
      '目前狀態：',
      '- 本輪把 Codex handoff 改成 transcript-backed finalization，並新增 render-only 預覽。',
      '',
      '已記住：',
      '- 決策：handoff 要以整段 Codex transcript view 做 v1 finalization',
      '- 判斷：payload-only handoff 不可寫入 curated memory',
      '',
      '未完成：',
      '- 未完成：補 DB-backed smoke（owner: Miranda）',
      '',
      '已作廢或隔離：',
      '- quarantine：不要把 tool output 當 memory（forbidden_tool_output）',
      '',
      '下一段只需要帶：',
      '- 未完成：補 DB-backed smoke（owner: Miranda）',
      '- 下一步：補正式 DB-backed integration test',
      '',
      '不要帶：',
      '- 整段逐字稿、工具輸出、debug 訊息',
      '- DB row id、hash、message count 這類 audit 欄位',
      '- 已作廢、隔離、錯誤或 superseded 的記憶',
      '',
    ].join('\n'));

    assert.doesNotMatch(text, /019dca6b/);
    assert.doesNotMatch(text, /005f95c/);
    assert.doesNotMatch(text, /DB Write Plan/);
    assert.doesNotMatch(text, /Legacy Continuity Text/);
    assert.doesNotMatch(text, /Structured Summary/);
    assert.doesNotMatch(text, /"memoryResult"/);
    assert.doesNotMatch(text, /\{|\}/);
  });
});
