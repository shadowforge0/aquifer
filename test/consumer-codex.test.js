'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codex = require('../consumers/codex');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'aquifer-codex-'));
}

function writeJsonl(filePath, entries) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(filePath, old, old);
}

function encodeMarkerValue(value) {
    return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function writeImportedMarker(dir, sessionId, metadata = {}, label = '') {
    fs.mkdirSync(dir, { recursive: true });
    const suffix = label ? ` ${label}` : '';
    const lines = [
        `${new Date().toISOString()}${suffix}`,
        `session:${encodeMarkerValue(sessionId)}`,
        `metadata:${encodeMarkerValue(JSON.stringify(metadata))}`,
    ];
    fs.writeFileSync(codex.markerPath(dir, sessionId), `${lines.join('\n')}\n`, 'utf8');
}

function sessionMeta(id = 'meta-1') {
    return { type: 'session_meta', timestamp: '2026-04-24T00:00:00.000Z', payload: { id, timestamp: '2026-04-24T00:00:00.000Z' } };
}

function user(text, ts = '2026-04-24T00:00:01.000Z') {
    return { type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: text } };
}

function assistant(text, ts = '2026-04-24T00:00:02.000Z', extra = {}) {
    return {
        type: 'response_item',
        timestamp: ts,
        payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
            ...extra,
        },
    };
}

function token(input = 10, output = 5) {
    return {
        type: 'event_msg',
        timestamp: '2026-04-24T00:00:03.000Z',
        payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: input, output_tokens: output } },
        },
    };
}

function makeFinalizationSummary(summaryText = 'Codex afterburn finalized through core.') {
    return async () => ({
        summaryText,
        structuredSummary: {
            facts: [{ subject: 'Codex', statement: summaryText }],
        },
    });
}

function makeFakeAquifer(existing = {}, fakeOpts = {}) {
    const calls = { commit: [], enrich: [], skip: [], finalization: [] };
    const sessions = new Map(Object.entries(existing));
    const finalizations = new Map();
    const finalizationKey = input => [
        input.source || 'codex',
        input.agentId || 'main',
        input.sessionId,
        input.transcriptHash,
        input.phase || 'curated_memory_v1',
    ].join('|');
    const aq = {
        calls,
        async getSession(sessionId) {
            return sessions.get(sessionId) || null;
        },
        async commit(sessionId, messages, opts) {
            calls.commit.push({ sessionId, messages, opts });
            sessions.set(sessionId, {
                session_id: sessionId,
                processing_status: 'pending',
                msg_count: messages.length,
                user_count: messages.filter((m) => m.role === 'user').length,
                assistant_count: messages.filter((m) => m.role === 'assistant').length,
            });
        },
        async enrich(sessionId, opts) {
            calls.enrich.push({ sessionId, opts });
            const row = sessions.get(sessionId);
            if (row) row.processing_status = 'succeeded';
            return fakeOpts.enrichResult || { turnsEmbedded: 2, entitiesFound: 1, postProcessError: null };
        },
        async skip(sessionId, opts) {
            calls.skip.push({ sessionId, opts });
            const row = sessions.get(sessionId);
            if (row) {
                row.processing_status = 'skipped';
                row.processing_error = opts.reason;
            }
            return { sessionId, status: 'skipped' };
        },
        finalization: {
            async get(input) {
                calls.finalization.push({ method: 'get', input });
                return finalizations.get(finalizationKey(input)) || null;
            },
            async createTask(input) {
                calls.finalization.push({ method: 'createTask', input });
                const row = { ...input, status: input.status || 'pending' };
                finalizations.set(finalizationKey(input), row);
                return row;
            },
            async updateStatus(input) {
                calls.finalization.push({ method: 'updateStatus', input });
                const key = finalizationKey(input);
                const row = finalizations.get(key);
                if (!row) return null;
                const next = { ...row, ...input };
                finalizations.set(key, next);
                return next;
            },
            async finalizeSession(input) {
                calls.finalization.push({ method: 'finalizeSession', input });
                const row = { ...input, status: 'finalized' };
                finalizations.set(finalizationKey(input), row);
                const session = sessions.get(input.sessionId);
                if (session) session.processing_status = 'succeeded';
                if (typeof fakeOpts.finalizeResult === 'function') {
                    return fakeOpts.finalizeResult(input, row);
                }
                if (fakeOpts.finalizeResult) {
                    return { status: 'finalized', finalization: row, ...fakeOpts.finalizeResult };
                }
                return { status: 'finalized', finalization: row, memoryResult: { promoted: 1 } };
            },
        },
    };
    const finalizeSession = aq.finalization.finalizeSession.bind(aq.finalization);
    aq.finalizeSession = finalizeSession;
    return aq;
}

