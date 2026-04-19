'use strict';

// AqError / AqResult — canonical error and result envelope for the
// completion-capability API surface (P1 foundation).
//
// Scope: NEW capability methods only (aq.narratives.*, aq.facts.*,
// aq.consolidation.*, aq.profiles.*, aq.timeline.*, etc.).
// Legacy APIs (commit/enrich/recall/migrate) keep throw semantics
// until a 2.0 major. See aquifer-completion define §audit.
//
// Shape mirrors the spec:
//   type AqResult<T> = { ok: true, data: T } | { ok: false, error: AqError };
//
// AqError is a plain subclass of Error that carries a stable `code`,
// an optional `details` bag, and a `retryable` flag so transport-layer
// retries (cc-afterburn, gateway afterburn) can make routing decisions
// without string-matching messages.

const KNOWN_CODES = new Set([
  // Generic
  'AQ_INVALID_INPUT',
  'AQ_NOT_FOUND',
  'AQ_CONFLICT',
  'AQ_INTERNAL',
  'AQ_DEPENDENCY',
  // Consolidation orchestration
  'AQ_PHASE_CLAIM_CONFLICT',
  'AQ_PHASE_TRANSITION_INVALID',
  // Schema registry / profile
  'AQ_PROFILE_NOT_FOUND',
  'AQ_PROFILE_MARKER_MISMATCH',
  // Bundle
  'AQ_IMPORT_CONFLICT',
  // Facts / narratives lifecycle
  'AQ_FACT_SUPERSEDED',
  'AQ_NARRATIVE_SUPERSEDED',
]);

class AqError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'AqError';
    this.code = code;
    this.details = opts.details || null;
    this.retryable = opts.retryable === true;
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

function ok(data) {
  return { ok: true, data };
}

function err(code, message, opts = {}) {
  const error = code instanceof AqError
    ? code
    : new AqError(code, message, opts);
  return { ok: false, error };
}

// Wraps an async function so any thrown error becomes an AQ_INTERNAL AqError.
// Use at capability method boundaries; inside, code should prefer explicit
// ok()/err() returns for known failure modes.
function asResult(asyncFn) {
  return async (...args) => {
    try {
      const data = await asyncFn(...args);
      return ok(data);
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  };
}

function isKnownCode(code) {
  return KNOWN_CODES.has(code);
}

module.exports = {
  AqError,
  ok,
  err,
  asResult,
  isKnownCode,
  KNOWN_CODES,
};
