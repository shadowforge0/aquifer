'use strict';

// P1 — AqError / AqResult envelope unit tests.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { AqError, ok, err, asResult, isKnownCode, KNOWN_CODES } = require('../index');

describe('AqError', () => {
  it('carries code + retryable + details + optional cause', () => {
    const cause = new Error('boom');
    const e = new AqError('AQ_INTERNAL', 'wrapped', {
      details: { op: 'test' },
      retryable: true,
      cause,
    });
    assert.equal(e.name, 'AqError');
    assert.equal(e.code, 'AQ_INTERNAL');
    assert.equal(e.message, 'wrapped');
    assert.deepEqual(e.details, { op: 'test' });
    assert.equal(e.retryable, true);
    assert.equal(e.cause, cause);
  });

  it('toJSON serialises shape for transport boundaries', () => {
    const e = new AqError('AQ_NOT_FOUND', 'missing');
    assert.deepEqual(e.toJSON(), {
      name: 'AqError',
      code: 'AQ_NOT_FOUND',
      message: 'missing',
      details: null,
      retryable: false,
    });
  });

  it('is instance of Error for interop', () => {
    const e = new AqError('AQ_INVALID_INPUT', 'bad');
    assert.ok(e instanceof Error);
    assert.ok(e instanceof AqError);
  });
});

describe('ok / err envelope', () => {
  it('ok wraps data', () => {
    const r = ok({ narrativeId: 42 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { narrativeId: 42 });
  });

  it('err with code + message constructs AqError', () => {
    const r = err('AQ_NOT_FOUND', 'no such row');
    assert.equal(r.ok, false);
    assert.ok(r.error instanceof AqError);
    assert.equal(r.error.code, 'AQ_NOT_FOUND');
  });

  it('err with existing AqError passes through', () => {
    const existing = new AqError('AQ_CONFLICT', 'race');
    const r = err(existing);
    assert.equal(r.ok, false);
    assert.equal(r.error, existing);
  });
});

describe('asResult', () => {
  it('wraps resolving async fn into ok envelope', async () => {
    const wrapped = asResult(async (x) => x * 2);
    const r = await wrapped(21);
    assert.deepEqual(r, { ok: true, data: 42 });
  });

  it('wraps throws into err envelope with AQ_INTERNAL', async () => {
    const wrapped = asResult(async () => { throw new Error('oops'); });
    const r = await wrapped();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_INTERNAL');
    assert.equal(r.error.message, 'oops');
    assert.ok(r.error.cause);
  });

  it('preserves AqError thrown inside', async () => {
    const wrapped = asResult(async () => {
      throw new AqError('AQ_PROFILE_NOT_FOUND', 'v1 unknown');
    });
    const r = await wrapped();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_PROFILE_NOT_FOUND');
  });
});

describe('known code registry', () => {
  it('recognises known codes', () => {
    assert.ok(isKnownCode('AQ_NOT_FOUND'));
    assert.ok(isKnownCode('AQ_PHASE_CLAIM_CONFLICT'));
    assert.ok(isKnownCode('AQ_NARRATIVE_SUPERSEDED'));
  });

  it('rejects unknown codes', () => {
    assert.equal(isKnownCode('AQ_TYPO'), false);
  });

  it('KNOWN_CODES is non-empty Set', () => {
    assert.ok(KNOWN_CODES instanceof Set);
    assert.ok(KNOWN_CODES.size > 0);
  });
});
