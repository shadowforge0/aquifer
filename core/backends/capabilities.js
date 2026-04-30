'use strict';

const BACKEND_KINDS = new Set(['postgres', 'local']);

const CAPABILITY_PROFILES = {
  postgres: {
    kind: 'postgres',
    profile: 'full',
    label: 'PostgreSQL full backend',
    summary: 'Full Aquifer backend with PostgreSQL, pgvector, full-text search, migrations, and operator workflows.',
    capabilities: {
      zeroConfig: 'unsupported',
      persistence: 'full',
      evidenceWrite: 'full',
      evidenceRecallLexical: 'full',
      evidenceRecallVectorSummary: 'full',
      evidenceRecallVectorTurn: 'full',
      curatedBootstrap: 'full',
      curatedRecall: 'full',
      finalizationLedger: 'full',
      operatorCompaction: 'full',
      operatorCheckpoint: 'full',
      multiProcessClaims: 'full',
      migrationHandshake: 'full',
      exportSnapshot: 'full',
    },
    upgradeHint: null,
  },
  local: {
    kind: 'local',
    profile: 'starter',
    label: 'Local starter backend',
    summary: 'Zero-config starter backend lane. This profile is explicit and degraded; PostgreSQL remains the full backend.',
    capabilities: {
      zeroConfig: 'full',
      persistence: 'full',
      evidenceWrite: 'full',
      evidenceRecallLexical: 'degraded',
      evidenceRecallVectorSummary: 'unsupported',
      evidenceRecallVectorTurn: 'unsupported',
      sessionBootstrap: 'degraded',
      curatedBootstrap: 'unsupported',
      curatedRecall: 'unsupported',
      finalizationLedger: 'unsupported',
      operatorCompaction: 'unsupported',
      operatorCheckpoint: 'unsupported',
      multiProcessClaims: 'unsupported',
      migrationHandshake: 'unsupported',
      exportSnapshot: 'full',
    },
    upgradeHint: 'Use the PostgreSQL quickstart for full semantic recall, migrations, and operator workflows.',
  },
};

function normalizeBackendKind(value) {
  const kind = String(value || 'postgres').trim().toLowerCase();
  if (!BACKEND_KINDS.has(kind)) {
    throw new Error(`Invalid Aquifer backend: "${value}". Must be one of: ${[...BACKEND_KINDS].join(', ')}`);
  }
  return kind;
}

function backendCapabilities(kind) {
  return JSON.parse(JSON.stringify(CAPABILITY_PROFILES[normalizeBackendKind(kind)]));
}

function unsupportedCapabilityError(kind, capability, operation) {
  const profile = backendCapabilities(kind);
  const status = profile.capabilities[capability] || 'unsupported';
  const err = new Error(
    `${operation || capability} is not available on Aquifer backend "${profile.kind}" `
    + `(capability ${capability}: ${status}). ${profile.upgradeHint || ''}`.trim()
  );
  err.code = 'AQ_BACKEND_CAPABILITY_UNSUPPORTED';
  err.backendKind = profile.kind;
  err.backendProfile = profile.profile;
  err.capability = capability;
  err.capabilityStatus = status;
  err.upgradeHint = profile.upgradeHint;
  return err;
}

module.exports = {
  BACKEND_KINDS,
  CAPABILITY_PROFILES,
  normalizeBackendKind,
  backendCapabilities,
  unsupportedCapabilityError,
};
