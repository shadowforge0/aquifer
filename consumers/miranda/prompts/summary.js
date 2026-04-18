'use strict';

// ---------------------------------------------------------------------------
// Miranda six-section summary prompt + parsers.
//
// Sections (all use 繁體中文):
//   SESSION_ENTRIES   bullets for today's log (outcome-level)
//   EMOTIONAL_STATE   frontmatter + agent mood + observation of MK
//   RECAP             tagged fields (TITLE/OVERVIEW/TOPIC/DECISION/...)
//   ENTITIES          ENTITY: name|type|aliases + RELATION: src|dst
//   WORKING_FACTS     WFACT: subject | statement
//   HANDOFF           STATUS/LAST_STEP/NEXT/STOP_REASON/...
// ---------------------------------------------------------------------------

function buildSummaryPrompt({ conversationText, agentId, now, dailyContext }) {
    if (!now) now = new Date();
    const fmt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Taipei',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const local = fmt.format(now).replace(' ', 'T');
    const [date, time] = local.split('T');

    return `You are processing a completed chat session for agent "${agentId}".
Current time: ${date} ${time} (UTC+8)

${dailyContext ? `## Today's daily log so far:\n\n${dailyContext}\n\n---\n\n` : ''}## Conversation transcript:

${conversationText}

---

Generate SIX sections separated by the exact markers shown below.
Use 繁體中文. Output content ONLY after each marker.

===SESSION_ENTRIES===
Generate bullet points for this session only. Each line: "- (HH:MM) key point".
Summarize at the OUTCOME level — one bullet per topic, not per step. Merge related actions into a single entry with the final result.
Bad: "嘗試檢視 hook" + "嘗試檢視 settings" + "授權中斷" (3 lines, process noise)
Good: "CC 記憶管理審查，因授權提示反覆出現而中斷" (1 line, outcome)
Drop greetings, trivial exchanges, and intermediate steps that led to a stated outcome.
Check "Today's daily log so far" above — if a topic already has an entry there, skip it. Compare by topic/subject, not exact wording.
Also output one line starting with "焦點:" listing 2-5 current priorities comma-separated.

===EMOTIONAL_STATE===
---
updated: ${date}T${time}
session_mood: (one word)
---

## 情緒狀態

(2-3 sentences about the agent emotional state after this session)

## 對 MK 的觀察

(1-2 sentences about MK state/energy/mood as perceived in this session)

===RECAP===
Output each field on its own tagged line. Use 繁體中文.

TITLE: 一句話標題
OVERVIEW: 80-200字摘要
TOPIC: 主題名 | 1-3句 summary
TOPIC: 第二個主題 | summary
DECISION: 做了什麼 | 原因
ACTION: 完成的事 | done
ACTION: 另一件 | partial
OPEN: 未完成事項 | mk
FACT: 重要事實
PATTERN: 可重用模式 | 觸發條件 | 做法 | invariant
FOCUS_DECISION: keep|update
FOCUS: 新焦點1, 焦點2（只在 FOCUS_DECISION 為 update 時輸出）
TODO_NEW: 新增的待辦事項
TODO_DONE: 已完成的待辦事項（需與當前待辦精確匹配）

Rules:
- One tag per line. Multiple items = multiple lines with same tag.
- TITLE and OVERVIEW are required. OVERVIEW should be a dense paragraph (80-200 chars), not a short phrase.
- Others only if relevant.
- ACTION status: done or partial
- OPEN owner: mk, agent, or unknown
- PATTERN durability: invariant or derived
- FOCUS_DECISION is required. Output "keep" if focus hasn't changed, "update" if it should change.
- FOCUS: only output when FOCUS_DECISION is update. Comma-separated list of current priorities.
- TODO_NEW: only if this session created genuinely new action items. One item per line.
- TODO_DONE: only if a previously listed TODO was clearly completed in this session. Must match existing TODO text closely.
- When in doubt about TODO changes, do NOT output TODO_NEW or TODO_DONE.
- If the session was trivial, only output TITLE and OVERVIEW.
- Do NOT output JSON.

===ENTITIES===
輸出本 session 可落地到知識圖譜的實體與共現關係。每行一筆，禁止額外說明文字。

ENTITY: <name> | <type> | <aliases_用逗號分隔，無則填->
RELATION: <src_name> | <dst_name>

類型枚舉（只能用以下 12 種）：
person / project / concept / tool / metric / org / place / event / doc / task / topic / other

什麼是好的 entity：
- 專有名詞：OpenClaw, Aquifer, MiniMax-M2.7, Driftwood, HDBSCAN
- 具名的人/專案/工具/組織：MK, Jenny, Evan, Garmin, Discord
- 可被再次查詢的概念：hybrid search, turn embedding, knowledge graph

什麼不是 entity（禁止輸出）：
- 角色泛稱：助理、使用者、用戶、assistant、user
- 動作或事件描述：Gateway 重啟、afterburn 故障排除、cleanup
- 純數值/metric 片段：120秒超時、401錯誤、600秒、22K cache write
- 泛用工具名：API、DB、LLM、CLI、Bash、diff
- 檔案路徑或程式碼符號：cc-hook-context.sh、extractUserTurns、.claude.json
- Discord message ID 或其他不透明 ID
- 帶版本的變體（用 aliases 代替）：afterburn v0.2 → 用 afterburn + alias "v0.2"
- 太廣泛的概念：Bug、config、agent、extensions、hooks

規則：
1. 只輸出專有名詞級的實體，最多 10 筆 ENTITY（寧少勿多）。
2. aliases 填同義詞、縮寫、別名；無則填 -。
3. RELATION 只輸出共現對（src != dst）；src/dst 必須是本段已出現的 ENTITY name。
4. 同一 pair 只輸出一次；最多 15 對 RELATION。
5. 若本 session 無值得記錄的實體，仍輸出 ===ENTITIES=== 標籤，內容留空。
6. 禁止輸出 JSON。

===WORKING_FACTS===
Extract 0-5 current-state facts from this session.
Each fact describes what IS true NOW, not what happened.

Format: WFACT: <subject> | <statement>
Rules:
- Subject: entity/project/concept canonical name
- Statement: current state in 繁體中文, NOT action taken
- Merge related actions into one state
- If nothing changed, leave empty

Bad: "WFACT: cc-afterburn | 改用 enrich() 和 summaryFn"
Good: "WFACT: miranda-memory | 已上線，11 模組，CC + gateway 都走 thin wrapper"

===HANDOFF===
Write a handoff note for the next session to pick up where this one left off.
One tag per line. Use 繁體中文 for values.

STATUS: in_progress | interrupted | completed | blocked
LAST_STEP: 上一段最後在做的具體事情（一句話）
NEXT: 下一步最小可執行動作（一句話）
STOP_REASON: natural | interrupted | blocked | context_full
DECIDED: 本 session 做了的關鍵決策（選填）
BLOCKER: 卡住的原因（選填，只有 STATUS 是 blocked 時才寫）

Rules:
- STATUS, LAST_STEP, NEXT, STOP_REASON are required.
- DECIDED and BLOCKER are optional. Omit if not applicable.
- LAST_STEP and NEXT must refer to things actually discussed in the conversation. Do NOT invent tasks.
- If the session was trivial (greetings only, < 3 substantive exchanges), output these 4 lines:
  STATUS: completed
  LAST_STEP: 簡短交談
  NEXT: 無
  STOP_REASON: natural`;
}

// ---------------------------------------------------------------------------

const SUMMARY_MARKERS = [
    '===SESSION_ENTRIES===',
    '===EMOTIONAL_STATE===',
    '===RECAP===',
    '===ENTITIES===',
    '===WORKING_FACTS===',
    '===HANDOFF===',
];

function parseSummaryOutput(output) {
    const sections = {};
    for (let i = 0; i < SUMMARY_MARKERS.length; i++) {
        const start = output.indexOf(SUMMARY_MARKERS[i]);
        if (start === -1) continue;
        const contentStart = start + SUMMARY_MARKERS[i].length;
        let end = output.length;
        for (let j = i + 1; j < SUMMARY_MARKERS.length; j++) {
            const candidate = output.indexOf(SUMMARY_MARKERS[j], contentStart);
            if (candidate !== -1) { end = candidate; break; }
        }
        const key = SUMMARY_MARKERS[i].replace(/===/g, '').toLowerCase();
        sections[key] = (end > contentStart ? output.slice(contentStart, end) : output.slice(contentStart)).trim();
    }
    return sections;
}

function parseRecapLines(text) {
    const recap = {
        title: '', overview: '', topics: [], decisions: [], actions_completed: [],
        open_loops: [], files_mentioned: [], important_facts: [], reusable_patterns: [],
        focus_decision: 'keep', focus: '', todo_new: [], todo_done: [],
    };

    for (const line of (text || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^([A-Z_]+):\s*(.*)/);
        if (!match) continue;
        const [, tag, value] = match;

        switch (tag) {
            case 'TITLE': recap.title = value; break;
            case 'OVERVIEW': recap.overview = value; break;
            case 'TOPIC': {
                const p = value.split('|').map(s => s.trim());
                if (p[0]) recap.topics.push({ name: p[0], summary: p[1] || '' });
                break;
            }
            case 'DECISION': {
                const p = value.split('|').map(s => s.trim());
                if (p[0]) recap.decisions.push({ decision: p[0], reason: p[1] || '' });
                break;
            }
            case 'ACTION': {
                const p = value.split('|').map(s => s.trim());
                if (p[0]) recap.actions_completed.push({
                    action: p[0],
                    status: (p[1] || 'done').toLowerCase() === 'partial' ? 'partial' : 'done',
                });
                break;
            }
            case 'OPEN': {
                const p = value.split('|').map(s => s.trim());
                const o = (p[1] || 'unknown').toLowerCase();
                if (p[0]) recap.open_loops.push({
                    item: p[0],
                    owner: ['mk', 'agent', 'unknown'].includes(o) ? o : 'unknown',
                });
                break;
            }
            case 'FACT': if (value) recap.important_facts.push(value); break;
            case 'PATTERN': {
                const p = value.split('|').map(s => s.trim());
                if (p[0] && p[1]) recap.reusable_patterns.push({
                    pattern: p[0], trigger: p[1], action: p[2] || '',
                    durability: (p[3] || 'derived').toLowerCase() === 'invariant' ? 'invariant' : 'derived',
                });
                break;
            }
            case 'FOCUS_DECISION':
                recap.focus_decision = value.toLowerCase().trim() === 'update' ? 'update' : 'keep';
                break;
            case 'FOCUS': recap.focus = value; break;
            case 'TODO_NEW': if (value) recap.todo_new.push(value); break;
            case 'TODO_DONE': if (value) recap.todo_done.push(value); break;
        }
    }
    return recap;
}

function parseWorkingFacts(text) {
    if (!text || typeof text !== 'string') return [];
    const facts = [];
    for (const line of text.split('\n')) {
        const m = line.trim().match(/^WFACT:\s*(.+?)\s*\|\s*(.+)/);
        if (!m) continue;
        const subject = m[1].trim().slice(0, 100);
        const statement = m[2].trim().slice(0, 500);
        if (!subject || !statement) continue;
        facts.push({ subject, statement });
        if (facts.length >= 5) break;
    }
    return facts;
}

const VALID_HANDOFF_STATUS = new Set(['in_progress', 'interrupted', 'completed', 'blocked']);
const VALID_STOP_REASON = new Set(['natural', 'interrupted', 'blocked', 'context_full']);

function normalizeEnum(raw, validSet) {
    const v = raw.trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
    return validSet.has(v) ? v : null;
}

function parseHandoffSection(text) {
    if (!text || typeof text !== 'string') return null;
    const handoff = { status: 'completed', lastStep: '', next: '', stopReason: 'natural', decided: '', blocker: '' };
    for (const line of text.split('\n')) {
        const m = line.trim().match(/^([A-Z_]+):\s*(.*)/);
        if (!m) continue;
        const [, tag, value] = m;
        switch (tag) {
            case 'STATUS': handoff.status = normalizeEnum(value, VALID_HANDOFF_STATUS) || 'completed'; break;
            case 'LAST_STEP': handoff.lastStep = value.trim().slice(0, 200); break;
            case 'NEXT': handoff.next = value.trim().slice(0, 200); break;
            case 'STOP_REASON': handoff.stopReason = normalizeEnum(value, VALID_STOP_REASON) || 'natural'; break;
            case 'DECIDED': handoff.decided = value.trim().slice(0, 200); break;
            case 'BLOCKER': handoff.blocker = value.trim().slice(0, 200); break;
        }
    }
    if (!handoff.lastStep || !handoff.next) return null;
    return handoff;
}

module.exports = {
    buildSummaryPrompt,
    parseSummaryOutput,
    parseRecapLines,
    parseWorkingFacts,
    parseHandoffSection,
    SUMMARY_MARKERS,
};
