'use strict';

// Aquifer default persona — parameterized daily_entries writer.
// Schema matches miranda.daily_entries (id / event_at / source / tag / text /
// agent_id / session_id / metadata / dedupe_key) — hosts clone that DDL into
// their own schema and set persona.dailyTable = '<schema>.daily_entries'.
//
// Host must create the table before use:
//   CREATE TABLE jenny.daily_entries (LIKE miranda.daily_entries INCLUDING ALL);

const crypto = require('crypto');
const { parseHandoffSection } = require('../shared/summary-parser');

const UPSERT_TAGS = new Set(['[FOCUS]', '[TODO]', '[STATS]', '[HIGHLIGHT]', '[SYSTEM]', '[HANDOFF]']);

function taipeiDateString(now) {
  if (!now) now = new Date();
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function textHash6(text) {
  const normalized = (text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return 'empty';
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 6);
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Invalid dailyTable identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function quoteTableName(tableName) {
  if (typeof tableName !== 'string') throw new Error('dailyTable must be a string');
  const parts = tableName.split('.');
  if (parts.length < 1 || parts.length > 2 || parts.some(part => !part)) {
    throw new Error(`Invalid dailyTable name: ${tableName}`);
  }
  return parts.map(quoteIdentifier).join('.');
}

async function insertDailyEntry(pool, tableName, { eventAt, source, tag, text, agentId, sessionId, metadata, dedupeKey }) {
  const tableSql = quoteTableName(tableName);
  const shouldUpsert = dedupeKey && UPSERT_TAGS.has(tag);
  const sql = shouldUpsert
    ? `INSERT INTO ${tableSql}
         (event_at, source, tag, text, agent_id, session_id, metadata, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         text = EXCLUDED.text,
         event_at = EXCLUDED.event_at,
         metadata = EXCLUDED.metadata
       RETURNING id, event_at, source, tag, text`
    : `INSERT INTO ${tableSql}
         (event_at, source, tag, text, agent_id, session_id, metadata, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id, event_at, source, tag, text`;
  const result = await pool.query(sql, [
    eventAt, source, tag || null, text,
    agentId || 'main', sessionId || null,
    metadata ? JSON.stringify(metadata) : '{}',
    dedupeKey || null,
  ]);
  return result.rows[0] || null;
}

async function getDailyEntries(pool, tableName, date, agentId) {
  const tableSql = quoteTableName(tableName);
  const result = await pool.query(
    `SELECT * FROM ${tableSql}
      WHERE (event_at AT TIME ZONE 'Asia/Taipei')::date = $1
        AND ($2::text IS NULL OR agent_id = $2)
      ORDER BY event_at ASC`,
    [date, agentId || null]
  );
  return result.rows;
}

async function fetchDailyContext(pool, date, agentId, tableName = null) {
  if (!tableName) return '';
  const rows = await getDailyEntries(pool, tableName, date, agentId);
  if (!rows || rows.length === 0) return '';
  let currentFocus = '', currentTodo = '';
  const entries = [];
  for (const row of rows) {
    if (row.tag === '[FOCUS]') currentFocus = row.text;
    else if (row.tag === '[TODO]') currentTodo = row.text;
    else if (!row.tag || row.tag === '[CLI]') {
      const time = new Date(row.event_at).toLocaleTimeString('sv-SE', {
        timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit',
      });
      entries.push(`- (${time}) ${row.text}`);
    }
  }
  const recentEntries = entries.slice(-20);
  const parts = [];
  if (currentFocus) parts.push(`當前焦點: ${currentFocus}`);
  if (currentTodo) parts.push(`當前待辦:\n${currentTodo}`);
  if (recentEntries.length > 0) parts.push(`今日紀錄:\n${recentEntries.join('\n')}`);
  let text = parts.join('\n\n');
  if (text.length > 3000) text = text.slice(0, 3000) + '\n...(truncated)';
  return text;
}

async function writeDailyEntries({
  sections, recap, pool, sessionId, agentId, logger = console,
  source = 'afterburn', tag = null, now, dailyTable,
}) {
  if (!dailyTable) return { inserted: 0, focusUpdated: false, todoUpdated: false };
  if (!now) now = new Date();
  const date = taipeiDateString(now);
  let inserted = 0, focusUpdated = false, todoUpdated = false;

  // Session bullets
  if (sections?.session_entries) {
    const entryLines = sections.session_entries.split('\n');
    const bullets = entryLines.filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2));
    for (const bullet of bullets) {
      const timeMatch = bullet.match(/^\((\d{2}:\d{2})\)\s*(.*)/);
      const text = timeMatch ? timeMatch[2] : bullet;
      const eventAt = now.toISOString();
      const row = await insertDailyEntry(pool, dailyTable, {
        eventAt, source, tag, text,
        agentId, sessionId, metadata: {},
        dedupeKey: `daily:${date}:${textHash6(text)}`,
      });
      if (row) inserted++;
    }
    if (logger.info) logger.info(`[default-persona] wrote ${inserted} daily entries to ${dailyTable}`);
  }

  // Focus
  if (recap?.focus_decision === 'update' && recap.focus) {
    await insertDailyEntry(pool, dailyTable, {
      eventAt: now.toISOString(), source, tag: '[FOCUS]',
      text: recap.focus, agentId, sessionId,
      metadata: { proposed_by: source },
      dedupeKey: `daily:${date}:focus:${source}`,
    });
    focusUpdated = true;
    if (logger.info) logger.info(`[default-persona] focus updated: ${recap.focus.slice(0, 60)}`);
  }

  // TODO
  if (recap?.todo_new?.length > 0 || recap?.todo_done?.length > 0) {
    const todayEntries = await getDailyEntries(pool, dailyTable, date, agentId);
    let currentItems = [];
    for (const row of todayEntries) {
      if (row.tag === '[TODO]') {
        currentItems = row.text.split('\n').map(s => s.replace(/^[-•]\s*/, '').trim()).filter(Boolean);
      }
    }
    if (recap.todo_done?.length > 0) {
      for (const done of recap.todo_done) {
        const dl = done.toLowerCase();
        currentItems = currentItems.filter(item => {
          const il = item.toLowerCase();
          return il !== dl && !il.includes(dl) && !dl.includes(il);
        });
      }
    }
    if (recap.todo_new?.length > 0) {
      for (const n of recap.todo_new) {
        if (!currentItems.some(i => i.toLowerCase() === n.toLowerCase())) currentItems.push(n);
      }
    }
    await insertDailyEntry(pool, dailyTable, {
      eventAt: now.toISOString(), source, tag: '[TODO]',
      text: currentItems.map(i => `- ${i}`).join('\n') || '（全部完成）',
      agentId, sessionId,
      metadata: { proposed_by: source, todo_new: recap.todo_new, todo_done: recap.todo_done },
      dedupeKey: `daily:${date}:todo:${source}`,
    });
    todoUpdated = true;
    if (logger.info) logger.info(`[default-persona] todo updated: ${currentItems.length} items`);
  }

  // Handoff
  if (sections?.handoff) {
    const handoff = parseHandoffSection(sections.handoff);
    if (handoff) {
      let handoffText;
      switch (handoff.status) {
        case 'completed': handoffText = `上一段已完成 ${handoff.lastStep}`; break;
        case 'blocked': handoffText = `上一段卡在 ${handoff.lastStep}`; break;
        default: handoffText = `上一段停在 ${handoff.lastStep}`;
      }
      if (handoff.next && handoff.next !== '無') handoffText += `，下一步建議 ${handoff.next}`;
      if (handoff.decided) handoffText += `，已決定 ${handoff.decided}`;
      if (handoff.blocker && handoff.status !== 'blocked') handoffText += `，卡在 ${handoff.blocker}`;
      handoffText += '。';
      await insertDailyEntry(pool, dailyTable, {
        eventAt: now.toISOString(), source, tag: '[HANDOFF]',
        text: handoffText, agentId, sessionId,
        metadata: { ...handoff, proposed_by: source },
        dedupeKey: `daily:${date}:handoff:${source}`,
      });
      if (logger.info) logger.info(`[default-persona] handoff written: ${handoffText.slice(0, 80)}`);
    }
  }

  return { inserted, focusUpdated, todoUpdated };
}

module.exports = {
  taipeiDateString, textHash6,
  quoteIdentifier, quoteTableName,
  insertDailyEntry, getDailyEntries, fetchDailyContext, writeDailyEntries,
  UPSERT_TAGS,
};
