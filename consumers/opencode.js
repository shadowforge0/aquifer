'use strict';

/**
 * Aquifer — OpenCode Ingest Consumer
 *
 * Reads session history from OpenCode's local SQLite database and commits
 * conversations into Aquifer for long-term memory (embedding + recall).
 *
 * OpenCode stores sessions in ~/.local/share/opencode/opencode.db (SQLite)
 * with a Drizzle-managed schema: session → message → part.
 *
 * Usage (via CLI):
 *   aquifer ingest-opencode [options]
 *
 * Options:
 *   --db PATH           OpenCode SQLite path (default: ~/.local/share/opencode/opencode.db)
 *   --agent-id ID       Aquifer agent ID to store under (default: "opencode")
 *   --limit N           Max sessions to ingest per run (default: 50)
 *   --since YYYY-MM-DD  Only ingest sessions updated after this date
 *   --min-messages N    Min user messages to ingest (default: 3)
 *   --dry-run           Show what would be ingested without committing
 *   --enrich            Run enrich (summary + embedding) after commit
 *   --json              JSON output
 *   --session-id ID     Ingest a single OpenCode session by ID
 */

const path = require('path');
const os = require('os');
// ---------------------------------------------------------------------------
// SQLite access — use Node 22+ built-in or fall back to better-sqlite3
// ---------------------------------------------------------------------------

function openSqlite(dbPath) {
  // Try node:sqlite (Node 22+)
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath, { open: true, readOnly: true });
  } catch {
    // not available
  }

  // Try better-sqlite3
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly: true });
  } catch {
    // not available
  }

  throw new Error(
    'No SQLite driver found. Upgrade to Node 22+ or install better-sqlite3:\n' +
    '  npm install better-sqlite3'
  );
}

// ---------------------------------------------------------------------------
// Read sessions from OpenCode SQLite
// ---------------------------------------------------------------------------

function getOpenCodeSessions(db, { limit = 50, since = null, sessionId = null } = {}) {
  if (sessionId) {
    const row = db.prepare(
      'SELECT id, title, directory, time_created, time_updated FROM session WHERE id = ?'
    ).get(sessionId);
    return row ? [row] : [];
  }

  let sql = `
    SELECT id, title, directory, time_created, time_updated
    FROM session
    WHERE 1=1
  `;
  const params = [];

  if (since) {
    sql += ' AND time_updated >= ?';
    params.push(new Date(since).getTime());
  }

  sql += ' ORDER BY time_updated DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function getSessionConversation(db, sessionId) {
  // Get messages ordered by creation time
  const messages = db.prepare(`
    SELECT id, data, time_created
    FROM message
    WHERE session_id = ?
    ORDER BY time_created ASC
  `).all(sessionId);

  // Get all parts for this session, grouped by message
  const parts = db.prepare(`
    SELECT id, message_id, data, time_created
    FROM part
    WHERE session_id = ?
    ORDER BY time_created ASC
  `).all(sessionId);

  const partsByMsg = new Map();
  for (const p of parts) {
    const msgId = p.message_id;
    if (!partsByMsg.has(msgId)) partsByMsg.set(msgId, []);
    partsByMsg.get(msgId).push(p);
  }

  return { messages, partsByMsg };
}

// ---------------------------------------------------------------------------
// Normalize OpenCode conversation → Aquifer messages format
// ---------------------------------------------------------------------------

function normalizeConversation(messages, partsByMsg) {
  const normalized = [];
  let model = null;
  let tokensIn = 0, tokensOut = 0;
  let startedAt = null, lastMessageAt = null;

  for (const msg of messages) {
    const msgData = JSON.parse(msg.data);
    const role = msgData.role;
    if (!role || !['user', 'assistant'].includes(role)) continue;

    // Extract model info
    if (!model) {
      if (msgData.model?.modelID) model = msgData.model.modelID;
      else if (msgData.modelID) model = msgData.modelID;
      else if (msgData.providerID && msgData.modelID) model = `${msgData.providerID}/${msgData.modelID}`;
    }

    // Accumulate tokens
    if (msgData.tokens) {
      tokensIn += msgData.tokens.input || 0;
      tokensOut += msgData.tokens.output || 0;
    }

    // Timestamp (ms → ISO)
    const ts = msg.time_created ? new Date(msg.time_created).toISOString() : null;
    if (ts && !startedAt) startedAt = ts;
    if (ts) lastMessageAt = ts;

    // Build content from parts
    const msgParts = partsByMsg.get(msg.id) || [];
    const textParts = [];

    for (const part of msgParts) {
      let partData;
      try { partData = JSON.parse(part.data); } catch { continue; }

      if (partData.type === 'text' && partData.text) {
        textParts.push(partData.text);
      } else if (partData.type === 'tool' && partData.state?.output) {
        // Include tool results as context (truncated)
        const toolName = partData.tool || 'tool';
        const output = partData.state.output;
        const truncated = output.length > 500 ? output.slice(0, 500) + '...' : output;
        textParts.push(`[${toolName}]: ${truncated}`);
      }
    }

    const content = textParts.join('\n').trim();
    if (!content) continue;

    // Merge consecutive same-role messages (OpenCode splits assistant into steps)
    const last = normalized[normalized.length - 1];
    if (last && last.role === role) {
      last.content += '\n\n' + content;
      last.timestamp = ts || last.timestamp;
    } else {
      normalized.push({ role, content, timestamp: ts });
    }
  }

  return {
    messages: normalized,
    userCount: normalized.filter(m => m.role === 'user').length,
    assistantCount: normalized.filter(m => m.role === 'assistant').length,
    model,
    tokensIn,
    tokensOut,
    startedAt,
    lastMessageAt,
  };
}

