'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseEntitySection,
  isNoiseEntity,
  VALID_ENTITY_TYPES,
  ENTITY_STOPLIST,
} = require('../consumers/shared/entity-parser');
const { parseEntitySection: topLevel } = require('../index');

describe('parseEntitySection — exports', () => {
  it('is re-exported from the top-level package entry', () => {
    assert.equal(typeof topLevel, 'function');
    assert.equal(topLevel, parseEntitySection);
  });
});

describe('parseEntitySection — entities', () => {
  it('returns empty shape for empty/invalid input', () => {
    assert.deepEqual(parseEntitySection(''), { entities: [], relations: [] });
    assert.deepEqual(parseEntitySection(null), { entities: [], relations: [] });
    assert.deepEqual(parseEntitySection(undefined), { entities: [], relations: [] });
    assert.deepEqual(parseEntitySection(42), { entities: [], relations: [] });
  });

  it('parses a single entity line with name|type|aliases', () => {
    const out = parseEntitySection('ENTITY: PostgreSQL | tool | Postgres, PG');
    assert.equal(out.entities.length, 1);
    assert.equal(out.entities[0].name, 'PostgreSQL');
    assert.equal(out.entities[0].type, 'tool');
    assert.deepEqual(out.entities[0].aliases, ['Postgres', 'PG']);
    assert.ok(out.entities[0].normalizedName);
  });

  it('coerces unknown types to "other"', () => {
    const out = parseEntitySection('ENTITY: Foo | notatype | -');
    assert.equal(out.entities[0].type, 'other');
  });

  it('accepts all VALID_ENTITY_TYPES', () => {
    const lines = [...VALID_ENTITY_TYPES].map((t, i) => `ENTITY: Name${i} | ${t} | -`).join('\n');
    const out = parseEntitySection(lines);
    assert.equal(out.entities.length, Math.min(VALID_ENTITY_TYPES.size, 10));
  });

  it('deduplicates by normalized name', () => {
    const out = parseEntitySection(`
ENTITY: PostgreSQL | tool | -
ENTITY: postgresql | tool | -
ENTITY: POSTGRESQL | tool | -
    `);
    assert.equal(out.entities.length, 1);
  });

  it('respects maxEntities (default 10)', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `ENTITY: Name${i} | concept | -`).join('\n');
    const out = parseEntitySection(lines);
    assert.equal(out.entities.length, 10);
  });

  it('respects custom maxEntities', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `ENTITY: Name${i} | concept | -`).join('\n');
    const out = parseEntitySection(lines, { maxEntities: 3 });
    assert.equal(out.entities.length, 3);
  });

  it('handles tab-separated fields', () => {
    const out = parseEntitySection('ENTITY:\tFoo\ttool\t-');
    assert.equal(out.entities.length, 1);
    assert.equal(out.entities[0].name, 'Foo');
    assert.equal(out.entities[0].type, 'tool');
  });

  it('clamps names longer than 200 chars', () => {
    const longName = 'X'.repeat(500);
    const out = parseEntitySection(`ENTITY: ${longName} | concept | -`);
    assert.equal(out.entities[0].name.length, 200);
  });

  it('drops stoplist entities', () => {
    for (const noise of ['api', 'db', 'assistant', 'bash', 'diff']) {
      const out = parseEntitySection(`ENTITY: ${noise} | tool | -`);
      assert.equal(out.entities.length, 0, `should drop ${noise}`);
    }
  });

  it('drops file paths, dotfiles, file extensions, CLI flags', () => {
    const noise = [
      'ENTITY: ./src/foo.js | doc | -',
      'ENTITY: ~/.claude/config | doc | -',
      'ENTITY: .env | doc | -',
      'ENTITY: index.js | doc | -',
      'ENTITY: --verbose | concept | -',
      'ENTITY: -f | concept | -',
    ];
    for (const line of noise) {
      const out = parseEntitySection(line);
      assert.equal(out.entities.length, 0, `should drop: ${line}`);
    }
  });

  it('drops CJK-unit numeric noise but keeps legit entities', () => {
    assert.equal(parseEntitySection('ENTITY: 120秒超時 | metric | -').entities.length, 0);
    assert.equal(parseEntitySection('ENTITY: 22M | metric | -').entities.length, 0);
    assert.equal(parseEntitySection('ENTITY: 401錯誤 | metric | -').entities.length, 0);
    // legit:
    assert.equal(parseEntitySection('ENTITY: 3M | org | Minnesota Mining').entities.length, 1);
  });

  it('drops opaque long numeric IDs', () => {
    const out = parseEntitySection('ENTITY: 1234567890123 | other | -');
    assert.equal(out.entities.length, 0);
  });

  it('drops entities normalizing to length < 2', () => {
    const out = parseEntitySection('ENTITY: X | concept | -');
    assert.equal(out.entities.length, 0);
  });

  it('aliases: "-" means none', () => {
    const out = parseEntitySection('ENTITY: Foo | concept | -');
    assert.deepEqual(out.entities[0].aliases, []);
  });

  it('aliases: empty field means none', () => {
    const out = parseEntitySection('ENTITY: Foo | concept |');
    assert.deepEqual(out.entities[0].aliases, []);
  });

  it('ignores non-ENTITY/non-RELATION lines', () => {
    const out = parseEntitySection(`
some junk
ENTITY: Foo | concept | -
more junk
    `);
    assert.equal(out.entities.length, 1);
  });

  it('is case-insensitive on ENTITY: prefix', () => {
    const out = parseEntitySection('entity: Foo | concept | -\nEntity: Bar | concept | -');
    assert.equal(out.entities.length, 2);
  });
});

