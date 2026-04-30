'use strict';

const {
    buildCheckpointCoverageFromView,
    hashSnapshot,
    promptSafeSynthesisInput,
    stableJson,
} = require('../core/session-checkpoint-producer');
const { compactCurrentMemorySnapshot } = require('./codex-current-memory');

function positiveInt(value, fallback, max = 100000) {
    const n = Number(value === undefined || value === null || value === '' ? fallback : value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(max, Math.trunc(n)));
}

function buildActiveCheckpointScopeEnvelope(opts = {}) {
    const envelope = opts.scopeEnvelope || opts.scope_envelope;
    if (envelope && typeof envelope === 'object') return envelope;
    const scopeKey = String(opts.activeScopeKey || opts.scopeKey || opts.scope_key || '').trim();
    if (!scopeKey) {
        throw new Error('active session checkpoint requires activeScopeKey or scopeKey');
    }
    const scopeKind = String(opts.activeScopeKind || opts.scopeKind || opts.scope_kind || 'project').trim();
    const slotId = scopeKind === 'host_runtime' ? 'host' : (
        ['workspace', 'project', 'repo', 'task', 'session'].includes(scopeKind) ? scopeKind : 'target'
    );
    const promotable = !['session', 'task'].includes(slotId);
    const slot = {
        id: slotId,
        slot: slotId,
        scopeKind,
        scopeKey,
        label: scopeKey,
        promotable,
        allowedScopeKeys: promotable ? ['global', scopeKey] : ['global'],
    };
    if (!promotable) {
        throw new Error(`active session checkpoint target scope is not promotable: ${scopeKind}`);
    }
    return {
        policyVersion: 'scope_envelope_v1',
        activeSlotId: slot.id,
        activeScopeKey: scopeKey,
        allowedScopeKeys: slot.allowedScopeKeys,
        slots: [slot],
        scopeById: { [slot.id]: slot },
    };
}

function buildActiveSessionCheckpointInput(view = {}, opts = {}) {
    if (!view || view.status !== 'ok') {
        throw new Error(`active session checkpoint requires an ok transcript view; got ${view && view.status ? view.status : 'missing'}`);
    }
    const messageCount = Number.isFinite(Number(view.counts?.safeMessageCount))
        ? Number(view.counts.safeMessageCount)
        : (Array.isArray(view.messages) ? view.messages.length : 0);
    const userCount = Number(view.counts?.userCount || view.messages?.filter?.(m => m.role === 'user').length || 0);
    const everyMessages = positiveInt(opts.checkpointEveryMessages || opts.everyMessages, 20, 1000);
    const everyUserMessages = opts.checkpointEveryUserMessages || opts.everyUserMessages
        ? positiveInt(opts.checkpointEveryUserMessages || opts.everyUserMessages, 10, 1000)
        : null;
    const force = opts.force === true;
    const due = force
        || messageCount >= everyMessages
        || (everyUserMessages !== null && userCount >= everyUserMessages);
    const base = {
        kind: 'codex_active_session_checkpoint_input_v1',
        policyVersion: opts.policyVersion || 'codex_active_session_checkpoint_v1',
        sourceOfTruth: 'codex_sanitized_live_transcript_view',
        triggerKind: opts.triggerKind || 'message_count',
        promotion: {
            default: 'checkpoint_proposal_only',
            requires: 'handoff_or_operator_review',
        },
        guards: {
            checkpointIsProcessMaterial: true,
            activeMemoryCommitExcluded: true,
            dbWriteExcluded: true,
            rawToolOutputExcluded: true,
            debugIdsExcluded: true,
        },
        threshold: {
            everyMessages,
            everyUserMessages,
            messageCount,
            userCount,
            due,
        },
        targetScope: {
            activeScopeKey: opts.activeScopeKey || opts.scopeKey || null,
            activeScopePath: opts.activeScopePath || null,
        },
        scopeEnvelope: buildActiveCheckpointScopeEnvelope(opts),
        coverage: buildCheckpointCoverageFromView(view, opts),
        transcript: {
            sessionId: view.sessionId || null,
            charCount: view.charCount ?? String(view.text || '').length,
            fullCharCount: view.fullCharCount ?? view.counts?.fullCharCount ?? view.charCount ?? String(view.text || '').length,
            approxPromptTokens: view.approxPromptTokens || Math.ceil(String(view.text || '').length / 3),
            fullApproxPromptTokens: view.fullApproxPromptTokens || view.counts?.fullApproxPromptTokens || null,
            truncated: Boolean(view.truncated || view.transcriptWindow?.truncated),
            transcriptWindow: view.transcriptWindow || null,
            text: view.text || '',
        },
        currentMemory: compactCurrentMemorySnapshot(opts.currentMemory || null, opts),
    };
    return {
        ...base,
        inputHash: hashSnapshot(base),
    };
}