// ---------------------------------------------------------------------------
// Ingest command
// ---------------------------------------------------------------------------

async function ingestOpenCode(aquifer, args) {
  const defaultDb = path.join(os.homedir(), '.local/share/opencode/opencode.db');
  const dbPath = args.flags.db || defaultDb;
  const agentId = args.flags['agent-id'] || 'opencode';
  const limit = Math.max(1, parseInt(args.flags.limit || '50', 10) || 50);
  const since = args.flags.since || null;
  const dryRun = !!args.flags['dry-run'];
  const doEnrich = !!args.flags.enrich;
  const jsonOutput = !!args.flags.json;
  const sessionId = args.flags['session-id'] || null;
  const minUserMessages = parseInt(args.flags['min-messages'] || '3', 10);

  // Open OpenCode DB
  let db;
  try {
    db = openSqlite(dbPath);
  } catch (err) {
    console.error(`Cannot open OpenCode database: ${err.message}`);
    console.error(`Expected at: ${dbPath}`);
    process.exit(1);
  }

  // Check which sessions are already in Aquifer
  const existingSet = new Set();
  try {
    const existing = await aquifer.exportSessions({ source: 'opencode', limit: 10000 });
    for (const row of existing) existingSet.add(row.session_id);
  } catch {
    // exportSessions may not exist in all versions
  }

  // Get OpenCode sessions
  const sessions = getOpenCodeSessions(db, { limit, since, sessionId });

  const results = [];
  let committed = 0, skipped = 0, failed = 0;

  for (const session of sessions) {
    const sid = session.id;

    // Skip already ingested (unless explicitly requested by session-id)
    if (!sessionId && existingSet.has(sid)) {
      skipped++;
      if (jsonOutput) results.push({ sessionId: sid, status: 'exists' });
      continue;
    }

    // Read conversation
    const { messages, partsByMsg } = getSessionConversation(db, sid);
    const norm = normalizeConversation(messages, partsByMsg);

    if (norm.userCount < minUserMessages) {
      skipped++;
      if (jsonOutput) results.push({ sessionId: sid, status: 'too_short', userMessages: norm.userCount });
      else if (!jsonOutput && !dryRun) {
        console.log(`  [skip] ${sid} — ${norm.userCount} user msg(s)`);
      }
      continue;
    }

    const info = {
      sessionId: sid,
      title: session.title,
      messages: norm.messages.length,
      userMessages: norm.userCount,
      model: norm.model,
    };

    if (dryRun) {
      info.status = 'dry-run';
      if (jsonOutput) {
        results.push(info);
      } else {
        console.log(`  [dry-run] ${sid} "${session.title}" — ${norm.messages.length} msgs (${norm.userCount} user)`);
      }
      continue;
    }

    // Commit to Aquifer
    try {
      await aquifer.commit(sid, norm.messages, {
        agentId,
        source: 'opencode',
        model: norm.model,
        tokensIn: norm.tokensIn,
        tokensOut: norm.tokensOut,
        startedAt: norm.startedAt,
        lastMessageAt: norm.lastMessageAt,
      });
      committed++;
      info.status = 'committed';

      // Enrich if requested
      if (doEnrich) {
        try {
          const enrichResult = await aquifer.enrich(sid, { agentId });
          info.status = 'enriched';
          info.turnsEmbedded = enrichResult.turnsEmbedded;
          info.entitiesFound = enrichResult.entitiesFound;
        } catch (enrichErr) {
          info.enrichError = enrichErr.message;
        }
      }

      if (jsonOutput) {
        results.push(info);
      } else {
        const enrichNote = info.turnsEmbedded !== null && info.turnsEmbedded !== undefined
          ? ` (${info.turnsEmbedded} turns, ${info.entitiesFound} entities)`
          : '';
        console.log(`  [${committed}] ${sid} "${session.title}"${enrichNote}`);
      }
    } catch (err) {
      failed++;
      info.status = 'error';
      info.error = err.message;
      if (jsonOutput) {
        results.push(info);
      } else {
        console.error(`  [error] ${sid}: ${err.message}`);
      }
    }
  }

  // Close SQLite
  db.close();

  // Summary
  if (jsonOutput) {
    console.log(JSON.stringify({ committed, skipped, failed, total: sessions.length, sessions: results }, null, 2));
  } else {
    console.log(`\nDone. committed=${committed} skipped=${skipped} failed=${failed} total=${sessions.length}`);
    if (committed > 0 && !doEnrich) {
      console.log('Tip: run "aquifer backfill" to enrich committed sessions.');
    }
  }

  if (failed > 0) process.exitCode = 2;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ingestOpenCode,
  // Exposed for testing
  openSqlite,
  getOpenCodeSessions,
  getSessionConversation,
  normalizeConversation,
};