describe('parseEntitySection — relations', () => {
  it('parses RELATION and keeps only pairs where both entities exist', () => {
    const out = parseEntitySection(`
ENTITY: Alice | person | -
ENTITY: Bob | person | -
RELATION: Alice | Bob
RELATION: Alice | Ghost
    `);
    assert.equal(out.entities.length, 2);
    assert.equal(out.relations.length, 1);
    assert.equal(out.relations[0].src, 'Alice');
    assert.equal(out.relations[0].dst, 'Bob');
  });

  it('deduplicates unordered pairs', () => {
    const out = parseEntitySection(`
ENTITY: Alpha | concept | -
ENTITY: Beta | concept | -
RELATION: Alpha | Beta
RELATION: Beta | Alpha
    `);
    assert.equal(out.entities.length, 2);
    assert.equal(out.relations.length, 1);
  });

  it('drops self-loops', () => {
    const out = parseEntitySection(`
ENTITY: Foobar | concept | -
RELATION: Foobar | Foobar
    `);
    assert.equal(out.relations.length, 0);
  });

  it('drops empty src or dst', () => {
    const out = parseEntitySection(`
ENTITY: Foobar | concept | -
RELATION: Foobar |
RELATION: | Foobar
    `);
    assert.equal(out.relations.length, 0);
  });

  it('respects maxRelations (default 15)', () => {
    const entities = Array.from({ length: 8 }, (_, i) => `ENTITY: E${i} | concept | -`);
    const pairs = [];
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) pairs.push(`RELATION: E${i} | E${j}`);
    const out = parseEntitySection([...entities, ...pairs].join('\n'));
    assert.ok(out.relations.length <= 15);
  });
});

describe('isNoiseEntity + stoplist membership', () => {
  it('stoplist contains critical generics', () => {
    assert.ok(ENTITY_STOPLIST.has('api'));
    assert.ok(ENTITY_STOPLIST.has('db'));
    assert.ok(ENTITY_STOPLIST.has('assistant'));
  });

  it('flags file extensions', () => {
    assert.equal(isNoiseEntity('foo.js', 'foo.js'), true);
    assert.equal(isNoiseEntity('server.py', 'server.py'), true);
  });

  it('does not flag legit short CJK names', () => {
    assert.equal(isNoiseEntity('小米', '小米'), false);
    assert.equal(isNoiseEntity('阿里', '阿里'), false);
  });
});
