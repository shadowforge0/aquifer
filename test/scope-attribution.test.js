'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildScopeEnvelope,
  getScopeByEnvelopeId,
} = require('../core/scope-attribution');

describe('scope attribution envelope resolver', () => {
  it('builds deterministic slots, labels, and allowed scope keys from runtime facts', () => {
    const envelope = buildScopeEnvelope({
      host: { key: 'openclaw', label: 'OpenClaw' },
      workspace: { path: '/home/mingko', label: 'Mingko Workspace' },
      project: { key: 'aquifer', label: 'Aquifer' },
      repo: { path: '/home/mingko/projects/aquifer', label: 'Aquifer Repo' },
      session: { id: 'sess-42', label: 'Codex Recovery Session' },
      task: { id: 'task-9', label: 'Deterministic Scope Resolver' },
    });

    assert.equal(envelope.policyVersion, 'scope_envelope_v1');
    assert.equal(envelope.activeSlotId, 'repo');
    assert.equal(envelope.activeScopeKey, 'repo:/home/mingko/projects/aquifer');
    assert.deepEqual(envelope.allowedScopeKeys, [
      'global',
      'host_runtime:openclaw',
      'workspace:/home/mingko',
      'project:aquifer',
      'repo:/home/mingko/projects/aquifer',
    ]);
    assert.deepEqual(envelope.slots.map(scope => scope.id), [
      'host',
      'workspace',
      'project',
      'repo',
      'session',
      'task',
    ]);
    assert.deepEqual(getScopeByEnvelopeId(envelope, 'host').allowedScopeKeys, [
      'global',
      'host_runtime:openclaw',
    ]);
    assert.deepEqual(getScopeByEnvelopeId(envelope, 'project').allowedScopeKeys, [
      'global',
      'host_runtime:openclaw',
      'workspace:/home/mingko',
      'project:aquifer',
    ]);
    assert.equal(getScopeByEnvelopeId(envelope, 'workspace').label, 'Mingko Workspace');
    assert.equal(getScopeByEnvelopeId(envelope, 'repo').label, 'Aquifer Repo');
    assert.equal(getScopeByEnvelopeId(envelope, 'session').scopeKey, 'session:sess-42');
    assert.equal(getScopeByEnvelopeId(envelope, 'task').scopeKey, 'task:task-9');
    assert.throws(
      () => getScopeByEnvelopeId(envelope, 'missing'),
      /Unknown scope envelope id: missing/,
    );
  });

  it('keeps Aquifer repo and OpenClaw host distinct while ignoring default-model collisions', () => {
    const envelope = buildScopeEnvelope({
      host: { name: 'OpenClaw' },
      workspace: '/home/mingko/projects',
      project: { name: 'Aquifer' },
      repo: { path: '/home/mingko/projects/aquifer' },
      model: { id: 'default', label: 'Aquifer' },
    });

    assert.deepEqual(envelope.slots.map(scope => scope.id), [
      'host',
      'workspace',
      'project',
      'repo',
    ]);
    assert.equal(getScopeByEnvelopeId(envelope, 'host').scopeKey, 'host_runtime:openclaw');
    assert.equal(getScopeByEnvelopeId(envelope, 'project').scopeKey, 'project:aquifer');
    assert.equal(getScopeByEnvelopeId(envelope, 'repo').scopeKey, 'repo:/home/mingko/projects/aquifer');
    assert.ok(envelope.allowedScopeKeys.every(scopeKey => !scopeKey.startsWith('model:')));
    assert.ok(!('model' in envelope.scopeById));
  });

  it('keeps session and task slots non-promotable even when they are present', () => {
    const envelope = buildScopeEnvelope({
      project: { key: 'aquifer' },
      session: { id: 'sess-99', title: 'Transient repair session' },
      task: { id: 'task-77', title: 'Do not promote me' },
    });

    assert.equal(envelope.activeSlotId, 'project');
    assert.equal(envelope.activeScopeKey, 'project:aquifer');
    assert.deepEqual(envelope.allowedScopeKeys, [
      'global',
      'project:aquifer',
    ]);
    assert.equal(getScopeByEnvelopeId(envelope, 'session').promotable, false);
    assert.equal(getScopeByEnvelopeId(envelope, 'task').promotable, false);
    assert.deepEqual(getScopeByEnvelopeId(envelope, 'session').allowedScopeKeys, envelope.allowedScopeKeys);
    assert.deepEqual(getScopeByEnvelopeId(envelope, 'task').allowedScopeKeys, envelope.allowedScopeKeys);
    assert.ok(!envelope.allowedScopeKeys.includes('session:sess-99'));
    assert.ok(!envelope.allowedScopeKeys.includes('task:task-77'));
  });
});
