'use strict';

// Aquifer default persona — minimal summary prompt.
//
// Parameterized via personaOpts:
//   agentName       — human name/role the prompt addresses (default 'Assistant')
//   observedOwner   — if set, the prompt asks for a short observation about
//                     that person (matches Miranda's "對 MK 的觀察" slot).
//                     null → the section is omitted entirely.
//   language        — 'en' | 'zh-TW' (default 'en')
//
// Output format mirrors Miranda's RECAP fields so downstream daily-entries
// parsing works uniformly across personas.

function buildSummaryPrompt({ conversationText, agentId, now, dailyContext, persona = {} }) {
  const { agentName = 'Assistant', observedOwner = null, language = 'en' } = persona;
  if (!now) now = new Date();
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);

  if (language === 'zh-TW') return buildZhTw({ conversationText, agentId, agentName, observedOwner, date, time, dailyContext });
  return buildEn({ conversationText, agentId, agentName, observedOwner, date, time, dailyContext });
}

function buildEn({ conversationText, agentId, agentName, observedOwner, date, time, dailyContext }) {
  const ownerList = [observedOwner, 'agent', 'unknown'].filter(Boolean).join(', ');
  const observationSection = observedOwner ? `
## Observation of ${observedOwner}

(1-2 sentences about ${observedOwner}'s state/energy/mood as perceived in this session)
` : '';

  return `You are processing a completed chat session for agent "${agentId}" (${agentName}).
Current time: ${date} ${time}

${dailyContext ? `## Today's daily log so far:\n\n${dailyContext}\n\n---\n\n` : ''}## Conversation transcript:

${conversationText}

---

Generate THREE sections separated by the exact markers shown below. Output content ONLY after each marker.

===SESSION_ENTRIES===
Bullet points for today's log. Each line: "- (HH:MM) key point".
Summarize at OUTCOME level — one bullet per topic, merged across steps.
Skip greetings and trivial exchanges.
If a topic already exists in "Today's daily log so far", skip it.

===EMOTIONAL_STATE===
---
updated: ${date}T${time}
session_mood: (one word)
---

## Session state

(2-3 sentences about the agent's state after this session)
${observationSection}
===RECAP===
Output each field on its own tagged line.

TITLE: one-line headline
OVERVIEW: 80-200 char dense summary
TOPIC: topic name | 1-3 sentence summary
DECISION: what was decided | reason
ACTION: completed thing | done
ACTION: partially done thing | partial
OPEN: unresolved item | ${ownerList.split(',')[0].trim()}
FACT: important fact
TODO_NEW: newly created action item
TODO_DONE: previously listed TODO that was completed

Rules:
- One tag per line. Multiple items = multiple lines with same tag.
- TITLE and OVERVIEW are required.
- OPEN owner enum: ${ownerList}
- ACTION status: done or partial
- Skip any section not applicable.
- Do NOT output JSON.
`;
}

function buildZhTw({ conversationText, agentId, agentName, observedOwner, date, time, dailyContext }) {
  const ownerList = [observedOwner, 'agent', 'unknown'].filter(Boolean).join(', ');
  const observationSection = observedOwner ? `
## 對 ${observedOwner} 的觀察

(1-2 句關於 ${observedOwner} 在此 session 中觀察到的狀態 / 精神 / 情緒)
` : '';

  return `你正在處理 agent "${agentId}" (${agentName}) 的一段對話。
目前時間: ${date} ${time}

${dailyContext ? `## 今日日誌:\n\n${dailyContext}\n\n---\n\n` : ''}## 對話內容:

${conversationText}

---

輸出下列三段，以下列 marker 嚴格分隔。每段只輸出 marker 後的內容。使用繁體中文。

===SESSION_ENTRIES===
每行: "- (HH:MM) key point"。以結果層級合併步驟，不逐步記錄。
略過寒暄與瑣碎交換。
若某主題已在「今日日誌」中出現，略過。

===EMOTIONAL_STATE===
---
updated: ${date}T${time}
session_mood: (one word)
---

## 情緒狀態

(2-3 句關於 agent 在此 session 後的狀態)
${observationSection}
===RECAP===

TITLE: 一句話標題
OVERVIEW: 80-200 字密集摘要
TOPIC: 主題名 | 1-3 句 summary
DECISION: 做了什麼決定 | 原因
ACTION: 已完成 | done
ACTION: 部分完成 | partial
OPEN: 未完成事項 | ${ownerList.split(',')[0].trim()}
FACT: 重要事實
TODO_NEW: 新增待辦
TODO_DONE: 已完成待辦（需匹配既有）

規則:
- 一行一個 tag。多項就多行相同 tag。
- TITLE 跟 OVERVIEW 必填。
- OPEN owner: ${ownerList}
- ACTION 狀態: done 或 partial
- 不輸出 JSON。
`;
}

// ---------------------------------------------------------------------------
// parseSummaryOutput / parseRecapLines — delegate to miranda's parsers.
// The output format is intentionally the same, so parsers work for both.
// ---------------------------------------------------------------------------

const mirandaSummary = require('../../miranda/prompts/summary');

module.exports = {
  buildSummaryPrompt,
  parseSummaryOutput: mirandaSummary.parseSummaryOutput,
  parseRecapLines: mirandaSummary.parseRecapLines,
  parseWorkingFacts: mirandaSummary.parseWorkingFacts,
};
