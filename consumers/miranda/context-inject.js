'use strict';

const { getDailyEntries } = require('./daily-entries');

// ---------------------------------------------------------------------------
// buildSessionContext — pure function, testable.
// Emits the Miranda persona briefing that gets prepended to the system
// prompt. Style: 散文段落, 結論收尾, 不給 bullet/table/headers.
// ---------------------------------------------------------------------------

const TODO_CAP = 5;

function buildSessionContext({ today, agentId, focusText, todoItems, moodLine, handoffText, cliEntries }) {
    const parts = [];
    parts.push('你是 Miranda。以下是你已經知道的現況，直接用來回應，不需要讀檔或搜尋。像做 briefing——帶現況也帶判斷和建議。用散文段落，最後一句必須是結論或建議，不能是問句。若草稿有 bullet、標題、表格或問句收尾，改寫再送出。');
    parts.push('回答任何關於過去做過什麼、討論過什麼、決策過什麼的問題時，第一步用 session_recall MCP tool 查，不要用 grep、讀 log、翻檔案。工具在手上就用。');
    parts.push('用完 session_recall 後，如果某筆結果實際幫助了你的回答，呼叫 session_feedback(sessionId, verdict="helpful")；如果結果明顯過時或錯誤，呼叫 session_feedback(sessionId, verdict="unhelpful")，帶簡短 note 說明原因。只對實際影響回答的結果回饋，不要每次 recall 都打分。');

    if (focusText) parts.push(`現在的焦點是${focusText}。`);
    if (handoffText) parts.push(`上一段的交接：${handoffText}`);

    const items = (todoItems || []).slice(0, TODO_CAP);
    if (items.length > 0) parts.push(`手上還有${items.join('、')}。`);

    if (moodLine) parts.push(`整體狀態${moodLine}。`);

    const cli = (cliEntries || []).slice(-15);
    if (cli.length > 0) parts.push(`今天已經做過的事（不要重複）：${cli.join('；')}`);

    if (parts.length <= 2) return '';
    return `<session-context date="${today}" agent="${agentId}">\n${parts.join('\n')}\n</session-context>`;
}

// ---------------------------------------------------------------------------
// extractFocusTodoMood — pull state rows (focus/todo/mood/handoff) + cli log
// ---------------------------------------------------------------------------

function extractFocusTodoMood(todayEntries, yesterdayEntries) {
    const allEntries = [...(todayEntries || []), ...(yesterdayEntries || [])]
        .sort((a, b) => new Date(b.event_at) - new Date(a.event_at));

    const preferCli = (tag) => {
        const cli = allEntries.find(e => e.tag === tag && e.source === 'cli');
        return cli || allEntries.find(e => e.tag === tag);
    };
    const focusEntry = preferCli('[FOCUS]');
    const todoEntry = preferCli('[TODO]');
    const moodEntry = allEntries.find(e => e.tag === '[MOOD]');
    const handoffEntry = preferCli('[HANDOFF]');

    const focusText = focusEntry
        ? focusEntry.text.split('\n').map(l => l.trim().replace(/^-\s*/, '')).filter(Boolean).join(', ')
        : '';

    const todoItems = todoEntry
        ? todoEntry.text.split('\n').map(l => l.trim().replace(/^-\s*/, '')).filter(Boolean)
        : [];

    const moodLine = moodEntry ? moodEntry.text.trim() : '';

    let handoffText = '';
    if (handoffEntry) {
        const meta = handoffEntry.metadata || {};
        const isTrivial = (meta.status === 'completed' && meta.next === '無')
            || handoffEntry.text.trim().startsWith('上一段已完成 簡短交談');
        if (!isTrivial) {
            handoffText = handoffEntry.text.trim();
        }
    }

    const stateTags = new Set(['[FOCUS]', '[TODO]', '[MOOD]', '[HANDOFF]', '[HIGHLIGHT]', '[NARRATIVE]']);
    const logEntries = (todayEntries || [])
        .filter(e => !stateTags.has(e.tag))
        .sort((a, b) => new Date(a.event_at) - new Date(b.event_at))
        .map(e => e.text.trim())
        .filter(Boolean);

    return { focusText, todoItems, moodLine, handoffText, cliEntries: logEntries };
}

// ---------------------------------------------------------------------------
// computeInjection — gateway/CC shared: queries daily_entries + aquifer.bootstrap
// and returns a ready-to-prepend context string. No host-specific wiring.
// ---------------------------------------------------------------------------

function dateTaipei(d) {
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
}

async function computeInjection({ aquifer, pool, agentId, now, includeBootstrap = true }) {
    if (!now) now = new Date();
    const today = dateTaipei(now);
    const yesterday = dateTaipei(new Date(now.getTime() - 86400000));

    const [todayEntries, yesterdayEntries] = await Promise.all([
        getDailyEntries(pool, today, agentId),
        getDailyEntries(pool, yesterday, agentId),
    ]);

    const state = extractFocusTodoMood(todayEntries, yesterdayEntries);
    const context = buildSessionContext({ today, agentId, ...state });

    let bootstrapText = '';
    if (includeBootstrap && aquifer) {
        try {
            const bs = await aquifer.bootstrap({ agentId, limit: 5, maxChars: 2000, format: 'text' });
            if (bs.text && bs.sessions && bs.sessions.length > 0) bootstrapText = '\n' + bs.text;
        } catch { /* best-effort */ }
    }

    return context + bootstrapText;
}

module.exports = {
    buildSessionContext,
    extractFocusTodoMood,
    computeInjection,
};
