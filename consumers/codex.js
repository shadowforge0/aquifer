'use strict';

/**
 * Aquifer — Codex CLI session consumer.
 *
 * Codex writes JSONL rollout files while the TUI is running. This consumer is a
 * source adapter: it knows Codex file layout, session_meta ids, token_count
 * events, and the local marker/claim files needed for safe pull-style sync.
 *
 * Core Aquifer stays generic. The adapter owns:
 *   - JSONL -> commit-ready session normalization
 *   - idle gating so actively-written files are not imported
 *   - DB count reconciliation so later, fuller JSONL snapshots can re-commit
 *   - short/empty session skip policy
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const { normalizeMessages } = require('./shared/normalize');
const { applyEnrichSafetyGate } = require('../core/memory-safety-gate');
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MIN_BYTES = 1000;
const DEFAULT_MAX_IMPORTS = 1;
const DEFAULT_MAX_AFTERBURNS = 1;
const DEFAULT_MIN_IMPORT_USER_MESSAGES = 3;
const MAX_RETRY_COUNT = 3;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_RECOVERY_MAX_BYTES = 1024 * 1024;
const DEFAULT_RECOVERY_MAX_MESSAGES = 80;
const DEFAULT_RECOVERY_MAX_CHARS = 24000;
const DEFAULT_RECOVERY_MAX_PROMPT_TOKENS = 9000;
const RECOVERY_DECISIONS = new Set(['declined', 'deferred', 'skipped']);

function ensureDirs(...dirs) {
    for (const dir of dirs.filter(Boolean)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonlEntries(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
            entries.push(JSON.parse(line));
        } catch {
            // Codex can leave a partial trailing write. Ignore malformed lines.
        }
    }
    return entries;
}

function assertSafeSessionId(sessionId, field = 'sessionId') {
    const value = String(sessionId || '').trim();
    if (!SAFE_SESSION_ID_RE.test(value)) {
        throw new Error(`Invalid ${field}: must match ${SAFE_SESSION_ID_RE}`);
    }
    return value;
}

function encodeMarkerValue(value) {
    return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function decodeMarkerValue(value) {
    try {
        return Buffer.from(String(value || ''), 'base64url').toString('utf8');
    } catch {
        return '';
    }
}

function safeMarkerKey(sessionId) {
    const safeSessionId = assertSafeSessionId(sessionId);
    return crypto.createHash('sha256').update(safeSessionId).digest('hex').slice(0, 32);
}

function legacyMarkerPath(dir, sessionId) {
    try {
        const safeSessionId = assertSafeSessionId(sessionId);
        return path.join(dir, safeSessionId);
    } catch {
        return null;
    }
}

function markerPath(dir, sessionId) {
    return path.join(dir, safeMarkerKey(sessionId));
}

function readMarkerFile(dir, sessionId) {
    if (!dir) return null;
    const digestPath = markerPath(dir, sessionId);
    try {
        return { path: digestPath, content: fs.readFileSync(digestPath, 'utf8').trim(), legacy: false };
    } catch {}

    const legacyPath = legacyMarkerPath(dir, sessionId);
    if (!legacyPath) return null;
    try {
        return { path: legacyPath, content: fs.readFileSync(legacyPath, 'utf8').trim(), legacy: true };
    } catch {
        return null;
    }
}

function readMarkerSessionId(content, fallback = null) {
    const match = String(content || '').match(/^session:([A-Za-z0-9_-]+)$/m);
    const decoded = match ? decodeMarkerValue(match[1]) : fallback;
    if (!decoded) return null;
    try {
        return assertSafeSessionId(decoded);
    } catch {
        return null;
    }
}

function readMarkerMetadataFromContent(content) {
    const match = String(content || '').match(/^metadata:([A-Za-z0-9_-]+)$/m);
    if (!match) return {};
    try {
        const parsed = JSON.parse(decodeMarkerValue(match[1]));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function listMarkerEntries(dir) {
    if (!dir) return [];
    let names = [];
    try {
        names = fs.readdirSync(dir).filter(Boolean);
    } catch {
        return [];
    }
    const entries = [];
    for (const name of names) {
        const filePath = path.join(dir, name);
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue;
            const content = fs.readFileSync(filePath, 'utf8').trim();
            const sessionId = readMarkerSessionId(content, name);
            if (!sessionId) continue;
            entries.push({
                sessionId,
                markerPath: filePath,
                markerName: name,
                content,
                metadata: readMarkerMetadataFromContent(content),
                stat,
            });
        } catch {}
    }
    return entries;
}

function recoveryDecisionKey(candidate = {}) {
    const metadata = candidate.metadata || {};
    const payload = {
        sessionId: candidate.sessionId || null,
        fileSessionId: candidate.fileSessionId || metadata.fileSessionId || null,
        transcriptHash: candidate.transcriptHash || metadata.transcriptHash || metadata.transcript_hash || null,
        filePath: candidate.filePath || metadata.filePath || null,
        size: candidate.size || metadata.size || null,
        mtimeMs: candidate.mtimeMs || metadata.mtimeMs || null,
        phase: candidate.phase || metadata.phase || 'curated_memory_v1',
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function recoveryDecisionPath(dir, candidate = {}) {
    return path.join(dir, recoveryDecisionKey(candidate));
}

function readRecoveryDecision(paths, candidate = {}) {
    if (!paths.decisionDir) return null;
    try {
        const content = fs.readFileSync(recoveryDecisionPath(paths.decisionDir, candidate), 'utf8').trim();
        const firstLine = content.split(/\r?\n/)[0] || '';
        const [, status] = firstLine.split(/\s+/);
        if (!RECOVERY_DECISIONS.has(status)) return null;
        return {
            status,
            metadata: readMarkerMetadataFromContent(content),
        };
    } catch {
        return null;
    }
}

function writeRecoveryDecision(paths, candidate = {}, status, metadata = {}) {
    if (!RECOVERY_DECISIONS.has(status)) throw new Error(`Invalid recovery decision: ${status}`);
    ensureDirs(paths.decisionDir);
    const content = [
        `${new Date().toISOString()} ${status}`,
        `metadata:${encodeMarkerValue(JSON.stringify({
            sessionId: candidate.sessionId || null,
            fileSessionId: candidate.fileSessionId || null,
            transcriptHash: candidate.transcriptHash || null,
            filePath: candidate.filePath || null,
            ...metadata,
        }))}`,
    ].join('\n');
    fs.writeFileSync(recoveryDecisionPath(paths.decisionDir, candidate), `${content}\n`, 'utf8');
}

function hashNormalizedTranscript(normalized = {}) {
    const messages = Array.isArray(normalized.messages) ? normalized.messages : [];
    const payload = {
        messages: messages.map(message => ({
            role: message.role || null,
            content: message.content || '',
            timestamp: message.timestamp || null,
        })),
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function normalizeCodexEntries(entries, opts = {}) {
    const fileSessionId = opts.fileSessionId || null;
    let sessionId = fileSessionId ? assertSafeSessionId(fileSessionId, 'fileSessionId') : null;

    for (const obj of entries || []) {
        if (!obj || typeof obj !== 'object') continue;

        if (obj.type === 'session_meta') {
            sessionId = obj.payload?.id ? assertSafeSessionId(obj.payload.id, 'session_meta.id') : sessionId;
        }
    }

    const normalized = normalizeMessages(entries || [], { adapter: 'codex' });
    const result = {
        sessionId,
        fileSessionId,
        ...normalized,
        model: normalized.model || 'codex-cli',
    };

    return {
        ...result,
        transcriptHash: hashNormalizedTranscript(result),
    };
}

function parseCodexSessionFile(filePath) {
    const fileSessionId = path.basename(filePath, '.jsonl');
    const rawEntries = readJsonlEntries(filePath);
    const normalized = normalizeCodexEntries(rawEntries, { fileSessionId });
    return {
        path: filePath,
        fileSessionId,
        sessionId: normalized.sessionId || fileSessionId,
        rawEntries,
        normalized,
    };
}

function walkJsonlFiles(dir, acc = []) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc;
    }

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkJsonlFiles(full, acc);
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            try {
                const stat = fs.statSync(full);
                acc.push({ path: full, fileSessionId: path.basename(entry.name, '.jsonl'), stat });
            } catch {}
        }
    }
    return acc;
}

function normalizeStringSet(values) {
    const out = new Set();
    const input = Array.isArray(values) ? values : String(values || '').split(',');
    for (const value of input) {
        const cleaned = String(value || '').trim();
        if (cleaned) out.add(cleaned);
    }
    return out;
}

function normalizePathSet(values) {
    const out = new Set();
    for (const value of normalizeStringSet(values)) out.add(path.resolve(value));
    return out;
}

function shouldExcludeFile(entry, opts = {}) {
    const excludePaths = normalizePathSet(opts.excludePaths || opts.excludeFilePaths);
    return excludePaths.has(path.resolve(entry.path));
}

function shouldExcludeCandidate(candidate, opts = {}) {
    const excludeSessionIds = normalizeStringSet(opts.excludeSessionIds);
    if (excludeSessionIds.has(candidate.sessionId)) return true;
    if (excludeSessionIds.has(candidate.fileSessionId)) return true;
    return false;
}

function matchesRecoveryProvenance(metadata = {}, opts = {}, defaults = {}) {
    const expected = {
        source: opts.source || defaults.source || 'codex',
        agentId: opts.agentId || defaults.agentId || 'main',
        sessionKey: opts.sessionKey || null,
        workspace: opts.workspace || opts.workspacePath || null,
        project: opts.project || opts.projectKey || null,
        repoPath: opts.repoPath || null,
    };
    for (const [key, expectedValue] of Object.entries(expected)) {
        if (!expectedValue) continue;
        if (!metadata[key]) return false;
        if (String(metadata[key]) !== String(expectedValue)) return false;
    }
    return true;
}

function isIdleEnough(entry, idleMs, now = Date.now()) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) return true;
    return now - entry.stat.mtimeMs >= idleMs;
}

function readMarker(dir, sessionId) {
    const marker = readMarkerFile(dir, sessionId);
    return marker ? marker.content : null;
}

function readMarkerLabel(dir, sessionId) {
    const marker = readMarker(dir, sessionId);
    if (!marker) return null;
    const firstLine = marker.split(/\r?\n/)[0] || '';
    return firstLine.split(/\s+/)[1] || null;
}

function readMarkerRetries(dir, sessionId) {
    const marker = readMarker(dir, sessionId);
    if (!marker) return 0;
    const match = marker.match(/retries:(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

function isTerminalAfterburnLabel(label) {
    if (!label) return false;
    return label === 'done' || label.startsWith('fatal:');
}

function hasFinalizationSummary(summary = {}) {
    if (typeof summary === 'string') return String(summary).trim().length > 0;
    const input = summary && typeof summary === 'object' ? summary : {};
    const summaryText = String(input.summaryText || input.summary || '').trim();
    const structuredSummary = input.structuredSummary || {};
    return Boolean(summaryText) || Object.keys(structuredSummary).length > 0;
}

function writeMarker(dir, sessionId, label = 'done', metadata = {}) {
    if (!dir) return;
    ensureDirs(dir);
    const safeSessionId = assertSafeSessionId(sessionId);
    const suffix = label ? ` ${label}` : '';
    const lines = [
        `${new Date().toISOString()}${suffix}`,
        `session:${encodeMarkerValue(safeSessionId)}`,
    ];
    if (metadata && Object.keys(metadata).length > 0) {
        lines.push(`metadata:${encodeMarkerValue(JSON.stringify(metadata))}`);
    }
    fs.writeFileSync(markerPath(dir, safeSessionId), `${lines.join('\n')}\n`, 'utf8');
}

function deleteMarker(dir, sessionId) {
    if (!dir) return;
    try { fs.unlinkSync(markerPath(dir, sessionId)); } catch {}
    const legacyPath = legacyMarkerPath(dir, sessionId);
    if (legacyPath) {
        try { fs.unlinkSync(legacyPath); } catch {}
    }
}

function claimSession(claimDir, sessionId) {
    if (!claimDir) return true;
    ensureDirs(claimDir);
    try {
        const fd = fs.openSync(markerPath(claimDir, sessionId), 'wx');
        fs.writeSync(fd, `${process.pid}:${Date.now()}\n`);
        fs.closeSync(fd);
        return true;
    } catch (err) {
        if (err.code === 'EEXIST') return false;
        throw err;
    }
}

function releaseClaim(claimDir, sessionId) {
    deleteMarker(claimDir, sessionId);
}

function isClaimActive(claimDir, sessionId, claimTtlMs = DEFAULT_CLAIM_TTL_MS) {
    if (!claimDir) return false;
    try {
        const [pidStr, tsStr] = fs.readFileSync(markerPath(claimDir, sessionId), 'utf8').trim().split(':');
        const pid = parseInt(pidStr, 10);
        const ts = parseInt(tsStr, 10);

        if (!Number.isFinite(pid) || !Number.isFinite(ts)) {
            deleteMarker(claimDir, sessionId);
            return false;
        }
        try {
            process.kill(pid, 0);
        } catch {
            deleteMarker(claimDir, sessionId);
            return false;
        }
        if (Date.now() - ts > claimTtlMs) {
            deleteMarker(claimDir, sessionId);
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

function defaultPaths(opts = {}) {
    const codexHome = opts.codexHome || DEFAULT_CODEX_HOME;
    const stateDir = opts.stateDir || path.join(codexHome, 'data');
    return {
        codexHome,
        sessionsDir: opts.sessionsDir || path.join(codexHome, 'sessions'),
        importedDir: opts.importedDir || path.join(stateDir, 'codex-sessions-imported'),
        afterburnedDir: opts.afterburnedDir || path.join(stateDir, 'codex-sessions-afterburned'),
        claimDir: opts.claimDir || path.join(stateDir, 'codex-sessions-claiming'),
        decisionDir: opts.decisionDir || path.join(stateDir, 'codex-recovery-decisions'),
    };
}

async function getExistingSession(aquifer, sessionId, agentId, opts = {}) {
    if (!aquifer || typeof aquifer.getSession !== 'function') return null;
    return aquifer.getSession(sessionId, { agentId, source: opts.source || undefined });
}

function readCommittedTranscriptHash(session = {}) {
    const messages = session.messages || session.rawMessages || null;
    if (!messages || typeof messages !== 'object') return null;
    const metadata = messages.metadata || {};
    return metadata.transcript_hash || metadata.transcriptHash || null;
}

function committedSnapshotMatchesView(session = {}, view = {}) {
    if (!session) return false;
    const viewCount = view.counts?.safeMessageCount || (Array.isArray(view.messages) ? view.messages.length : 0);
    const dbMsgCount = Number(session.msg_count || session.msgCount || 0);
    if (viewCount !== dbMsgCount) return false;

    const committedHash = readCommittedTranscriptHash(session);
    if (committedHash && view.transcriptHash && committedHash !== view.transcriptHash) return false;
    return true;
}

async function needsImport(aquifer, candidate, opts = {}) {
    const { importedDir, agentId = 'main', minImportUserMessages = DEFAULT_MIN_IMPORT_USER_MESSAGES } = opts;
    const norm = candidate.normalized;
    const marker = readMarker(importedDir, candidate.sessionId);

    if (norm.userCount < minImportUserMessages || norm.messages.length === 0) {
        return !(marker && marker.includes('skip:'));
    }
    if (!marker) return true;

    const existing = await getExistingSession(aquifer, candidate.sessionId, agentId);
    if (!existing) return true;

    const dbMsgCount = Number(existing.msg_count || existing.msgCount || 0);
    const dbUserCount = Number(existing.user_count || existing.userCount || 0);
    return norm.messages.length > dbMsgCount || norm.userCount > dbUserCount;
}

async function findImportCandidates(aquifer, opts = {}) {
    const paths = defaultPaths(opts);
    const minBytes = opts.minSessionBytes ?? DEFAULT_MIN_BYTES;
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    const maxImports = opts.maxImports ?? DEFAULT_MAX_IMPORTS;
    if (!Number.isFinite(maxImports) || maxImports <= 0) return [];

    ensureDirs(paths.importedDir, paths.afterburnedDir, paths.claimDir);
    let files = walkJsonlFiles(paths.sessionsDir)
        .filter((entry) => !shouldExcludeFile(entry, opts))
        .filter((entry) => entry.stat.size >= minBytes)
        .filter((entry) => isIdleEnough(entry, idleMs, opts.now))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (opts.excludeNewest && files.length > 0) files = files.slice(1);

    const candidates = [];
    for (const entry of files) {
        let candidate;
        try {
            candidate = { ...entry, ...parseCodexSessionFile(entry.path) };
        } catch {
            continue;
        }
        if (shouldExcludeCandidate(candidate, opts)) continue;
        if (isClaimActive(paths.claimDir, candidate.sessionId, opts.claimTtlMs)) continue;
        if (!(await needsImport(aquifer, candidate, { ...opts, importedDir: paths.importedDir }))) continue;
        candidates.push(candidate);
        if (candidates.length >= maxImports) break;
    }
    return candidates;
}

async function needsAfterburn(aquifer, candidate, opts = {}) {
    const paths = defaultPaths(opts);
    const { agentId = 'main' } = opts;
    const importedMarker = readMarkerFile(paths.importedDir, candidate.sessionId);
    const imported = importedMarker ? importedMarker.content : null;
    if (!imported || imported.includes('skip:')) return false;
    const importedMetadata = candidate.metadata || readMarkerMetadataFromContent(imported);

    const finalization = await readFinalization(aquifer, {
        sessionId: candidate.sessionId,
        agentId: importedMetadata.agentId || agentId,
        source: importedMetadata.source || opts.source || 'codex',
        transcriptHash: candidate.transcriptHash || importedMetadata.transcriptHash || importedMetadata.transcript_hash || null,
    });
    if (isRecoverySuppressed(finalization)) return false;

    const afterburnedLabel = readMarkerLabel(paths.afterburnedDir, candidate.sessionId);
    if (isTerminalAfterburnLabel(afterburnedLabel) && afterburnedLabel !== 'done') return false;
    if ((afterburnedLabel === 'timeout' || afterburnedLabel === 'not-found' || afterburnedLabel?.startsWith('failed:'))
        && readMarkerRetries(paths.afterburnedDir, candidate.sessionId) >= MAX_RETRY_COUNT) {
        return false;
    }

    const existing = await getExistingSession(aquifer, candidate.sessionId, agentId);
    if (!existing) return false;
    const status = existing.processing_status || existing.processingStatus;

    if (afterburnedLabel === 'enrich-only' || afterburnedLabel === 'backfill-pending') return true;
    if (afterburnedLabel === 'done') {
        return finalization ? finalization.status === 'pending' || finalization.status === 'failed' : true;
    }
    return status === 'pending' || status === 'failed';
}

async function findAfterburnCandidates(aquifer, opts = {}) {
    const paths = defaultPaths(opts);
    const maxAfterburns = opts.maxAfterburns ?? DEFAULT_MAX_AFTERBURNS;
    if (!Number.isFinite(maxAfterburns) || maxAfterburns <= 0) return [];

    ensureDirs(paths.importedDir, paths.afterburnedDir, paths.claimDir);
    const markers = listMarkerEntries(paths.importedDir)
        .map((marker) => {
            const sessionId = marker.sessionId;
            const label = readMarkerLabel(paths.afterburnedDir, sessionId);
            const imported = marker.content;
            if (!imported || imported.includes('skip:')) return null;
            const transcriptHash = marker.metadata.transcriptHash || marker.metadata.transcript_hash || null;
            if (isTerminalAfterburnLabel(label) && label !== 'done') return null;
            if (isClaimActive(paths.claimDir, sessionId, opts.claimTtlMs)) return null;
            if ((label === 'timeout' || label === 'not-found' || label?.startsWith('failed:'))
                && readMarkerRetries(paths.afterburnedDir, sessionId) >= MAX_RETRY_COUNT) {
                return null;
            }
            const priority = label === 'backfill-pending' ? 2 : (label === 'enrich-only' || label === 'done' ? 1 : 0);
            return { sessionId, stat: marker.stat, priority, metadata: marker.metadata, transcriptHash };
        })
        .filter(Boolean)
        .sort((a, b) => b.priority - a.priority || b.stat.mtimeMs - a.stat.mtimeMs);

    const candidates = [];
    for (const marker of markers) {
        const candidate = { sessionId: marker.sessionId };
        if (shouldExcludeCandidate(candidate, opts)) continue;
        if (!(await needsAfterburn(aquifer, candidate, opts))) continue;
        candidates.push(candidate);
        if (candidates.length >= maxAfterburns) break;
    }
    return candidates;
}

async function importCandidate(aquifer, candidate, opts = {}) {
    const paths = defaultPaths(opts);
    const {
        agentId = 'main',
        source = 'codex',
        sessionKey = 'codex:cli',
        minImportUserMessages = DEFAULT_MIN_IMPORT_USER_MESSAGES,
    } = opts;
    const norm = candidate.normalized;

    if (norm.userCount < minImportUserMessages || norm.messages.length === 0) {
        writeMarker(paths.importedDir, candidate.sessionId, 'skip:short-import', {
            transcriptHash: norm.transcriptHash,
            filePath: candidate.path,
            fileSessionId: candidate.fileSessionId,
            messageCount: norm.messages.length,
            userCount: norm.userCount,
            assistantCount: norm.assistantCount,
            source,
            agentId,
            sessionKey,
            reason: `user_count=${norm.userCount} < min=${minImportUserMessages}`,
        });
        writeMarker(paths.afterburnedDir, candidate.sessionId, `skip:short-import user_count=${norm.userCount}`, {
            transcriptHash: norm.transcriptHash,
            source,
            agentId,
            sessionKey,
        });
        return { status: 'skipped_empty', sessionId: candidate.sessionId, counts: norm };
    }

    await aquifer.commit(candidate.sessionId, norm.messages, {
        rawMessages: {
            normalized: norm.messages,
            metadata: {
                transcript_hash: norm.transcriptHash,
                skipStats: norm.skipStats,
                boundaries: norm.boundaries,
                toolsUsed: norm.toolsUsed,
                raw_entry_count: Array.isArray(candidate.rawEntries) ? candidate.rawEntries.length : 0,
            },
        },
        agentId,
        source,
        sessionKey,
        model: norm.model,
        tokensIn: norm.tokensIn,
        tokensOut: norm.tokensOut,
        startedAt: norm.startedAt,
        lastMessageAt: norm.lastMessageAt,
    });

    if (aquifer.finalization && typeof aquifer.finalization.createTask === 'function') {
        await aquifer.finalization.createTask({
            sessionId: candidate.sessionId,
            agentId,
            source,
            host: 'codex',
            transcriptHash: norm.transcriptHash,
            mode: 'afterburn',
            status: 'pending',
            metadata: {
                filePath: candidate.path,
                fileSessionId: candidate.fileSessionId,
                messageCount: norm.messages.length,
                userCount: norm.userCount,
                assistantCount: norm.assistantCount,
                importedAt: new Date().toISOString(),
            },
        });
    }

    writeMarker(paths.importedDir, candidate.sessionId, '', {
        transcriptHash: norm.transcriptHash,
        filePath: candidate.path,
        fileSessionId: candidate.fileSessionId,
        messageCount: norm.messages.length,
        userCount: norm.userCount,
        assistantCount: norm.assistantCount,
        source,
        agentId,
        sessionKey,
    });
    deleteMarker(paths.afterburnedDir, candidate.sessionId);
    return { status: 'imported', sessionId: candidate.sessionId, counts: norm };
}

async function afterburnCandidate(aquifer, candidate, opts = {}) {
    const paths = defaultPaths(opts);
    const {
        agentId = 'main',
        source = 'codex',
        sessionKey = 'codex:cli',
        minUserMessages = 3,
        finalizationSummary = null,
        finalizationSummaryFn = null,
        summaryFn = null,
        entityParseFn = null,
        postProcess = null,
        replayPostProcess = null,
        buildHooks = null,
        logger = console,
    } = opts;

    const existing = await getExistingSession(aquifer, candidate.sessionId, agentId);
    if (!existing) return { status: 'missing', sessionId: candidate.sessionId };

    const importedMetadata = candidate.metadata
        || readMarkerMetadataFromContent(readMarker(paths.importedDir, candidate.sessionId) || '');
    const finalization = await readFinalization(aquifer, {
        sessionId: candidate.sessionId,
        agentId: importedMetadata.agentId || agentId,
        source: importedMetadata.source || source,
        transcriptHash: candidate.transcriptHash || importedMetadata.transcriptHash || importedMetadata.transcript_hash || null,
    });
    if (isRecoverySuppressed(finalization)) {
        writeMarker(paths.afterburnedDir, candidate.sessionId, 'done', {
            finalizationStatus: finalization.status,
            transcriptHash: candidate.transcriptHash || importedMetadata.transcriptHash || importedMetadata.transcript_hash || null,
        });
        return { status: 'suppressed', sessionId: candidate.sessionId, finalizationStatus: finalization.status };
    }

    const markerLabel = readMarkerLabel(paths.afterburnedDir, candidate.sessionId);
    if (markerLabel === 'enrich-only') {
        if (typeof replayPostProcess !== 'function') {
            return { status: 'missing_replay', sessionId: candidate.sessionId };
        }
        await replayPostProcess(candidate.sessionId, { agentId, candidate, existing });
        writeMarker(paths.afterburnedDir, candidate.sessionId, 'done');
        return { status: 'afterburned', sessionId: candidate.sessionId, replayed: true };
    }

    const userCount = Number(existing.user_count || existing.userCount || candidate.normalized?.userCount || 0);
    if (userCount < minUserMessages) {
        try {
            await aquifer.skip(candidate.sessionId, { agentId, reason: `user_count=${userCount} < min=${minUserMessages}` });
        } catch (err) {
            if (logger && logger.warn) logger.warn(`[codex-consumer] skip failed for ${candidate.sessionId}: ${err.message}`);
        }
        await markFinalizationSkipped(aquifer, {
            ...candidate,
            transcriptHash: candidate.transcriptHash || importedMetadata.transcriptHash || importedMetadata.transcript_hash || null,
            metadata: importedMetadata,
        }, {
            agentId,
            source,
            reason: `user_count=${userCount} < min=${minUserMessages}`,
            mode: 'afterburn',
        });
        writeMarker(paths.afterburnedDir, candidate.sessionId, `skip:short user_count=${userCount}`);
        return { status: 'skipped_short', sessionId: candidate.sessionId, userCount };
    }

    const hooks = typeof buildHooks === 'function'
        ? (await buildHooks(candidate.sessionId, agentId, candidate))
        : {};
    const summaryInput = hooks?.finalizationSummary || finalizationSummary;
    const summaryProvider = hooks?.finalizationSummaryFn || finalizationSummaryFn || hooks?.summaryFn || summaryFn || null;
    const recoveryCandidate = {
        ...candidate,
        filePath: candidate.filePath || candidate.path || importedMetadata.filePath || null,
        transcriptHash: candidate.transcriptHash || importedMetadata.transcriptHash || importedMetadata.transcript_hash || null,
        metadata: { ...importedMetadata, ...(candidate.metadata || {}) },
    };
    const view = materializeRecoveryTranscriptView(recoveryCandidate, opts);
    if (view.status !== 'ok') {
        writeMarker(paths.afterburnedDir, candidate.sessionId, 'backfill-pending', {
            reason: view.status,
            transcriptHash: recoveryCandidate.transcriptHash,
        });
        return { status: 'backfill_pending', sessionId: candidate.sessionId, reason: view.status, view };
    }

    let resolvedSummary = summaryInput;
    if (!hasFinalizationSummary(resolvedSummary) && typeof summaryProvider === 'function') {
        const currentMemory = await resolveCurrentMemoryForFinalization(aquifer, opts);
        resolvedSummary = await summaryProvider(view.messages, {
            aquifer,
            candidate: recoveryCandidate,
            existing,
            view,
            currentMemory,
            agentId,
            source,
            sessionKey,
            entityParseFn: hooks?.entityParseFn || entityParseFn || null,
            postProcess: hooks?.postProcess || postProcess || null,
        });
    }
    if (!hasFinalizationSummary(resolvedSummary)) {
        writeMarker(paths.afterburnedDir, candidate.sessionId, 'backfill-pending', {
            reason: 'missing_summary',
            transcriptHash: view.transcriptHash,
        });
        return {
            status: 'missing_summary',
            sessionId: candidate.sessionId,
            finalizationStatus: finalization ? finalization.status : 'pending',
            view,
        };
    }

    const result = await finalizeCodexSession(aquifer, {
        view,
        summary: typeof resolvedSummary === 'string' ? { summaryText: resolvedSummary, structuredSummary: {} } : resolvedSummary,
        mode: 'afterburn',
        agentId,
        source,
        sessionKey,
        finalizerModel: hooks?.finalizerModel || opts.finalizerModel || null,
    }, opts);
    writeMarker(paths.afterburnedDir, candidate.sessionId, 'done', {
        finalizationStatus: result.status,
        transcriptHash: view.transcriptHash,
    });
    return {
        status: 'afterburned',
        sessionId: candidate.sessionId,
        finalization: result,
        reviewText: result.reviewText || result.humanReviewText || '',
        humanReviewText: result.humanReviewText || '',
        sessionStartText: result.sessionStartText || '',
    };
}

async function readFinalization(aquifer, input = {}) {
    if (!aquifer || !aquifer.finalization || typeof aquifer.finalization.get !== 'function') return null;
    if (!input.transcriptHash) return null;
    try {
        return await aquifer.finalization.get(input);
    } catch {
        return null;
    }
}

function isRecoverySuppressed(finalization, opts = {}) {
    if (!finalization) return false;
    if (finalization.status === 'deferred' && opts.includeDeferredRecovery) return false;
    return ['finalized', 'skipped', 'declined', 'deferred'].includes(finalization.status);
}

async function markFinalizationSkipped(aquifer, candidate = {}, opts = {}) {
    const transcriptHash = candidate.transcriptHash || candidate.metadata?.transcriptHash || candidate.metadata?.transcript_hash || null;
    if (!aquifer || !aquifer.finalization || !transcriptHash) return null;
    const input = {
        sessionId: candidate.sessionId,
        agentId: opts.agentId || candidate.agentId || candidate.metadata?.agentId || 'main',
        source: opts.source || candidate.source || candidate.metadata?.source || 'codex',
        transcriptHash,
        phase: opts.phase || candidate.phase || 'curated_memory_v1',
        status: 'skipped',
        error: opts.reason || 'skipped',
        metadata: {
            reason: opts.reason || 'skipped',
            skippedAt: new Date().toISOString(),
            ...(opts.metadata || {}),
        },
    };
    try {
        if (typeof aquifer.finalization.updateStatus === 'function') {
            const updated = await aquifer.finalization.updateStatus(input);
            if (updated) return updated;
        }
        if (typeof aquifer.finalization.createTask === 'function') {
            return await aquifer.finalization.createTask({
                ...input,
                mode: opts.mode || 'session_start_recovery',
            });
        }
    } catch {
        return null;
    }
    return null;
}

async function findRecoveryCandidates(aquifer, opts = {}) {
    const paths = defaultPaths(opts);
    const {
        agentId = 'main',
        source = 'codex',
        sessionKey = null,
        maxRecoveryCandidates = 3,
        includeJsonlPreviews = false,
    } = opts;
    const provenance = {
        source,
        agentId,
        sessionKey,
        workspace: opts.workspace || opts.workspacePath || null,
        project: opts.project || opts.projectKey || null,
        repoPath: opts.repoPath || null,
    };
    if (!Number.isFinite(maxRecoveryCandidates) || maxRecoveryCandidates <= 0) return [];
    ensureDirs(paths.importedDir, paths.afterburnedDir, paths.claimDir, paths.decisionDir);

    const candidates = [];
    const seenFiles = new Set();

    for (const marker of listMarkerEntries(paths.importedDir)) {
        const metadata = marker.metadata || {};
        if (!matchesRecoveryProvenance(metadata, opts, { source, agentId })) continue;
        const transcriptHash = metadata.transcriptHash || metadata.transcript_hash || null;
        const sessionId = marker.sessionId;
        if (shouldExcludeCandidate({ sessionId, fileSessionId: metadata.fileSessionId }, opts)) continue;
        if (isClaimActive(paths.claimDir, sessionId, opts.claimTtlMs)) continue;
        if (marker.content.includes('skip:')) continue;

        const finalization = await readFinalization(aquifer, {
            sessionId,
            agentId: metadata.agentId || agentId,
            source: metadata.source || source,
            transcriptHash,
        });
        if (isRecoverySuppressed(finalization, opts)) continue;

        const filePath = metadata.filePath || null;
        if (!filePath) continue;
        const candidatePreview = {
            sessionId,
            fileSessionId: metadata.fileSessionId || null,
            filePath,
            transcriptHash,
            phase: opts.phase || 'curated_memory_v1',
            metadata,
        };
        const localDecision = readRecoveryDecision(paths, candidatePreview);
        if (!finalization && isRecoverySuppressed(localDecision, opts)) continue;

        if (filePath) seenFiles.add(path.resolve(filePath));
        candidates.push({
            ...candidatePreview,
            origin: 'imported_marker',
            status: 'needs_consent',
            source: metadata.source || source,
            agentId: metadata.agentId || agentId,
            sessionKey: metadata.sessionKey || null,
            userCount: metadata.userCount || null,
            messageCount: metadata.messageCount || null,
            finalizationStatus: finalization ? finalization.status : null,
            recoveryDecisionStatus: localDecision ? localDecision.status : null,
            markerPath: marker.markerPath,
            updatedAt: marker.stat.mtime,
        });
        if (candidates.length >= maxRecoveryCandidates) return candidates;
    }

    if (!includeJsonlPreviews) return candidates;

    const minBytes = opts.minSessionBytes ?? DEFAULT_MIN_BYTES;
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    let files = walkJsonlFiles(paths.sessionsDir)
        .filter((entry) => !shouldExcludeFile(entry, opts))
        .filter((entry) => !seenFiles.has(path.resolve(entry.path)))
        .filter((entry) => entry.stat.size >= minBytes)
        .filter((entry) => isIdleEnough(entry, idleMs, opts.now))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (opts.excludeNewest && files.length > 0) files = files.slice(1);

    for (const entry of files) {
        const fileSessionId = entry.fileSessionId;
        let safeFileSessionId;
        try {
            safeFileSessionId = assertSafeSessionId(fileSessionId, 'fileSessionId');
        } catch {
            continue;
        }
        if (shouldExcludeCandidate({ sessionId: safeFileSessionId, fileSessionId: safeFileSessionId }, opts)) continue;
        if (isClaimActive(paths.claimDir, safeFileSessionId, opts.claimTtlMs)) continue;
        const candidatePreview = {
            origin: 'jsonl_preview',
            status: 'needs_consent',
            sessionId: safeFileSessionId,
            fileSessionId: safeFileSessionId,
            filePath: entry.path,
            transcriptHash: null,
            source,
            agentId,
            sessionKey,
            userCount: null,
            messageCount: null,
            finalizationStatus: null,
            updatedAt: entry.stat.mtime,
            size: entry.stat.size,
            metadata: {
                filePath: entry.path,
                fileSessionId: safeFileSessionId,
                size: entry.stat.size,
                mtimeMs: entry.stat.mtimeMs,
                ...provenance,
            },
        };
        const localDecision = readRecoveryDecision(paths, candidatePreview);
        if (isRecoverySuppressed(localDecision, opts)) continue;
        candidates.push({
            ...candidatePreview,
            recoveryDecisionStatus: localDecision ? localDecision.status : null,
        });
        if (candidates.length >= maxRecoveryCandidates) break;
    }
    return candidates;
}

function dbEligibilityFromRecoveryView(view = {}, opts = {}) {
    if (!view || view.status !== 'ok') {
        return { eligible: false, status: view?.status || 'unavailable', reason: view?.reason || null };
    }
    const minUserMessages = opts.minUserMessages ?? opts.minImportUserMessages ?? DEFAULT_MIN_IMPORT_USER_MESSAGES;
    const userCount = Number(view.counts?.userCount || 0);
    if (userCount < minUserMessages) {
        return {
            eligible: false,
            status: 'skipped_short',
            reason: `user_count=${userCount} < min=${minUserMessages}`,
            userCount,
        };
    }
    return { eligible: true, status: 'eligible', userCount };
}

function candidateFromRecoveryView(candidate = {}, view = {}) {
    return {
        ...candidate,
        sessionId: view.sessionId || candidate.sessionId,
        fileSessionId: view.fileSessionId || candidate.fileSessionId,
        filePath: view.filePath || candidate.filePath,
        transcriptHash: view.transcriptHash || candidate.transcriptHash || null,
        userCount: view.counts?.userCount ?? candidate.userCount ?? null,
        messageCount: view.counts?.messageCount ?? candidate.messageCount ?? null,
        safeMessageCount: view.counts?.safeMessageCount ?? null,
        assistantCount: view.counts?.assistantCount ?? null,
        charCount: view.charCount ?? null,
        approxPromptTokens: view.approxPromptTokens ?? null,
        metadata: {
            ...(candidate.metadata || {}),
            filePath: view.filePath || candidate.filePath || candidate.metadata?.filePath || null,
            fileSessionId: view.fileSessionId || candidate.fileSessionId || candidate.metadata?.fileSessionId || null,
            transcriptHash: view.transcriptHash || candidate.transcriptHash || candidate.metadata?.transcriptHash || null,
            dbRecoveryEligible: true,
        },
    };
}

async function findDbEligibleRecoveryCandidates(aquifer, opts = {}) {
    const paths = defaultPaths(opts);
    const maxEligible = Number.isFinite(opts.maxRecoveryCandidates) && opts.maxRecoveryCandidates > 0
        ? opts.maxRecoveryCandidates
        : 3;
    const rawScanLimit = Number.isFinite(opts.maxRecoveryCandidateScan) && opts.maxRecoveryCandidateScan > 0
        ? opts.maxRecoveryCandidateScan
        : Math.max(maxEligible * 5, maxEligible);
    const rawCandidates = await findRecoveryCandidates(aquifer, {
        ...opts,
        maxRecoveryCandidates: rawScanLimit,
    });
    const eligible = [];

    for (const candidate of rawCandidates) {
        let view;
        try {
            view = materializeRecoveryTranscriptView(candidate, opts);
        } catch {
            continue;
        }
        const eligibility = dbEligibilityFromRecoveryView(view, opts);
        if (!eligibility.eligible) continue;

        const enriched = candidateFromRecoveryView(candidate, view);
        const finalization = await readFinalization(aquifer, {
            sessionId: enriched.sessionId,
            agentId: opts.agentId || enriched.agentId || 'main',
            source: opts.source || enriched.source || 'codex',
            transcriptHash: enriched.transcriptHash,
            phase: opts.phase || enriched.phase || 'curated_memory_v1',
        });
        if (isRecoverySuppressed(finalization, opts)) continue;

        const canonicalDecision = readRecoveryDecision(paths, enriched);
        if (isRecoverySuppressed(canonicalDecision, opts)) continue;

        eligible.push({
            ...enriched,
            status: 'needs_consent',
            eligibilityStatus: eligibility.status,
            finalizationStatus: finalization ? finalization.status : enriched.finalizationStatus || null,
            recoveryDecisionStatus: canonicalDecision ? canonicalDecision.status : enriched.recoveryDecisionStatus || null,
        });
        if (eligible.length >= maxEligible) break;
    }

    return eligible;
}

function formatRecoveryTranscript(messages = []) {
    return messages
        .map((message) => {
            const role = message.role || 'unknown';
            const timestamp = message.timestamp ? ` ${message.timestamp}` : '';
            const content = String(message.content || '').trim();
            return `[${role}${timestamp}]\n${content}`;
        })
        .filter(Boolean)
        .join('\n\n');
}

function approxPromptTokens(text) {
    return Math.ceil(String(text || '').length / 3);
}

function materializeRecoveryTranscriptView(candidate = {}, opts = {}) {
    const filePath = candidate.filePath || candidate.metadata?.filePath;
    if (!filePath) {
        return { status: 'missing_file_path', sessionId: candidate.sessionId || null };
    }
    if (shouldExcludeFile({ path: filePath }, opts)) {
        return { status: 'excluded', sessionId: candidate.sessionId || null, filePath };
    }

    const maxBytes = opts.maxRecoveryBytes ?? DEFAULT_RECOVERY_MAX_BYTES;
    const maxMessages = opts.maxRecoveryMessages ?? DEFAULT_RECOVERY_MAX_MESSAGES;
    const maxChars = opts.maxRecoveryChars ?? DEFAULT_RECOVERY_MAX_CHARS;
    const maxPromptTokens = opts.maxRecoveryPromptTokens ?? DEFAULT_RECOVERY_MAX_PROMPT_TOKENS;

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return { status: 'not_found', sessionId: candidate.sessionId || null, filePath };
    }
    if (Number.isFinite(maxBytes) && maxBytes > 0 && stat.size > maxBytes) {
        return { status: 'deferred', reason: 'max_bytes', sessionId: candidate.sessionId || null, filePath, size: stat.size };
    }

    const parsed = parseCodexSessionFile(filePath);
    if (shouldExcludeCandidate(parsed, opts)) {
        return { status: 'excluded', sessionId: parsed.sessionId, filePath };
    }

    const transcriptHash = parsed.normalized.transcriptHash;
    if (candidate.transcriptHash && candidate.transcriptHash !== transcriptHash) {
        return {
            status: 'hash_mismatch',
            sessionId: parsed.sessionId,
            filePath,
            expectedTranscriptHash: candidate.transcriptHash,
            transcriptHash,
        };
    }

    const safety = applyEnrichSafetyGate(parsed.normalized.messages);
    const safeMessages = safety.messages;
    if (safeMessages.length === 0) {
        return {
            status: 'skipped_empty',
            sessionId: parsed.sessionId,
            fileSessionId: parsed.fileSessionId,
            filePath,
            transcriptHash,
            safetyGate: safety.meta,
        };
    }
    if (Number.isFinite(maxMessages) && maxMessages > 0 && safeMessages.length > maxMessages) {
        return {
            status: 'deferred',
            reason: 'max_messages',
            sessionId: parsed.sessionId,
            fileSessionId: parsed.fileSessionId,
            filePath,
            transcriptHash,
            messageCount: safeMessages.length,
            safetyGate: safety.meta,
        };
    }

    const text = formatRecoveryTranscript(safeMessages);
    const promptTokens = approxPromptTokens(text);
    if ((Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars)
        || (Number.isFinite(maxPromptTokens) && maxPromptTokens > 0 && promptTokens > maxPromptTokens)) {
        return {
            status: 'deferred',
            reason: 'prompt_budget',
            sessionId: parsed.sessionId,
            fileSessionId: parsed.fileSessionId,
            filePath,
            transcriptHash,
            charCount: text.length,
            approxPromptTokens: promptTokens,
            safetyGate: safety.meta,
        };
    }

    return {
        status: 'ok',
        sessionId: parsed.sessionId,
        fileSessionId: parsed.fileSessionId,
        filePath,
        transcriptHash,
        messages: safeMessages,
        text,
        charCount: text.length,
        approxPromptTokens: promptTokens,
        safetyGate: safety.meta,
        counts: {
            messageCount: parsed.normalized.messages.length,
            safeMessageCount: safeMessages.length,
            userCount: parsed.normalized.userCount,
            assistantCount: parsed.normalized.assistantCount,
        },
        metadata: {
            model: parsed.normalized.model,
            startedAt: parsed.normalized.startedAt,
            lastMessageAt: parsed.normalized.lastMessageAt,
            skipStats: parsed.normalized.skipStats,
            boundaries: parsed.normalized.boundaries,
            toolsUsed: parsed.normalized.toolsUsed,
        },
    };
}

function compactCurrentMemoryRow(row = {}) {
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const confidence = payload.confidence || payload.currentMemoryConfidence || null;
    return {
        memoryType: row.memoryType || row.memory_type || 'memory',
        canonicalKey: row.canonicalKey || row.canonical_key || null,
        scopeKey: row.scopeKey || row.scope_key || null,
        summary: String(row.summary || row.title || '').replace(/\s+/g, ' ').trim(),
        authority: row.authority || null,
        confidence,
    };
}

function formatCurrentMemoryPromptBlock(currentMemory = null, opts = {}) {
    const maxItems = Math.max(0, Math.min(20, opts.maxCurrentMemoryItems || opts.currentMemoryLimit || 12));
    const meta = currentMemory && currentMemory.meta ? currentMemory.meta : {};
    const rows = Array.isArray(currentMemory?.memories)
        ? currentMemory.memories
        : (Array.isArray(currentMemory?.items) ? currentMemory.items : []);
    const compactRows = rows.map(compactCurrentMemoryRow).filter(row => row.summary).slice(0, maxItems);
    const attrs = [
        `source="${meta.source || 'memory_records'}"`,
        `serving_contract="${meta.servingContract || meta.serving_contract || 'current_memory_v1'}"`,
        `count="${compactRows.length}"`,
        `truncated="${Boolean(meta.truncated || rows.length > compactRows.length)}"`,
        `degraded="${Boolean(meta.degraded || currentMemory?.error)}"`,
    ];
    const lines = compactRows.map(row => {
        const scope = row.scopeKey ? ` scope=${row.scopeKey}` : '';
        const authority = row.authority ? ` authority=${row.authority}` : '';
        const confidence = row.confidence ? ` confidence=${row.confidence}` : '';
        return `- ${row.memoryType}${scope}${authority}${confidence}: ${row.summary}`;
    });
    if (currentMemory && currentMemory.error && lines.length === 0) {
        lines.push(`- degraded: ${String(currentMemory.error).replace(/\s+/g, ' ').trim()}`);
    }
    if (lines.length === 0) lines.push('- none');
    return [
        `<current_memory ${attrs.join(' ')}>`,
        ...lines,
        '</current_memory>',
    ].join('\n');
}

function compactCurrentMemorySnapshot(currentMemory = null, opts = {}) {
    const maxItems = Math.max(0, Math.min(20, opts.maxCurrentMemoryItems || opts.currentMemoryLimit || 12));
    const meta = currentMemory && currentMemory.meta ? currentMemory.meta : {};
    const rows = Array.isArray(currentMemory?.memories)
        ? currentMemory.memories
        : (Array.isArray(currentMemory?.items) ? currentMemory.items : []);
    return {
        memories: rows.map(compactCurrentMemoryRow).filter(row => row.summary).slice(0, maxItems),
        meta: {
            source: meta.source || 'memory_records',
            servingContract: meta.servingContract || meta.serving_contract || 'current_memory_v1',
            count: Math.min(rows.length, maxItems),
            truncated: Boolean(meta.truncated || rows.length > maxItems),
            degraded: Boolean(meta.degraded || currentMemory?.error),
        },
    };
}

async function resolveCurrentMemoryForFinalization(aquifer, opts = {}) {
    if (opts.includeCurrentMemory === false) return null;
    if (opts.currentMemory !== undefined) return opts.currentMemory;
    const currentFn = aquifer?.memory?.current || aquifer?.memory?.listCurrentMemory;
    if (typeof currentFn !== 'function') return null;
    const limit = Math.max(1, Math.min(20, opts.currentMemoryLimit || opts.maxCurrentMemoryItems || 12));
    try {
        return await currentFn.call(aquifer.memory, {
            tenantId: opts.tenantId,
            activeScopeKey: opts.activeScopeKey || opts.scopeKey,
            activeScopePath: opts.activeScopePath,
            scopeId: opts.scopeId,
            asOf: opts.asOf,
            limit,
        });
    } catch (err) {
        return {
            memories: [],
            meta: {
                source: 'memory_records',
                servingContract: 'current_memory_v1',
                count: 0,
                truncated: false,
                degraded: true,
            },
            error: err.message,
        };
    }
}

function buildFinalizationPrompt(view = {}, opts = {}) {
    if (!view || view.status !== 'ok') {
        throw new Error('buildFinalizationPrompt requires an ok transcript view');
    }
    const maxFacts = opts.maxFacts || 8;
    const includeCurrentMemory = opts.includeCurrentMemory !== false;
    const lines = [
        'You are finalizing an Aquifer memory session for Codex.',
        'Use only the sanitized transcript below. Do not infer from hidden tool output or injected context.',
        'Return compact JSON with this shape:',
        '{"summaryText":"...","structuredSummary":{"facts":[],"decisions":[],"open_loops":[],"preferences":[],"constraints":[],"conclusions":[],"entity_notes":[],"states":[]}}',
        `Keep facts/decisions/open_loops concrete and scoped. Use at most ${maxFacts} facts.`,
        '',
        `sessionId: ${view.sessionId}`,
        `transcriptHash: ${view.transcriptHash}`,
        `approxPromptTokens: ${view.approxPromptTokens}`,
        '',
        '<sanitized_transcript>',
        view.text || '',
        '</sanitized_transcript>',
    ];
    if (includeCurrentMemory) {
        lines.splice(
            2,
            0,
            'Use current_memory as the already-committed current state. Reconcile the transcript against it: keep valid state, supersede stale state, and mark uncertain items explicitly.',
        );
        lines.splice(10, 0, formatCurrentMemoryPromptBlock(opts.currentMemory, opts), '');
    }
    return lines.join('\n');
}

function normalizeFinalizationSummary(summary = {}) {
    const input = summary && typeof summary === 'object' ? summary : {};
    const summaryText = String(input.summaryText || input.summary || '').trim();
    const structuredSummary = input.structuredSummary || {};
    if (!summaryText && (!structuredSummary || Object.keys(structuredSummary).length === 0)) {
        throw new Error('summaryText or structuredSummary is required for finalization');
    }
    return { summaryText, structuredSummary };
}

async function ensureCommittedForFinalization(aquifer, view = {}, opts = {}) {
    const {
        agentId = 'main',
        source = 'codex',
        sessionKey = 'codex:cli',
    } = opts;
    const existing = await getExistingSession(aquifer, view.sessionId, agentId, { source });
    if (committedSnapshotMatchesView(existing, view)) {
        return { status: 'already_committed', session: existing };
    }

    if (!aquifer || typeof aquifer.commit !== 'function') {
        throw new Error('aquifer.commit is required to finalize an uncommitted or stale Codex session');
    }

    await aquifer.commit(view.sessionId, view.messages, {
        rawMessages: {
            normalized: view.messages,
            metadata: {
                transcript_hash: view.transcriptHash,
                recovery_finalization: true,
                safetyGate: view.safetyGate || {},
                sourceMetadata: view.metadata || {},
            },
        },
        agentId,
        source,
        sessionKey,
        model: view.metadata?.model || null,
        tokensIn: 0,
        tokensOut: 0,
        startedAt: view.metadata?.startedAt || null,
        lastMessageAt: view.metadata?.lastMessageAt || null,
    });
    return { status: existing ? 'recommitted' : 'committed', previous: existing || null };
}

async function finalizeTranscriptView(aquifer, view = {}, summary = {}, opts = {}) {
    const finalizeSession = aquifer?.finalizeSession
        || aquifer?.finalization?.finalizeSession;
    if (typeof finalizeSession !== 'function') {
        throw new Error('aquifer.finalizeSession or aquifer.finalization.finalizeSession is required');
    }
    if (!view || view.status !== 'ok') {
        throw new Error(`Cannot finalize transcript view with status: ${view && view.status}`);
    }
    const {
        agentId = 'main',
        source = 'codex',
        sessionKey = 'codex:cli',
        mode = 'handoff',
    } = opts;
    const finalSummary = normalizeFinalizationSummary(summary);
    const commitResult = await ensureCommittedForFinalization(aquifer, view, {
        agentId,
        source,
        sessionKey,
    });
    const metadata = {
        filePath: view.filePath || null,
        fileSessionId: view.fileSessionId || null,
        source: opts.metadataSource || 'codex_consumer',
        sessionKey,
        charCount: view.charCount || null,
        approxPromptTokens: view.approxPromptTokens || null,
        safetyGate: view.safetyGate || {},
        trigger: mode,
        ...(opts.metadata || {}),
    };
    if (!metadata.currentMemory) {
        const currentMemory = await resolveCurrentMemoryForFinalization(aquifer, opts);
        if (currentMemory) metadata.currentMemory = compactCurrentMemorySnapshot(currentMemory, opts);
    }
    const result = await finalizeSession({
        sessionId: view.sessionId,
        agentId,
        source,
        host: 'codex',
        transcriptHash: view.transcriptHash,
        mode,
        summaryText: finalSummary.summaryText,
        structuredSummary: finalSummary.structuredSummary,
        finalizerModel: opts.finalizerModel || opts.model || view.metadata?.model || null,
        msgCount: view.counts?.safeMessageCount || view.messages.length,
        userCount: view.counts?.userCount || view.messages.filter(m => m.role === 'user').length,
        assistantCount: view.counts?.assistantCount || view.messages.filter(m => m.role === 'assistant').length,
        startedAt: view.metadata?.startedAt || null,
        endedAt: view.metadata?.lastMessageAt || null,
        embedding: opts.embedding || null,
        scopeKind: opts.scopeKind || null,
        scopeKey: opts.scopeKey || null,
        contextKey: opts.contextKey || null,
        topicKey: opts.topicKey || null,
        authority: opts.authority || 'verified_summary',
        metadata,
    });
    const humanReviewText = result.humanReviewText || '';
    const sessionStartText = result.sessionStartText || '';
    return {
        status: result.status || 'finalized',
        commit: commitResult,
        finalization: result,
        sessionId: view.sessionId,
        transcriptHash: view.transcriptHash,
        summary: result.summary || null,
        memoryResult: result.memoryResult || {},
        memoryResults: result.memoryResults || [],
        reviewText: humanReviewText,
        humanReviewText,
        sessionStartText,
    };
}

async function recordRecoveryDecision(aquifer, candidate = {}, status, opts = {}) {
    if (!RECOVERY_DECISIONS.has(status)) throw new Error(`Invalid recovery decision: ${status}`);
    const paths = defaultPaths(opts);
    ensureDirs(paths.decisionDir);
    const metadata = {
        reason: opts.reason || null,
        source: opts.source || candidate.source || 'codex',
        agentId: opts.agentId || candidate.agentId || 'main',
        decidedAt: new Date().toISOString(),
    };
    writeRecoveryDecision(paths, candidate, status, metadata);

    const transcriptHash = candidate.transcriptHash || candidate.metadata?.transcriptHash || null;
    if (aquifer && aquifer.finalization && transcriptHash) {
        const finalizationInput = {
            sessionId: candidate.sessionId,
            agentId: opts.agentId || candidate.agentId || 'main',
            source: opts.source || candidate.source || 'codex',
            transcriptHash,
            phase: opts.phase || candidate.phase || 'curated_memory_v1',
            status,
            error: opts.reason || null,
            metadata,
        };
        try {
            if (typeof aquifer.finalization.updateStatus === 'function') {
                const updated = await aquifer.finalization.updateStatus(finalizationInput);
                if (updated) return { status, persisted: 'db', finalization: updated };
            }
            if (typeof aquifer.finalization.createTask === 'function') {
                const created = await aquifer.finalization.createTask({
                    ...finalizationInput,
                    mode: opts.mode || 'session_start_recovery',
                });
                return { status, persisted: 'db', finalization: created };
            }
        } catch {
            // Local decision marker still prevents repeated prompts. DB may be
            // unavailable or the session may not be committed yet.
        }
    }
    return { status, persisted: 'local' };
}

async function prepareSessionStartRecovery(aquifer, opts = {}) {
    const recoveryOpts = {
        ...opts,
        excludeNewest: opts.excludeNewest !== undefined ? opts.excludeNewest : true,
    };
    const candidates = await findRecoveryCandidates(aquifer, recoveryOpts);
    if (candidates.length === 0) return { status: 'none', candidates: [] };
    if (opts.consent !== true) return { status: 'needs_consent', candidates };

    const candidate = opts.candidate || candidates[0];
    const view = materializeRecoveryTranscriptView(candidate, recoveryOpts);
    if (view.status !== 'ok') {
        return { status: view.status, candidate, view };
    }
    const minUserMessages = opts.minUserMessages ?? opts.minImportUserMessages ?? DEFAULT_MIN_IMPORT_USER_MESSAGES;
    const userCount = Number(view.counts?.userCount || 0);
    if (userCount < minUserMessages) {
        const skippedCandidate = {
            ...candidate,
            sessionId: view.sessionId || candidate.sessionId,
            fileSessionId: view.fileSessionId || candidate.fileSessionId,
            filePath: view.filePath || candidate.filePath,
            transcriptHash: view.transcriptHash,
            metadata: {
                ...(candidate.metadata || {}),
                filePath: view.filePath || candidate.filePath,
                fileSessionId: view.fileSessionId || candidate.fileSessionId,
                transcriptHash: view.transcriptHash,
            },
        };
        await recordRecoveryDecision(aquifer, skippedCandidate, 'skipped', {
            ...recoveryOpts,
            reason: `user_count=${userCount} < min=${minUserMessages}`,
            mode: 'session_start_recovery',
        });
        if (candidate.origin === 'jsonl_preview') {
            writeRecoveryDecision(defaultPaths(recoveryOpts), candidate, 'skipped', {
                reason: `user_count=${userCount} < min=${minUserMessages}`,
                source: recoveryOpts.source || candidate.source || 'codex',
                agentId: recoveryOpts.agentId || candidate.agentId || 'main',
            });
        }
        return { status: 'skipped_short', candidate: skippedCandidate, view, userCount };
    }
    const currentMemory = await resolveCurrentMemoryForFinalization(aquifer, recoveryOpts);
    return {
        status: 'needs_agent_summary',
        candidate,
        view,
        currentMemory,
        prompt: buildFinalizationPrompt(view, { ...recoveryOpts, currentMemory }),
    };
}

async function finalizeCodexSession(aquifer, input = {}, opts = {}) {
    let view = input.view || null;
    const mode = input.mode || opts.mode || 'handoff';
    if (!view) {
        const candidate = input.candidate || {
            filePath: input.filePath,
            transcriptHash: input.transcriptHash || null,
            sessionId: input.sessionId || null,
            metadata: input.metadata || {},
        };
        view = materializeRecoveryTranscriptView(candidate, opts);
    }
    if (view.status !== 'ok') {
        return { status: view.status, view };
    }
    const summary = input.summary || {
        summaryText: input.summaryText,
        structuredSummary: input.structuredSummary,
    };
    return finalizeTranscriptView(aquifer, view, summary, {
        ...opts,
        mode,
        agentId: input.agentId || opts.agentId || 'main',
        source: input.source || opts.source || 'codex',
        sessionKey: input.sessionKey || opts.sessionKey || 'codex:cli',
        finalizerModel: input.finalizerModel || opts.finalizerModel || null,
        scopeKind: input.scopeKind || opts.scopeKind || null,
        scopeKey: input.scopeKey || opts.scopeKey || null,
        contextKey: input.contextKey || opts.contextKey || null,
        topicKey: input.topicKey || opts.topicKey || null,
        activeScopeKey: input.activeScopeKey || opts.activeScopeKey || input.scopeKey || opts.scopeKey || null,
        activeScopePath: input.activeScopePath || opts.activeScopePath || null,
        currentMemory: input.currentMemory !== undefined ? input.currentMemory : opts.currentMemory,
        currentMemoryLimit: input.currentMemoryLimit || opts.currentMemoryLimit || null,
        includeCurrentMemory: input.includeCurrentMemory !== undefined ? input.includeCurrentMemory : opts.includeCurrentMemory,
    });
}

async function runSync(aquifer, opts = {}) {
    if (!aquifer) throw new Error('aquifer is required');
    const paths = defaultPaths(opts);
    ensureDirs(paths.importedDir, paths.afterburnedDir, paths.claimDir);

    const logger = opts.logger || console;
    const results = { imported: [], afterburned: [], skipped: [], failed: [] };
    const importCandidates = await findImportCandidates(aquifer, opts);

    for (const candidate of importCandidates) {
        if (!claimSession(paths.claimDir, candidate.sessionId)) continue;
        try {
            const result = await importCandidate(aquifer, candidate, opts);
            if (result.status === 'imported') results.imported.push(result);
            else results.skipped.push(result);
        } catch (err) {
            results.failed.push({ stage: 'import', sessionId: candidate.sessionId, error: err.message });
            if (logger && logger.warn) logger.warn(`[codex-consumer] import failed for ${candidate.sessionId}: ${err.message}`);
        } finally {
            releaseClaim(paths.claimDir, candidate.sessionId);
        }
    }

    const afterburnCandidates = results.imported.length
        ? results.imported.map((r) => {
            const source = importCandidates.find((c) => c.sessionId === r.sessionId);
            return source || { sessionId: r.sessionId, normalized: r.counts };
        })
        : await findAfterburnCandidates(aquifer, opts);

    const maxAfterburns = opts.maxAfterburns ?? DEFAULT_MAX_AFTERBURNS;
    for (const candidate of afterburnCandidates.slice(0, Math.max(0, maxAfterburns))) {
        if (!claimSession(paths.claimDir, candidate.sessionId)) continue;
        try {
            const result = await afterburnCandidate(aquifer, candidate, opts);
            if (result.status === 'afterburned') results.afterburned.push(result);
            else results.skipped.push(result);
        } catch (err) {
            results.failed.push({ stage: 'afterburn', sessionId: candidate.sessionId, error: err.message });
            if (logger && logger.warn) logger.warn(`[codex-consumer] afterburn failed for ${candidate.sessionId}: ${err.message}`);
        } finally {
            releaseClaim(paths.claimDir, candidate.sessionId);
        }
    }

    return results;
}

module.exports = {
    normalizeCodexEntries,
    parseCodexSessionFile,
    findImportCandidates,
    findAfterburnCandidates,
    findRecoveryCandidates,
    findDbEligibleRecoveryCandidates,
    materializeRecoveryTranscriptView,
    buildFinalizationPrompt,
    prepareSessionStartRecovery,
    recordRecoveryDecision,
    finalizeTranscriptView,
    finalizeCodexSession,
    importCandidate,
    afterburnCandidate,
    runSync,
    // exposed for focused unit tests
    readJsonlEntries,
    isIdleEnough,
    defaultPaths,
    assertSafeSessionId,
    safeMarkerKey,
    markerPath,
    hashNormalizedTranscript,
    readMarkerMetadataFromContent,
    formatCurrentMemoryPromptBlock,
    compactCurrentMemorySnapshot,
    resolveCurrentMemoryForFinalization,
};
