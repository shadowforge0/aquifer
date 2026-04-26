'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveApplicableRecords } = require('../core/memory-bootstrap');

const activeScope = {
  activeScopePath: ['global', 'user:mk', 'workspace:/home/mingko', 'project:aquifer', 'session:current'],
  activeScopeKey: 'session:current',
};

describe('v1 scope inheritance', () => {
  it('uses the narrowest winner for defaultable/exclusive records', () => {
    const records = [
      {
        id: 'global-pref',
        canonicalKey: 'preference:language',
        scopeKey: 'global',
        inheritanceMode: 'defaultable',
      },
      {
        id: 'user-pref',
        canonicalKey: 'preference:language',
        scopeKey: 'user:mk',
        inheritanceMode: 'defaultable',
      },
      {
        id: 'project-pref',
        canonicalKey: 'preference:language',
        scopeKey: 'project:aquifer',
        inheritanceMode: 'defaultable',
      },
    ];

    const applicable = resolveApplicableRecords(records, activeScope);
    assert.deepEqual(applicable.map(r => r.id), ['project-pref']);
  });

  it('merges additive records and keeps non-inheritable records local', () => {
    const records = [
      {
        id: 'global-constraint',
        canonicalKey: 'constraint:no-secrets-global',
        scopeKey: 'global',
        inheritanceMode: 'additive',
      },
      {
        id: 'project-constraint',
        canonicalKey: 'constraint:no-raw-recall',
        scopeKey: 'project:aquifer',
        inheritanceMode: 'additive',
      },
      {
        id: 'other-session-note',
        canonicalKey: 'decision:only-this-session',
        scopeKey: 'session:old',
        inheritanceMode: 'non_inheritable',
      },
      {
        id: 'current-session-note',
        canonicalKey: 'decision:only-this-session',
        scopeKey: 'session:current',
        inheritanceMode: 'non_inheritable',
      },
    ];

    const applicable = resolveApplicableRecords(records, activeScope);
    assert.deepEqual(
      applicable.map(r => r.id).sort(),
      ['current-session-note', 'global-constraint', 'project-constraint'].sort(),
    );
  });

  it('does not leak host-runtime records outside active scope path', () => {
    const records = [
      {
        id: 'host-private',
        canonicalKey: 'state:terminal-secret',
        scopeKey: 'host_runtime:codex',
        inheritanceMode: 'non_inheritable',
      },
    ];

    const applicable = resolveApplicableRecords(records, activeScope);
    assert.deepEqual(applicable, []);
  });

  it('defaults to global scope only when no active scope is supplied', () => {
    const records = [
      {
        id: 'global-default',
        canonicalKey: 'decision:global',
        scopeKey: 'global',
        inheritanceMode: 'defaultable',
      },
      {
        id: 'other-project',
        canonicalKey: 'decision:project',
        scopeKey: 'project:other',
        inheritanceMode: 'defaultable',
      },
      {
        id: 'other-additive',
        canonicalKey: 'constraint:project',
        scopeKey: 'project:other',
        inheritanceMode: 'additive',
      },
    ];

    const applicable = resolveApplicableRecords(records);
    assert.deepEqual(applicable.map(r => r.id), ['global-default']);
  });
});
