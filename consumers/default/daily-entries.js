'use strict';

// Aquifer default persona — minimal daily_entries writer.
//
// Parameterized:
//   dailyTable  — full table name like 'jenny.daily_entries'.
//                 If not set, writeDailyEntries is a no-op.
//
// Schema expected (same shape as miranda.daily_entries):
//   agent_id    text
//   date        text (YYYY-MM-DD)
//   time        text (HH:MM)
//   source      text
//   tag         text nullable
//   session_id  text
//   kind        text ('entry' | 'focus' | 'todo_new' | 'todo_done' | 'observation' | 'mood')
//   content     text

function taipeiDateString(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(now);
}

async function writeDailyEntries({
  sections, recap, pool, sessionId, agentId, logger = console,
  source = 'afterburn', tag = null, now = null, dailyTable = null,
}) {
  if (!dailyTable) return;
  const _now = now || new Date();
  const date = taipeiDateString(_now);
  const time = _now.toISOString().slice(11, 16);

  const rows = [];
  const sessionEntries = sections?.session_entries || '';
  for (const line of sessionEntries.split('\n')) {
    const m = line.match(/^-\s*\((\d{1,2}:\d{2})\)\s*(.+)/);
    if (m) rows.push({ kind: 'entry', content: m[2].trim(), time: m[1] });
  }
  const focusLine = sessionEntries.match(/^焦點:\s*(.+)$/m) || sessionEntries.match(/^Focus:\s*(.+)$/mi);
  if (focusLine) rows.push({ kind: 'focus', content: focusLine[1].trim() });

  if (Array.isArray(recap?.todo_new)) {
    for (const t of recap.todo_new) rows.push({ kind: 'todo_new', content: String(t) });
  }
  if (Array.isArray(recap?.todo_done)) {
    for (const t of recap.todo_done) rows.push({ kind: 'todo_done', content: String(t) });
  }

  if (rows.length === 0) {
    if (logger.info) logger.info(`[default-persona] wrote 0 daily entries`);
    return;
  }

  const values = [];
  const placeholders = [];
  rows.forEach((r, i) => {
    const base = i * 8;
    placeholders.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`);
    values.push(agentId, date, r.time || time, source, tag, sessionId, r.kind, r.content);
  });
  const sql = `INSERT INTO ${dailyTable} (agent_id,date,time,source,tag,session_id,kind,content) VALUES ${placeholders.join(',')}`;
  await pool.query(sql, values);
  if (logger.info) logger.info(`[default-persona] wrote ${rows.length} daily entries to ${dailyTable}`);
}

async function fetchDailyContext(pool, date, agentId, dailyTable = null) {
  if (!dailyTable) return '';
  const r = await pool.query(
    `SELECT time, kind, content FROM ${dailyTable} WHERE agent_id=$1 AND date=$2 ORDER BY time ASC`,
    [agentId, date]
  );
  return r.rows.map(x => `[${x.time}] ${x.content}`).join('\n');
}

module.exports = { writeDailyEntries, fetchDailyContext, taipeiDateString };
