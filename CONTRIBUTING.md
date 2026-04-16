# Contributing to Aquifer

Short conventions for keeping the library honest. Follow these or propose a change — don't silently deviate.

## Setup

```bash
npm install                                     # installs deps + sets up git hooks
# the `prepare` script points git at .githooks/ so pre-commit runs automatically
```

If you cloned before the `prepare` script existed:

```bash
git config core.hooksPath .githooks
```

## Pre-commit gate

`.githooks/pre-commit` runs on every commit:

1. `node --test test/*.test.js` — full unit + integration-friendly suite
2. `eslint` — lint

Both must pass. If you need to bypass in emergency, use `git commit --no-verify` and open an issue explaining why.

## PR checklist

- [ ] All tests green locally (`npm test`)
- [ ] Lint clean (`npm run lint`)
- [ ] **Bug fix?** Include a regression test that fails on `main` and passes on your branch
- [ ] **New public API or behavior change?** Include a contract test asserting the new invariant
- [ ] **Schema change?** Migration is idempotent and covered by `test/schema-contract.test.js` or an integration test
- [ ] **Removed API?** Search for stale references in `README.md`, `README_TW.md`, `README_CN.md`, `docs/`

## Test-first for bug fixes

When fixing a bug:

1. Write a failing test that reproduces the bug
2. Verify it fails on the current code (red)
3. Fix the code until the test passes (green)
4. Commit test + fix together

This isn't full TDD — you don't need to test-first every line. But **never ship a bug fix without a regression test**. The test is the proof the bug is real and the proof it stays fixed.

## Contract tests for public API

Every method returned by `createAquifer` has a contract with callers. When adding or changing one, write a test that pins down the contract: inputs, outputs, error shape, side effects. Examples live in `test/integration.test.js` (describe blocks numbered 1–8) and `test/fts-config.test.js`.

If an audit surfaces a contract violation, the fix includes:
1. A contract test encoding the intended behavior
2. The code change making it pass
3. Tests covering adjacent edges that might drift next

## Audit cadence

Periodic full audits (e.g. running Explore agents across the codebase) are release gates, not routine work. Run them before a version bump. Between versions, trust the pre-commit gate + PR checklist — if they fail to catch something, the process was missing a contract, so add one.

## Integration tests

`test/integration.test.js` needs a Postgres with pgvector + pg_trgm:

```bash
AQUIFER_TEST_DB_URL="postgresql://user:pass@localhost:5432/db" node --test test/integration.test.js
```

The suite creates a randomized schema per describe block and drops it on teardown; safe to run against a shared dev DB.

## Style

- CommonJS, `'use strict'` at the top of every file
- No new dependencies without discussion
- Comments explain *why*, not *what*; if the code needs comments to be readable, refactor instead
- Error messages include the identifier(s) involved (`sessionId`, `agentId`, etc.) — log greppability matters