function buildActiveSessionCheckpointPrompt(checkpointInput = {}, opts = {}) {
    if (!checkpointInput || checkpointInput.kind !== 'codex_active_session_checkpoint_input_v1') {
        throw new Error('buildActiveSessionCheckpointPrompt requires an active session checkpoint input');
    }
    const promptInput = promptSafeSynthesisInput(checkpointInput);
    const maxFacts = Math.max(1, Math.min(24, opts.maxFacts || 8));
    return [
        'You are producing an Aquifer active-session checkpoint proposal for Codex.',
        'Use only the <active_checkpoint_input> block. Do not use hidden tool output, injected context, or debug material.',
        'This checkpoint is process material for later handoff. It is not active current memory and must not be treated as final truth.',
        'Return compact JSON with this shape:',
        '{"summaryText":"...","structuredSummary":{"facts":[],"decisions":[],"open_loops":[],"preferences":[],"constraints":[],"conclusions":[],"entity_notes":[],"states":[]},"coverage":{"coordinateSystem":"codex_sanitized_view_v1","coveredUntilMessageIndex":0,"coveredUntilChar":0}}',
        `Keep facts/decisions/open_loops concrete and scoped. Use at most ${maxFacts} facts.`,
        'Preserve the coverage object so a later handoff can skip the already-covered transcript prefix.',
        '',
        '<active_checkpoint_input>',
        stableJson(promptInput),
        '</active_checkpoint_input>',
    ].join('\n');
}

async function prepareActiveSessionCheckpoint(aquifer, opts = {}, deps = {}) {
    const materializeRecoveryTranscriptView = deps.materializeRecoveryTranscriptView;
    const resolveCurrentMemoryForFinalization = deps.resolveCurrentMemoryForFinalization || (async () => null);
    const view = opts.view || (opts.filePath && typeof materializeRecoveryTranscriptView === 'function'
        ? materializeRecoveryTranscriptView({
            filePath: opts.filePath,
            sessionId: opts.sessionId,
        }, {
            ...opts,
            maxRecoveryBytes: opts.maxCheckpointBytes ?? opts.maxRecoveryBytes,
            maxRecoveryMessages: opts.maxCheckpointMessages ?? opts.maxRecoveryMessages,
            maxRecoveryChars: opts.maxCheckpointChars ?? opts.maxRecoveryChars,
            maxRecoveryPromptTokens: opts.maxCheckpointPromptTokens ?? opts.maxRecoveryPromptTokens,
        })
        : null);
    if (!view || view.status !== 'ok') {
        return {
            status: view?.status || 'missing_view',
            reason: view?.reason || null,
            view,
        };
    }
    const currentMemory = await resolveCurrentMemoryForFinalization(aquifer, opts);
    const checkpointInput = buildActiveSessionCheckpointInput(view, {
        ...opts,
        currentMemory,
    });
    if (!checkpointInput.threshold.due) {
        return {
            status: 'not_ready',
            due: false,
            checkpointInput,
            view,
            currentMemory,
        };
    }
    return {
        status: 'needs_agent_checkpoint',
        due: true,
        outputSchemaVersion: 'codex_active_session_checkpoint_v1',
        checkpointInput,
        view,
        currentMemory,
        prompt: buildActiveSessionCheckpointPrompt(checkpointInput, opts),
    };
}

module.exports = {
    buildActiveSessionCheckpointInput,
    buildActiveSessionCheckpointPrompt,
    prepareActiveSessionCheckpoint,
};