describe('Codex consumer normalize/parse', () => {
    it('uses session_meta.id as canonical session id and extracts messages/tokens', () => {
        const dir = tmpDir();
        const file = path.join(dir, 'rollout-file-name.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-id'),
            { type: 'turn_context', payload: { model: 'gpt-5.4' } },
            user('hello'),
            assistant('world'),
            token(12, 7),
        ]);

        const parsed = codex.parseCodexSessionFile(file);
        assert.equal(parsed.fileSessionId, 'rollout-file-name');
        assert.equal(parsed.sessionId, 'meta-id');
        assert.equal(parsed.normalized.userCount, 1);
        assert.equal(parsed.normalized.assistantCount, 1);
        assert.equal(parsed.normalized.tokensIn, 12);
        assert.equal(parsed.normalized.tokensOut, 7);
        assert.equal(parsed.normalized.model, 'gpt-5.4');
        assert.match(parsed.normalized.transcriptHash, /^[a-f0-9]{64}$/);
    });

    it('routes Codex entries through shared normalize and drops commentary narration before tool calls', () => {
        const normalized = codex.normalizeCodexEntries([
            sessionMeta('meta-phases'),
            user('請處理這件事'),
            assistant('我先查檔案狀態', '2026-04-24T00:00:02.000Z', { phase: 'commentary' }),
            { type: 'response_item', timestamp: '2026-04-24T00:00:02.500Z', payload: { type: 'function_call', name: 'exec_command' } },
            assistant('已完成修復，測試通過。', '2026-04-24T00:00:03.000Z', { phase: 'final_answer' }),
        ]);

        assert.equal(normalized.assistantCount, 1);
        assert.equal(normalized.messages.length, 2);
        assert.equal(normalized.messages[1].content, '已完成修復，測試通過。');
        assert.equal(normalized.skipStats.narration, 1);
        assert.deepEqual(normalized.toolsUsed, ['exec_command']);
    });

    it('rejects unsafe session ids before they can become DB or marker identity', () => {
        assert.throws(
            () => codex.normalizeCodexEntries([sessionMeta('../evil')]),
            /Invalid session_meta\.id/,
        );
        assert.throws(
            () => codex.markerPath(tmpDir(), '../evil'),
            /Invalid sessionId/,
        );
    });

    it('uses digest marker paths instead of raw session ids', () => {
        const dir = tmpDir();
        const marker = codex.markerPath(dir, 'meta-abc');
        assert.equal(path.dirname(marker), dir);
        assert.notEqual(path.basename(marker), 'meta-abc');
        assert.match(path.basename(marker), /^[a-f0-9]{32}$/);
    });

    it('computes stable transcript hashes from normalized messages', () => {
        const entries = [
            sessionMeta('meta-hash'),
            user('hello'),
            assistant('world'),
        ];
        const first = codex.normalizeCodexEntries(entries);
        const second = codex.normalizeCodexEntries(entries);
        assert.equal(first.transcriptHash, second.transcriptHash);
        assert.equal(first.transcriptHash, codex.hashNormalizedTranscript(first));
    });
});

describe('Codex consumer recovery helpers', () => {
    it('returns metadata-only recovery candidates without reading missing JSONL files', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const file = path.join(sessionsDir, 'rollout-recovery.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-recovery'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const aq = makeFakeAquifer();
        await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 0,
            logger: { warn() {} },
        });
        fs.unlinkSync(file);

        const candidates = await codex.findRecoveryCandidates(aq, {
            sessionsDir,
            stateDir,
            maxRecoveryCandidates: 5,
        });

        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].sessionId, 'meta-recovery');
        assert.equal(candidates[0].origin, 'imported_marker');
        assert.equal(candidates[0].filePath, file);
        assert.match(candidates[0].transcriptHash, /^[a-f0-9]{64}$/);
    });

    it('can preview JSONL files by stat metadata only before consent', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const file = path.join(sessionsDir, 'rollout-preview.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{"type":"session_meta","payload":{"id":"../evil"}}\n', 'utf8');
        const old = new Date(Date.now() - 10 * 60 * 1000);
        fs.utimesSync(file, old, old);

        const candidates = await codex.findRecoveryCandidates(makeFakeAquifer(), {
            sessionsDir,
            stateDir,
            includeJsonlPreviews: true,
            minSessionBytes: 1,
            idleMs: 1,
        });

        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].origin, 'jsonl_preview');
        assert.equal(candidates[0].sessionId, 'rollout-preview');
        assert.equal(candidates[0].transcriptHash, null);
    });

    it('filters JSONL previews to DB-eligible recovery candidates before prompting', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const eligibleFile = path.join(sessionsDir, 'rollout-eligible.jsonl');
        const shortFile = path.join(sessionsDir, 'rollout-short.jsonl');
        writeJsonl(eligibleFile, [
            sessionMeta('meta-eligible'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        writeJsonl(shortFile, [
            sessionMeta('meta-short-preview'),
            user('only one user turn'),
            assistant('short'),
        ]);

        const candidates = await codex.findDbEligibleRecoveryCandidates(makeFakeAquifer(), {
            sessionsDir,
            stateDir,
            includeJsonlPreviews: true,
            minSessionBytes: 1,
            idleMs: 1,
            excludeNewest: false,
            minUserMessages: 3,
        });

        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].sessionId, 'meta-eligible');
        assert.equal(candidates[0].fileSessionId, 'rollout-eligible');
        assert.equal(candidates[0].userCount, 3);
        assert.match(candidates[0].transcriptHash, /^[a-f0-9]{64}$/);
    });

    it('ignores legacy imported markers that cannot point back to a transcript', async () => {
        const root = tmpDir();
        const stateDir = path.join(root, 'state');
        const importedDir = path.join(stateDir, 'codex-sessions-imported');
        fs.mkdirSync(importedDir, { recursive: true });
        fs.writeFileSync(path.join(importedDir, 'legacy-session'), 'old done\n', 'utf8');

        const candidates = await codex.findRecoveryCandidates(makeFakeAquifer(), {
            sessionsDir: path.join(root, 'sessions'),
            stateDir,
        });

        assert.deepEqual(candidates, []);
    });

    it('uses finalization ledger status to suppress completed recovery prompts', async () => {
        const root = tmpDir();
        const stateDir = path.join(root, 'state');
        const importedDir = path.join(stateDir, 'codex-sessions-imported');
        writeImportedMarker(importedDir, 'meta-ledger-done', {
            transcriptHash: 'a'.repeat(64),
            filePath: path.join(root, 'missing.jsonl'),
            source: 'codex',
            agentId: 'main',
        });
        const aq = makeFakeAquifer();
        aq.finalization = {
            async get() {
                return { status: 'finalized' };
            },
        };

        const candidates = await codex.findRecoveryCandidates(aq, {
            stateDir,
            sessionsDir: path.join(root, 'sessions'),
        });

        assert.deepEqual(candidates, []);
    });

    it('uses skipped finalization status to suppress recovery prompts', async () => {
        const root = tmpDir();
        const stateDir = path.join(root, 'state');
        const importedDir = path.join(stateDir, 'codex-sessions-imported');
        writeImportedMarker(importedDir, 'meta-ledger-skipped', {
            transcriptHash: 'b'.repeat(64),
            filePath: path.join(root, 'missing.jsonl'),
            source: 'codex',
            agentId: 'main',
        });
        const aq = makeFakeAquifer();
        aq.finalization.get = async () => ({ status: 'skipped' });

        const candidates = await codex.findRecoveryCandidates(aq, {
            stateDir,
            sessionsDir: path.join(root, 'sessions'),
        });

        assert.deepEqual(candidates, []);
    });

    it('materializes a sanitized transcript view only after consent', () => {
        const root = tmpDir();
        const file = path.join(root, 'rollout-safe.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-safe'),
            user('[AQUIFER CONTEXT] injected memory should not summarize'),
            user('請整理這段 session 的有效結論'),
            assistant('我先查檔案狀態', '2026-04-24T00:00:02.000Z', { phase: 'commentary' }),
            { type: 'response_item', timestamp: '2026-04-24T00:00:02.500Z', payload: { type: 'function_call', name: 'exec_command' } },
            assistant('完成：finalization 要走 sanitized transcript。'),
            user('OPENAI_API_KEY=sk-1234567890abcdefghijklmnop'),
        ]);

        const view = codex.materializeRecoveryTranscriptView({ filePath: file }, {
            maxRecoveryBytes: 1024 * 1024,
            maxRecoveryMessages: 20,
            maxRecoveryChars: 10000,
        });

        assert.equal(view.status, 'ok');
        assert.equal(view.sessionId, 'meta-safe');
        assert.match(view.transcriptHash, /^[a-f0-9]{64}$/);
        assert.match(view.text, /sanitized transcript/);
        assert.doesNotMatch(view.text, /AQUIFER CONTEXT/);
        assert.doesNotMatch(view.text, /我先查檔案狀態/);
        assert.doesNotMatch(view.text, /sk-1234567890abcdefghijklmnop/);
        assert.match(view.text, /\[REDACTED_SECRET\]/);
    });

    it('defers recovery transcript materialization when byte budget is exceeded', () => {
        const root = tmpDir();
        const file = path.join(root, 'rollout-budget.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-budget'),
            user('u1'),
            assistant('a1'),
        ]);

        const view = codex.materializeRecoveryTranscriptView({ filePath: file }, {
            maxRecoveryBytes: 10,
        });

        assert.equal(view.status, 'deferred');
        assert.equal(view.reason, 'max_bytes');
    });

    it('prepares SessionStart recovery metadata without reading JSONL before consent', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const file = path.join(sessionsDir, 'rollout-consent.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-consent'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const aq = makeFakeAquifer();
        await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 0,
            logger: { warn() {} },
        });
        fs.unlinkSync(file);
        const before = {
            commit: aq.calls.commit.length,
            enrich: aq.calls.enrich.length,
            finalize: aq.calls.finalization.filter(c => c.method === 'finalizeSession').length,
        };

        const prepared = await codex.prepareSessionStartRecovery(aq, {
            sessionsDir,
            stateDir,
            consent: false,
        });

        assert.equal(prepared.status, 'needs_consent');
        assert.equal(prepared.candidates[0].sessionId, 'meta-consent');
        assert.equal(aq.calls.commit.length, before.commit);
        assert.equal(aq.calls.enrich.length, before.enrich);
        assert.equal(aq.calls.finalization.filter(c => c.method === 'finalizeSession').length, before.finalize);
    });

    it('records declined recovery and suppresses the same digest without reading JSONL', async () => {
        const root = tmpDir();
        const stateDir = path.join(root, 'state');
        const sessionsDir = path.join(root, 'sessions');
        const file = path.join(sessionsDir, 'rollout-decline.jsonl');
        const transcriptHash = 'c'.repeat(64);
        writeImportedMarker(path.join(stateDir, 'codex-sessions-imported'), 'meta-decline', {
            transcriptHash,
            filePath: file,
            source: 'codex',
            agentId: 'main',
        });
        const aq = makeFakeAquifer({
            'meta-decline': {
                session_id: 'meta-decline',
                processing_status: 'pending',
                msg_count: 6,
                user_count: 3,
                assistant_count: 3,
            },
        });
        const candidate = {
            sessionId: 'meta-decline',
            transcriptHash,
            filePath: file,
            source: 'codex',
            agentId: 'main',
        };

        const decision = await codex.recordRecoveryDecision(aq, candidate, 'declined', {
            stateDir,
            reason: 'user_declined',
        });
        fs.rmSync(sessionsDir, { recursive: true, force: true });
        const candidates = await codex.findRecoveryCandidates(aq, { stateDir, sessionsDir });

        assert.equal(decision.status, 'declined');
        assert.deepEqual(candidates, []);
        assert.equal(aq.calls.commit.length, 0);
        assert.equal(aq.calls.enrich.length, 0);
        assert.equal(aq.calls.finalization.some(c => c.method === 'finalizeSession'), false);
    });

    it('deferred recovery is hidden from SessionStart but available for manual include-deferred lookup', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const file = path.join(sessionsDir, 'rollout-deferred.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-deferred'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const aq = makeFakeAquifer();
        const [candidate] = await codex.findDbEligibleRecoveryCandidates(aq, {
            sessionsDir,
            stateDir,
            includeJsonlPreviews: true,
            minSessionBytes: 1,
            idleMs: 1,
            excludeNewest: false,
        });

        await codex.recordRecoveryDecision(aq, candidate, 'deferred', {
            stateDir,
            reason: 'manual_later',
        });

        const hidden = await codex.findDbEligibleRecoveryCandidates(aq, {
            sessionsDir,
            stateDir,
            includeJsonlPreviews: true,
            minSessionBytes: 1,
            idleMs: 1,
            excludeNewest: false,
        });
        const manual = await codex.findDbEligibleRecoveryCandidates(aq, {
            sessionsDir,
            stateDir,
            includeJsonlPreviews: true,
            includeDeferredRecovery: true,
            minSessionBytes: 1,
            idleMs: 1,
            excludeNewest: false,
        });

        assert.deepEqual(hidden, []);
        assert.equal(manual.length, 1);
        assert.equal(manual[0].sessionId, 'meta-deferred');
        assert.equal(manual[0].recoveryDecisionStatus, 'deferred');
    });

    it('records short consented recovery as skipped and suppresses the same preview candidate', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const file = path.join(sessionsDir, 'rollout-short-recovery.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-short-recovery'),
            user('one substantial user turn only'),
            assistant('one assistant reply'),
        ]);
        const aq = makeFakeAquifer();

        const prepared = await codex.prepareSessionStartRecovery(aq, {
            sessionsDir,
            stateDir,
            includeJsonlPreviews: true,
            minSessionBytes: 1,
            idleMs: 1,
            excludeNewest: false,
            consent: true,
            minUserMessages: 3,
        });
        const candidates = await codex.findRecoveryCandidates(aq, {
            sessionsDir,
            stateDir,
            includeJsonlPreviews: true,
            minSessionBytes: 1,
            idleMs: 1,
            excludeNewest: false,
        });

        assert.equal(prepared.status, 'skipped_short');
        assert.equal(prepared.userCount, 1);
        assert.deepEqual(candidates, []);
        assert.equal(aq.calls.finalization.some(c => c.method === 'finalizeSession'), false);
    });

    it('does not let local decline suppress a DB pending finalization', async () => {
        const root = tmpDir();
        const stateDir = path.join(root, 'state');
        const sessionsDir = path.join(root, 'sessions');
        const transcriptHash = 'd'.repeat(64);
        writeImportedMarker(path.join(stateDir, 'codex-sessions-imported'), 'meta-pending', {
            transcriptHash,
            filePath: path.join(sessionsDir, 'missing.jsonl'),
            source: 'codex',
            agentId: 'main',
        });
        await codex.recordRecoveryDecision(null, {
            sessionId: 'meta-pending',
            transcriptHash,
            filePath: path.join(sessionsDir, 'missing.jsonl'),
        }, 'declined', { stateDir });
        const aq = makeFakeAquifer();
        aq.finalization.get = async () => ({ status: 'pending' });

        const candidates = await codex.findRecoveryCandidates(aq, { stateDir, sessionsDir });

        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].sessionId, 'meta-pending');
        assert.equal(candidates[0].finalizationStatus, 'pending');
    });

    it('filters recovery markers with mismatched source or agent provenance', async () => {
        const root = tmpDir();
        const stateDir = path.join(root, 'state');
        const importedDir = path.join(stateDir, 'codex-sessions-imported');
        writeImportedMarker(importedDir, 'meta-main', {
            transcriptHash: 'e'.repeat(64),
            filePath: path.join(root, 'main.jsonl'),
            source: 'codex',
            agentId: 'main',
        });
        writeImportedMarker(importedDir, 'meta-other', {
            transcriptHash: 'f'.repeat(64),
            filePath: path.join(root, 'other.jsonl'),
            source: 'codex',
            agentId: 'other',
        });

        const candidates = await codex.findRecoveryCandidates(makeFakeAquifer(), {
            stateDir,
            sessionsDir: path.join(root, 'sessions'),
            agentId: 'main',
        });

        assert.deepEqual(candidates.map(c => c.sessionId), ['meta-main']);
    });

    it('prepares an agent prompt after consent and finalizes through core without enrich', async () => {
        const root = tmpDir();
        const file = path.join(root, 'rollout-finalize.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-finalize'),
            user('[AQUIFER CONTEXT] should be dropped'),
            user('Aquifer finalization 要走 core ledger'),
            assistant('結論：handoff 可以直接寫 curated memory。'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const aq = makeFakeAquifer();
        const prepared = await codex.prepareSessionStartRecovery(aq, {
            stateDir: path.join(root, 'state'),
            sessionsDir: root,
            includeJsonlPreviews: true,
            minSessionBytes: 1,
            idleMs: 1,
            excludeNewest: false,
            consent: true,
        });

        assert.equal(prepared.status, 'needs_agent_summary');
        assert.match(prepared.prompt, /sanitized_transcript/);
        assert.doesNotMatch(prepared.prompt, /AQUIFER CONTEXT/);

        const result = await codex.finalizeCodexSession(aq, {
            view: prepared.view,
            mode: 'session_start_recovery',
            summaryText: 'Aquifer finalization now writes through core.',
            structuredSummary: {
                facts: [{ subject: 'Aquifer', statement: 'Finalization writes through core ledger.' }],
            },
        });

        assert.equal(result.status, 'finalized');
        assert.equal(aq.calls.commit.length, 1);
        assert.equal(aq.calls.enrich.length, 0);
        const finalizeCall = aq.calls.finalization.find(c => c.method === 'finalizeSession');
        assert.equal(finalizeCall.input.mode, 'session_start_recovery');
        assert.equal(finalizeCall.input.sessionId, 'meta-finalize');
        assert.match(finalizeCall.input.transcriptHash, /^[a-f0-9]{64}$/);
        assert.equal(finalizeCall.input.metadata.trigger, 'session_start_recovery');
    });

    it('re-commits a stale session snapshot before finalization', async () => {
        const root = tmpDir();
        const file = path.join(root, 'rollout-stale-finalize.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-stale'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const view = codex.materializeRecoveryTranscriptView({
            sessionId: 'meta-stale',
            filePath: file,
        }, { maxRecoveryBytes: 1024 * 1024 });
        assert.equal(view.status, 'ok');

        const aq = makeFakeAquifer({
            'meta-stale': {
                session_id: 'meta-stale',
                processing_status: 'succeeded',
                msg_count: 2,
                user_count: 1,
                assistant_count: 1,
                messages: {
                    normalized: view.messages.slice(0, 2),
                    metadata: { transcript_hash: '0'.repeat(64) },
                },
            },
        });

        const result = await codex.finalizeCodexSession(aq, {
            view,
            summaryText: 'Re-finalization uses the current committed transcript.',
            structuredSummary: {
                facts: [{ subject: 'Codex', statement: 'Stale snapshots are recommitted before finalization.' }],
            },
        });

        assert.equal(result.status, 'finalized');
        assert.equal(result.commit.status, 'recommitted');
        assert.equal(aq.calls.commit.length, 1);
        assert.equal(aq.calls.commit[0].sessionId, 'meta-stale');
        assert.equal(aq.calls.commit[0].messages.length, view.messages.length);
    });

    it('does not re-commit when the existing session snapshot matches the finalization view', async () => {
        const root = tmpDir();
        const file = path.join(root, 'rollout-current-finalize.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-current'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const view = codex.materializeRecoveryTranscriptView({
            sessionId: 'meta-current',
            filePath: file,
        }, { maxRecoveryBytes: 1024 * 1024 });
        assert.equal(view.status, 'ok');

        const aq = makeFakeAquifer({
            'meta-current': {
                session_id: 'meta-current',
                processing_status: 'succeeded',
                msg_count: view.messages.length,
                user_count: view.counts.userCount,
                assistant_count: view.counts.assistantCount,
                messages: {
                    normalized: view.messages,
                    metadata: { transcript_hash: view.transcriptHash },
                },
            },
        });

        const result = await codex.finalizeCodexSession(aq, {
            view,
            summaryText: 'Current snapshot can be finalized directly.',
            structuredSummary: {
                facts: [{ subject: 'Codex', statement: 'Matching snapshots do not need recommit.' }],
            },
        });

        assert.equal(result.status, 'finalized');
        assert.equal(result.commit.status, 'already_committed');
        assert.equal(aq.calls.commit.length, 0);
    });
});

describe('Codex consumer runSync', () => {
    it('imports and finalizes idle Codex sessions using meta id markers', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        writeJsonl(path.join(sessionsDir, 'rollout-abc.jsonl'), [
            sessionMeta('meta-abc'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const aq = makeFakeAquifer();

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 10,
            summaryFn: makeFinalizationSummary(),
            logger: { warn() {} },
        });

        assert.equal(result.imported.length, 1);
        assert.equal(result.afterburned.length, 1);
        assert.equal(aq.calls.commit[0].sessionId, 'meta-abc');
        assert.equal(aq.calls.enrich.length, 0);
        assert.equal(aq.calls.finalization.filter(c => c.method === 'finalizeSession').length, 1);
        assert.deepEqual(aq.calls.commit[0].opts.rawMessages.normalized, aq.calls.commit[0].messages);
        assert.equal(aq.calls.commit[0].opts.rawMessages.metadata.raw_entry_count, 7);
        assert.ok(aq.calls.commit[0].opts.rawMessages.metadata.skipStats);
        assert.ok(fs.existsSync(codex.markerPath(path.join(stateDir, 'codex-sessions-imported'), 'meta-abc')));
        assert.ok(!fs.existsSync(path.join(stateDir, 'codex-sessions-imported', 'rollout-abc')));
    });

    it('preserves committed review and SessionStart text for import afterburn parity', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        writeJsonl(path.join(sessionsDir, 'rollout-afterburn-surface.jsonl'), [
            sessionMeta('meta-afterburn-surface'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const aq = makeFakeAquifer({}, {
            finalizeResult: input => ({
                status: 'finalized',
                finalization: { id: 99, mode: input.mode },
                memoryResult: { promoted: 1 },
                humanReviewText: '已整理進 DB：afterburn wrapper parity smoke',
                sessionStartText: '下一段只需要帶：\n- 決策：afterburn wrapper parity smoke\n',
            }),
        });

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 10,
            summaryFn: makeFinalizationSummary(),
            logger: { warn() {} },
        });

        assert.equal(result.afterburned.length, 1);
        assert.equal(result.afterburned[0].humanReviewText, '已整理進 DB：afterburn wrapper parity smoke');
        assert.equal(
            result.afterburned[0].sessionStartText,
            '下一段只需要帶：\n- 決策：afterburn wrapper parity smoke\n',
        );
        assert.equal(
            result.afterburned[0].finalization.humanReviewText,
            '已整理進 DB：afterburn wrapper parity smoke',
        );
        assert.equal(
            aq.calls.finalization.find(call => call.method === 'finalizeSession').input.mode,
            'afterburn',
        );
    });

    it('re-imports when JSONL contains more messages than an existing DB snapshot', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        writeJsonl(path.join(sessionsDir, 'rollout-partial.jsonl'), [
            sessionMeta('meta-partial'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
            user('u4'),
            assistant('a4'),
        ]);
        fs.mkdirSync(path.join(stateDir, 'codex-sessions-imported'), { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'codex-sessions-imported', 'meta-partial'), 'old done\n');
        const aq = makeFakeAquifer({
            'meta-partial': {
                session_id: 'meta-partial',
                processing_status: 'succeeded',
                msg_count: 2,
                user_count: 1,
                assistant_count: 1,
            },
        });

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 10,
            logger: { warn() {} },
        });

        assert.equal(result.imported.length, 1);
        assert.equal(aq.calls.commit.length, 1);
        assert.equal(aq.calls.commit[0].messages.length, 8);
    });

    it('skips short sessions through aquifer.skip instead of leaving pending', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        writeJsonl(path.join(sessionsDir, 'rollout-short.jsonl'), [
            sessionMeta('meta-short'),
            user('u1'),
            assistant('a1'),
        ]);
        const aq = makeFakeAquifer();

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 10,
            minImportUserMessages: 1,
            minUserMessages: 3,
            logger: { warn() {} },
        });

        assert.equal(result.imported.length, 1);
        assert.equal(result.skipped.some((r) => r.status === 'skipped_short'), true);
        assert.equal(aq.calls.skip.length, 1);
        assert.match(aq.calls.skip[0].opts.reason, /user_count=1/);
        assert.ok(aq.calls.finalization.some((c) => {
            return c.method === 'updateStatus'
                && c.input.sessionId === 'meta-short'
                && c.input.status === 'skipped';
        }));
    });

    it('skips short sessions before import by default to match CC import threshold', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        writeJsonl(path.join(sessionsDir, 'rollout-short-import.jsonl'), [
            sessionMeta('meta-short-import'),
            user('u1'),
            assistant('a1'),
        ]);
        const aq = makeFakeAquifer();

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 10,
            minUserMessages: 3,
            logger: { warn() {} },
        });

        assert.equal(result.imported.length, 0);
        assert.equal(result.skipped.some((r) => r.status === 'skipped_empty'), true);
        assert.equal(aq.calls.commit.length, 0);
        assert.equal(aq.calls.skip.length, 0);
        assert.ok(fs.existsSync(codex.markerPath(path.join(stateDir, 'codex-sessions-imported'), 'meta-short-import')));
        assert.ok(fs.existsSync(codex.markerPath(path.join(stateDir, 'codex-sessions-afterburned'), 'meta-short-import')));

        const second = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 10,
            minUserMessages: 3,
            logger: { warn() {} },
        });
        assert.equal(second.imported.length, 0);
        assert.equal(second.afterburned.length, 0);
        assert.equal(second.skipped.length, 0);
        assert.equal(aq.calls.commit.length, 0);
    });

    it('retries old local done markers when the finalization ledger is still pending', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const importedDir = path.join(stateDir, 'codex-sessions-imported');
        const afterburnedDir = path.join(stateDir, 'codex-sessions-afterburned');
        const file = path.join(sessionsDir, 'marker-only-session.jsonl');
        writeJsonl(file, [
            sessionMeta('marker-only-session'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const transcriptHash = codex.parseCodexSessionFile(file).normalized.transcriptHash;
        writeImportedMarker(importedDir, 'marker-only-session', {
            transcriptHash,
            filePath: file,
            source: 'codex',
            agentId: 'main',
        });
        writeImportedMarker(afterburnedDir, 'marker-only-session', { transcriptHash }, 'done');
        const aq = makeFakeAquifer({
            'marker-only-session': {
                session_id: 'marker-only-session',
                processing_status: 'pending',
                msg_count: 6,
                user_count: 3,
                assistant_count: 3,
            },
        });
        await aq.finalization.createTask({
            sessionId: 'marker-only-session',
            agentId: 'main',
            source: 'codex',
            host: 'codex',
            transcriptHash,
            mode: 'afterburn',
            status: 'pending',
        });

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 10,
            summaryFn: makeFinalizationSummary('Pending ledger is finalized on retry.'),
            logger: { warn() {} },
        });

        assert.equal(result.imported.length, 0);
        assert.equal(result.afterburned.length, 1);
        assert.equal(aq.calls.enrich.length, 0);
        assert.equal(aq.calls.finalization.filter(c => c.method === 'finalizeSession').length, 1);
    });

    it('keeps pending finalization explicit when no summary function is available', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        writeJsonl(path.join(sessionsDir, 'rollout-backfill.jsonl'), [
            sessionMeta('meta-backfill'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const aq = makeFakeAquifer();

        const first = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 10,
            logger: { warn() {} },
        });

        assert.equal(first.afterburned.length, 0);
        assert.equal(first.skipped.some((r) => r.status === 'missing_summary'), true);
        assert.equal(aq.calls.enrich.length, 0);
        assert.equal(aq.calls.finalization.filter(c => c.method === 'finalizeSession').length, 0);
        assert.match(
            fs.readFileSync(codex.markerPath(path.join(stateDir, 'codex-sessions-afterburned'), 'meta-backfill'), 'utf8'),
            /backfill-pending/,
        );

        const second = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 1,
            maxImports: 10,
            maxAfterburns: 10,
            summaryFn: makeFinalizationSummary('Summary arrives later and finalizes the session.'),
            logger: { warn() {} },
        });

        assert.equal(second.afterburned.length, 1);
        assert.equal(aq.calls.finalization.filter(c => c.method === 'finalizeSession').length, 1);
        assert.match(
            fs.readFileSync(codex.markerPath(path.join(stateDir, 'codex-sessions-afterburned'), 'meta-backfill'), 'utf8'),
            /done/,
        );
    });

    it('does not import files newer than idleMs', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const file = path.join(sessionsDir, 'rollout-active.jsonl');
        writeJsonl(file, [sessionMeta('meta-active'), user('u1'), assistant('a1')]);
        const now = Date.now();
        fs.utimesSync(file, new Date(now), new Date(now));
        const aq = makeFakeAquifer();

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 5 * 60 * 1000,
            maxImports: 10,
            maxAfterburns: 10,
            now,
            logger: { warn() {} },
        });

        assert.equal(result.imported.length, 0);
        assert.equal(aq.calls.commit.length, 0);
    });

    it('imports active files immediately when idleMs is zero', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const file = path.join(sessionsDir, 'rollout-new-session-prev.jsonl');
        writeJsonl(file, [
            sessionMeta('meta-new-session-prev'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        const now = Date.now();
        fs.utimesSync(file, new Date(now), new Date(now));
        const aq = makeFakeAquifer();

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 0,
            maxImports: 10,
            maxAfterburns: 10,
            now,
            summaryFn: makeFinalizationSummary(),
            logger: { warn() {} },
        });

        assert.equal(result.imported.length, 1);
        assert.equal(result.afterburned.length, 1);
        assert.equal(aq.calls.commit[0].sessionId, 'meta-new-session-prev');
        assert.equal(aq.calls.enrich.length, 0);
        assert.equal(aq.calls.finalization.filter(c => c.method === 'finalizeSession').length, 1);
    });

    it('can exclude the newest file so watcher sync does not import the active TUI session', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const previous = path.join(sessionsDir, 'rollout-previous.jsonl');
        const active = path.join(sessionsDir, 'rollout-active.jsonl');
        writeJsonl(previous, [
            sessionMeta('meta-previous'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        writeJsonl(active, [
            sessionMeta('meta-active'),
            user('current'),
            assistant('still running'),
            user('current 2'),
            assistant('still running 2'),
            user('current 3'),
            assistant('still running 3'),
        ]);
        const now = Date.now();
        fs.utimesSync(previous, new Date(now - 1000), new Date(now - 1000));
        fs.utimesSync(active, new Date(now), new Date(now));
        const aq = makeFakeAquifer();

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 0,
            maxImports: 10,
            maxAfterburns: 10,
            excludeNewest: true,
            now,
            summaryFn: makeFinalizationSummary(),
            logger: { warn() {} },
        });

        assert.equal(result.imported.length, 1);
        assert.equal(result.afterburned.length, 1);
        assert.equal(aq.calls.commit[0].sessionId, 'meta-previous');
        assert.equal(aq.calls.enrich.length, 0);
        assert.equal(aq.calls.finalization.filter(c => c.method === 'finalizeSession').length, 1);
    });

    it('can exclude the current SessionStart transcript while importing the previous session', async () => {
        const root = tmpDir();
        const sessionsDir = path.join(root, 'sessions');
        const stateDir = path.join(root, 'state');
        const previous = path.join(sessionsDir, 'rollout-previous.jsonl');
        const current = path.join(sessionsDir, 'rollout-current.jsonl');
        writeJsonl(previous, [
            sessionMeta('meta-previous-startup'),
            user('u1'),
            assistant('a1'),
            user('u2'),
            assistant('a2'),
            user('u3'),
            assistant('a3'),
        ]);
        writeJsonl(current, [
            sessionMeta('meta-current-startup'),
            user('current should not import'),
            assistant('still active'),
            user('current 2'),
            assistant('still active 2'),
            user('current 3'),
            assistant('still active 3'),
        ]);
        const now = Date.now();
        fs.utimesSync(previous, new Date(now - 1000), new Date(now - 1000));
        fs.utimesSync(current, new Date(now), new Date(now));
        const aq = makeFakeAquifer();

        const result = await codex.runSync(aq, {
            sessionsDir,
            stateDir,
            minSessionBytes: 1,
            idleMs: 0,
            maxImports: 10,
            maxAfterburns: 10,
            excludePaths: [current],
            excludeSessionIds: ['meta-current-startup'],
            now,
            summaryFn: makeFinalizationSummary(),
            logger: { warn() {} },
        });

        assert.equal(result.imported.length, 1);
        assert.equal(result.afterburned.length, 1);
        assert.equal(aq.calls.commit[0].sessionId, 'meta-previous-startup');
        assert.equal(aq.calls.enrich.length, 0);
        assert.equal(aq.calls.finalization.filter(c => c.method === 'finalizeSession').length, 1);
    });
});
