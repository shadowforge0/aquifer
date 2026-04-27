# Changelog

All notable changes to `@shadowforge0/aquifer-memory` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project uses semantic versioning.

## [1.6.0] - 2026-04-28

### Added

- Curated memory serving path for `session_recall` and `session_bootstrap`,
  with active scope config/env/tool arguments and explicit rejection of
  legacy-only filters in curated mode.
- `memory_feedback` for append-only curated memory feedback, separate from
  legacy `session_feedback`.
- `evidence_recall` as an explicit audit/debug boundary for legacy evidence
  search.
- Operator-safe `compact` / compaction jobs for scoped dry-run and apply
  workflows, plus archive distillation that stays low-authority and invisible
  until normal promotion gates pass.
- DB-backed Codex finalization, handoff, import recovery, and SessionStart
  recovery surfaces.

### Changed

- MCP public surface now exposes eight tools: `session_recall`,
  `evidence_recall`, `session_feedback`, `memory_feedback`,
  `feedback_stats`, `session_bootstrap`, `memory_stats`, and
  `memory_pending`.
- Package, README, setup docs, config examples, and release gates now describe
  the curated serving rollout and rollback controls.

## [1.5.12] - 2026-04-25

### Changed

- Public package files are now whitelisted to generic Aquifer entrypoints:
  core, pipeline, schema, CLI/MCP/OpenClaw/OpenCode/Claude Code adapters,
  shared consumer helpers, and the default persona.
- `consumers/claude-code` no longer imports a Miranda context injector.
  Callers must supply `contextInjector` / `computeInjection`.
- Default persona summary parsing now uses `consumers/shared/summary-parser`
  instead of importing Miranda prompt internals.
- Default persona daily-entry table names are now validated and quoted before
  SQL construction.
- Shared recap parsing preserves safe named `OPEN` owners instead of collapsing
  them to `unknown`.
- `./consumers/miranda` remains exported as a deprecated compatibility shim.
  The shim delegates to the private `@mingko/aquifer-miranda-adapter` package
  when that adapter is installed.
- `session_summaries.model` is nullable in schema, while storage uses an
  `unknown` insert fallback so legacy NOT NULL installs do not fail before
  migration converges.

### Removed

- Removed npm lifecycle `prepare` side effect that configured
  `core.hooksPath`; contributors can run `npm run hooks:install`
  explicitly.
- Removed unreproducible LongMemEval benchmark claims from README and this
  changelog until the benchmark harness and reproduction instructions are
  published.
- Removed dated internal planning specs from the package worktree.

### Compatibility note

- Miranda deployment code now lives outside the public Aquifer package. Existing
  `./consumers/miranda` imports still resolve, but callers must install/use the
  private `@mingko/aquifer-miranda-adapter` package for Miranda-specific runtime
  behavior.

## [1.5.11] - 2026-04-21

Removes a dead legacy helper from `core/insights`. No runtime or schema
change for the supported top-level API (`require('@shadowforge0/aquifer-memory')`).
The removal affects only unsupported deep-import paths and the
`createInsights()._internal` escape hatch — neither is a semver-stable
surface.

### Removed

- `defaultIdempotencyKey` has been deleted from `core/insights.js`
  (function body, `module.exports` entry, and `_internal` field on the
  factory return). `commitInsight` has used the canonical-aware
  `revisionIdempotencyKey` (module-private) since the 1.5.x
  canonical-key work; `defaultIdempotencyKey` had a divergent formula
  (`tenantId|agentId|type|title|body|sessions|window`) that never
  matched what landed in `idempotency_key`. Keeping it importable was a
  reliability trap for any consumer reaching into unsupported paths and
  pre-computing keys — those keys would never have matched a real row.
- The `defaultIdempotencyKey` describe block in `test/insights.test.js`
  (four cases covering the legacy helper) has been removed. Real
  idempotency contract coverage now lives in a new unit test covering
  `commitInsight`'s auto-generated key stability, the existing
  `commitInsight` input validation block, and the 11-case
  semantic-dedup integration suite added in 1.5.10.

### Added

- `test/insights.test.js` — one unit test exercising `commitInsight`'s
  auto-generated idempotency key: identical inputs produce identical
  keys (replay returns the existing row); mutating `body` or the
  evidence window produces distinct keys. Guards against accidental
  formula drift in `revisionIdempotencyKey` without exposing the helper.

### Reviewed — unchanged

- `defaultCanonicalKey` stays exported. It is a real public API used by
  `scripts/backfill-canonical-key.js` and represents the stable claim
  identity (`canonical_key_v2`) that `commitInsight` depends on.
- `idx_insights_source_sessions` (partial GIN on `status='active'`)
  stays. The partial filter caps overhead to the active working set and
  the intent comment (`who-references-which-session, for audit /
  re-extraction`) matches ad-hoc audit SQL used during shadow-mode
  debugging.

### Surface note for unsupported imports

`package.json` declares an explicit `exports` map that does NOT include
`./core/insights`, so `require('@shadowforge0/aquifer-memory/core/insights')`
is not a supported entry point and will fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED` under Node 16.9+ defaults. Likewise the
`_internal` field on `createInsights(...)` is named that way
deliberately — its members are not covered by semver. Callers reaching
past the top-level `index.js` should expect shape changes without
warning.

## [1.5.10] - 2026-04-21

Adds a semantic-dedup layer to `insights.commitInsight`, closes a
silent-dead-config bug in the CLI/MCP consumer factory, and ships a
one-shot backfill script for legacy rows that predate
`canonical_key_v2`. Opt-in via `insights.dedup.mode`; default `off`,
so existing consumers see no behaviour change until they flip the
switch.

Motivation: the 1.5.3 canonical-identity layer depends on the
extractor LLM emitting a stable `canonicalClaim`. Empirical data from
the first weekly distill (11 baseline + 10 new insights on
2026-04-20) showed ~7/10 of the new rows were semantic duplicates of
baseline rows, but all had distinct `canonical_key_v2` because the
LLM produced different phrasings of the same claim. Canonical dedup
is necessary but not sufficient; a semantic tier catches what title
drift leaks through.

### Added — `core/insights.js`

- **Step B' semantic dedup** inside `commitInsight`, between the
  existing canonical lookup (Step B) and the INSERT. Triggers only
  when canonical lookup missed AND `dedup.mode !== 'off'` AND an
  `embedFn` is available. Candidate selection is
  `ORDER BY embedding <=> $vec LIMIT 1` scoped to
  `(tenant, agent, type)` with `status='active' AND embedding IS NOT NULL`;
  cosine is derived as `1.0 - (embedding <=> $vec)` in SQL (no JS
  re-computation, no double floating-point drift). Type is a hard
  gate via the WHERE clause — never merges across
  preference / pattern / frustration / workflow.
- **`mode='enforce'`** — match ≥ threshold supersedes the candidate
  (`status='superseded'`, `superseded_by=newId` via the existing
  best-effort UPDATE at the bottom of commitInsight) and the new row
  records `metadata.dedupVia='semantic'` +
  `metadata.dedupCandidate={id, cosine}`.
- **`mode='shadow'`** — no supersede, no state change on the candidate
  row; the new row records `metadata.shadowMatch={candidateId, cosine,
  threshold, candidateTitle, candidateBody, wouldSupersede, staleReplay,
  ranAt}` with title truncated to 200 chars and body truncated-and-
  whitespace-collapsed to 200 chars. Shadow ALWAYS inserts the new row
  and writes metadata, even when the enforce-mode twin would have
  returned `duplicate:true` via the stale-replay guard — the
  `staleReplay:true` flag surfaces that case to reviewers instead of
  silently dropping the incoming insight. Operators can inspect
  would-be merges without any JOIN.
- **Close band** — when `closeBandFrom <= cosine < cosineThreshold`,
  new row metadata records `dedupNear={candidateId, cosine, threshold,
  closeBandFrom, candidateTitle, candidateBody}`. No supersede, no
  status change. Surfaces tuning candidates during shadow-mode review.
- **`metadata.dedupSkipped='embed_failed'`** when `embedFn` throws
  during Step B'. Clean INSERT proceeds without the semantic path;
  semantic recall still degrades gracefully per the existing non-fatal
  embed contract.
- **Stale-replay guard inherits** — when the candidate's
  `evidence_window` upper is newer than the incoming `to` timestamp,
  returns `duplicate:true` with the existing row and skips INSERT,
  mirroring the canonical-path Rule 4 behaviour at line 278.
- **`dedup` parameter on `createInsights({...})`** — resolved through
  `resolveDedupConfig(dedup, embedFn)` which: normalises shorthand
  (`true` → `{mode:'enforce',...}`, `false` → `{mode:'off',...}`);
  trims + lowercases `mode` with invalid-value warn-and-coerce-to-off;
  validates numeric thresholds (NaN → default, out-of-[0,1] clamp,
  out-of-recommended-[0.75, 0.95] warn-and-keep); auto-adjusts
  `closeBandFrom` when it's not strictly below `cosineThreshold`;
  honours `process.env.AQUIFER_INSIGHTS_DEDUP_MODE` as a runtime
  override of `mode` (and only `mode`) so operators can kill-switch
  the feature without a code redeploy.
- **Startup log** — a single `[aquifer] insights dedup: mode=…
  threshold=… close_band_from=…` line at `createInsights()` init when
  `mode !== 'off'`. Off mode stays silent. Missing `embedFn` warn is
  emitted once at startup, not per-commit.
- **NULL-canonical check** — fire-and-forget startup probe that warns
  (once) if `count(canonical_key_v2 IS NULL AND status='active') > 0`,
  pointing at `scripts/backfill-canonical-key.js`.
- **`truncate`** / **`truncateNormalized`** private helpers — 200-char
  snippet truncation for `shadowMatch` / `dedupNear` payloads; the
  normalised variant collapses whitespace so multi-line body fragments
  read cleanly in metadata.
- **Dead-code cleanup** — duplicate first-copy definitions of
  `_normalizeText`, `normalizeCanonicalClaim`, `normalizeBody`,
  `normalizeEntitySet`, `defaultCanonicalKey` at lines 38-85 removed.
  The second copies at 100-133 already shadowed them; exports and
  behaviour are unchanged.

### Added — `consumers/shared/config.js`

- `DEFAULTS.insights.dedup = {mode:'off', cosineThreshold:0.88,
  closeBandFrom:0.85}`. `DEFAULTS.insights.recallWeights` /
  `recencyWindowDays` explicit null defaults documented.
- Three new env-var mappings: `AQUIFER_INSIGHTS_DEDUP_MODE`,
  `AQUIFER_INSIGHTS_DEDUP_COSINE` (→ `Number`),
  `AQUIFER_INSIGHTS_DEDUP_CLOSE_BAND_FROM` (→ `Number`).
- Shorthand normalisation after programmatic overrides merge:
  `insights.dedup: true|false` expands to the full object with
  `mode='enforce'|'off'` and default thresholds.

### Added — `scripts/backfill-canonical-key.js`

One-shot standalone CLI for pre-1.5.3 rows with `canonical_key_v2 IS
NULL`. Reuses `defaultCanonicalKey` from `core/insights` as the single
source of truth for normalisation + hashing. Args:
`--schema`, `--agent` (or `--all-agents`), `--tenant-id` (default
`AQUIFER_TENANT_ID` or `'default'`), `--batch-size` (1..1000, default
50), `--dry-run`. Updates are guarded by
`WHERE canonical_key_v2 IS NULL` so re-runs and concurrent live writes
converge without races. Metadata flag
`{canonicalBackfill: 'title_deterministic'}` is merged into each
updated row. Id-watermark cursor prevents infinite loops on dry-run
or all-skip batches.

Invocation:
```bash
DATABASE_URL="postgresql://..." \
  node node_modules/@shadowforge0/aquifer-memory/scripts/backfill-canonical-key.js \
  --schema miranda --agent main [--dry-run]
```

Rationale for JS-not-SQL: production PG ships without `pgcrypto`,
and matching JS's Unicode NFKC normalisation in pure SQL is fragile.
Single source of truth lives in `core/insights.js`.

### Fixed — `consumers/shared/factory.js`

- `createAquiferFromConfig()` now passes `insights: config.insights`
  into `createAquifer({...})`. Pre-existing bug since 1.4.0:
  `config.insights.recallWeights` / `recencyWindowDays` from config
  file or env were silently dropped for CLI / MCP consumers. Only
  code paths that called `createAquifer()` directly (e.g. the Miranda
  gateway's `consumers/miranda/instance.js`) were unaffected. Folded
  into this release because the dedup config would have shared the
  same fate.

### Config surface

New `insights.dedup` group under `createAquifer({insights:{dedup:{...}}})`:

| Key | Type | Default | Env |
|-----|------|---------|-----|
| `mode` | `'off' \| 'shadow' \| 'enforce'` | `'off'` | `AQUIFER_INSIGHTS_DEDUP_MODE` |
| `cosineThreshold` | number | `0.88` | `AQUIFER_INSIGHTS_DEDUP_COSINE` |
| `closeBandFrom` | number | `0.85` | `AQUIFER_INSIGHTS_DEDUP_CLOSE_BAND_FROM` |

**Precedence exception**: for `mode` only, the env var wins over
`createAquifer({...})` programmatic config. This is an intentional
carve-out so an operator can force `mode='off'` at runtime without
pushing new code. `cosineThreshold` / `closeBandFrom` follow the
standard Aquifer order (programmatic > env > file > defaults).

### Tests

- `test/insights.test.js` — +18 unit cases covering `resolveDedupConfig`
  validation matrix (shorthand, NaN, out-of-range clamp, adjusted
  closeBandFrom, env-wins exception), Step B' branching
  (mode=off bypass, enforce supersede, shadow metadata-only,
  close-band no-merge, embed-failure, no-candidate), metadata
  shape invariants (shadow never writes `dedupVia`, enforce never
  writes `shadowMatch`).
- `test/insights-semantic-dedup.integration.test.js` — new file, 9
  real-PG integration cases against a random schema built via
  `aquifer.init()`. Seeds 10 rows with crafted 1024-dim unit vectors
  so cosine values are deterministic against the HNSW `<=>` operator;
  tolerance `< 0.005` on cosine assertions absorbs HNSW approximation.
  Covers the full matrix: enforce supersede, threshold-edge, close
  band, shadow side-effect-free snapshot, distant vector, embed
  failure, cross-agent isolation, cross-type isolation, and legacy
  NULL-canonical semantic catch.
- `test/config.test.js` — +9 cases for `insights.dedup` defaults, env
  mapping, shorthand, partial override, and null-preservation of
  `recallWeights` / `recencyWindowDays`.
- Full suite with `AQUIFER_TEST_DB_URL`: 1101/1101 green (was 1065
  before this PR).

### Migration notes

- **Opt-in**: default `mode='off'` means no behaviour change until an
  operator flips the env var or passes `insights.dedup` explicitly.
- **Run backfill before enabling** — the semantic path tolerates
  legacy `canonical_key_v2 IS NULL` rows (it catches them via
  embedding anyway), but the canonical lookup path skips them, and
  the startup warn will nag every restart until resolved. One-shot:

  ```bash
  DATABASE_URL=... \
    node scripts/backfill-canonical-key.js --schema <schema> --agent <id>
  ```

  Repeat per schema (miranda + jenny + any tenant-specific schemas).
- **Recommended rollout**: shadow for 1 weekly cycle, inspect
  `SELECT metadata->>'shadowMatch' FROM insights WHERE metadata ? 'shadowMatch'`
  for false positives, then flip to `enforce`. Kill-switch:
  `AQUIFER_INSIGHTS_DEDUP_MODE=off` + restart.
- **No schema change** — all required columns (`canonical_key_v2`,
  `embedding vector(1024)`) and the partial HNSW index ship since
  1.5.3. `npm install` + restart is enough on the code side.

## [1.5.9] - 2026-04-20

Docs-only patch. The 1.5.8 tarball shipped with a pre-1.5.6 README
and three new public surfaces (`aquifer.init()`, the canonical/revision
`insights.commitInsight` contract, the `migrations` config block) were
invisible to anyone reading the npm registry page. This release
republishes with the already-landed triple-language README updates so
the registry matches the repo.

No code change. Tarball layout, exports, and runtime behaviour are
byte-identical to 1.5.8 aside from the README files.

## [1.5.8] - 2026-04-20

Follow-up patch for two issues exposed while tidying the suite after
1.5.7 shipped: (1) sessions committed without explicit timestamps
disappeared from `bootstrap()` because the 1.5.5 ended_at treat-root-cause
fix dropped the INSERT default; (2) `[aquifer] migration` post-flight
notices on stdout corrupted CLI consumers that parse stdout as JSON.

### Changed

- **`core/storage.js`** — `upsertSession` INSERT defaults
  `started_at = COALESCE($13, now())` and
  `ended_at = COALESCE($14, now())`. `last_message_at` still passes
  the raw `$14`: null from caller stays null in EXCLUDED so the
  UPDATE path's `COALESCE(EXCLUDED.last_message_at, …)` preserves
  prior values (1.5.5 regression lock holds). Net effect: fresh
  commits without explicit timestamps now surface in bootstrap;
  re-commits without `lastMessageAt` still do not overwrite
  existing ended_at with now().
- **`core/aquifer.js`** — migration post-flight logs
  (`[aquifer] FTS post-flight: …`, warmup note,
  `[aquifer] migration notice: …`) redirected from `console.info`
  to `process.stderr.write`. Operator messages belong on stderr;
  stdout stays clean for downstream JSON consumers (CLI / MCP).
  `console.warn` paths for WARNING/ERROR notices and FTS probe
  failure unchanged (already on stderr).

### Test suite hygiene (not user-facing)

- `test/integration.test.js` / `test/consumer-cli.integration.test.js` /
  `test/consumer-mcp.integration.test.js` — embed mocks widened from
  3-dim to 1024-dim to match the post-1.5.2 schema. Previous mocks
  provoked PG `expected 1024 dimensions, not 3` at write time and
  left ~11 integration tests red under `AQUIFER_TEST_DB_URL`.
- `test/integration.test.js` — `recall 空 query 回傳 []` renamed and
  flipped to assert `rejects(/must be a non-empty string/)` per the
  1.4.0 contract change.
- `test/hrr-feature-edge.test.js` — open-loop score equality assertion
  loosened from `strictEqual` to `abs(diff) < 1e-6` to absorb the
  ~1e-10 time-decay FP drift between back-to-back `hybridRank` calls.
- Full suite with `AQUIFER_TEST_DB_URL`: 1065/1065 green (was
  1013/1024/1035 before these fixes; 11 pre-existing collateral
  failures + 41 cancelled children now all pass).

### Migration notes

- No schema change, no data rewrite.
- Operators who parse aquifer's `stdout` for operator-log chatter will
  need to switch to `stderr`. The `migrations.onEvent` callback is the
  supported observability path and is unchanged.

## [1.5.7] - 2026-04-20

C2 gateway migrate handshake — hosts now have a real startup contract.
Previous flow relied on lazy `ensureMigrated()` inside the first tool
call, which meant: (1) the first caller paid unpredictable latency
while the migration ran, (2) a migration failure surfaced as a
cryptic error from inside `recall()`/`commit()` instead of at
startup, (3) a consumer that wanted to fail fast on pending DDL had
no hook to do so, and (4) the blocking `pg_advisory_lock()` could
hang forever if another process crashed holding the lock.

### Added — `core/aquifer.js`

- **`aquifer.init()`** — async startup handshake that returns a
  StartupEnvelope `{ ready, memoryMode: 'rw' | 'ro' | 'off',
  migrationMode, pendingMigrations, appliedMigrations, error,
  durationMs }`. Wraps the migrate() path for `apply` mode, or a
  read-only plan probe for `check` mode, or a noop for `off` mode.
- **`aquifer.listPendingMigrations()`** / **`getMigrationStatus()`** —
  returns `{ required, applied, pending, lastRunAt }` without
  executing any DDL. Uses `pg_tables` signature-probe for O(1) status.
- **Try-lock with poll + timeout** — `pg_advisory_lock()` replaced by
  `pg_try_advisory_lock()` in a poll loop (250ms poll, default 30s
  timeout). On timeout, throws `AQ_MIGRATION_LOCK_TIMEOUT` instead of
  blocking indefinitely. Defensive against test mocks: only polls when
  PG explicitly returns `ok=false`; a missing response (mock pools that
  don't model the function) is treated as acquired so suites don't hang
  on the deadline.
- **`onEvent` observability hook** — `config.migrations.onEvent` fires
  at `init_started`, `check_completed`, `apply_started`,
  `apply_succeeded`, `apply_failed` with payload
  `{ schema, mode, required, applied, pending, ddlExecuted, durationMs,
  error, notices }`. No listener → no cost.
- **`migrate()` signature widened** — still throws on failure (no
  breaking change for existing callers), but on success returns
  `{ ok: true, durationMs, notices, ddlExecuted }`.
- **`ensureMigrated()` now public** on the aquifer object as an alias
  for the internal lazy-ensure path; respects `migrations.mode`.

### Added — `consumers/shared/config.js`

- `config.migrations` section: `{ mode: 'apply' | 'check' | 'off',
  lockTimeoutMs: 30000, startupTimeoutMs: 60000, onEvent: null }`.
- Env mapping: `AQUIFER_MIGRATIONS_MODE`,
  `AQUIFER_MIGRATION_LOCK_TIMEOUT_MS`.

### Added — `consumers/shared/factory.js`

- `createAquiferFromConfig()` forwards `config.migrations` to the
  core library.

### Changed — `consumers/mcp.js`

- `main()` now calls `aquifer.init()` before `server.connect()`.
  When `migrationMode=apply` and init returns `ready=false`, the
  process aborts with a non-zero exit and a single-line structured
  error to stderr. Success prints a one-line summary.

### Added — `test/migration-handshake.integration.test.js`

- 8 integration tests gated on `AQUIFER_TEST_DB_URL`: apply mode
  drains pending, check mode reports without DDL, off mode no-op,
  `listPendingMigrations`/`getMigrationStatus` consistency,
  `AQ_MIGRATION_LOCK_TIMEOUT` surfacing under held advisory lock,
  `onEvent` lifecycle sequence.

### Migration notes

- **Default behaviour unchanged for existing code paths**. `migrate()`
  on its own still runs end-to-end DDL; the only difference is it now
  returns an envelope (old callers that `await aquifer.migrate()`
  without using the return value are unaffected).
- **MCP startup contract changed**: the process now exits non-zero if
  `migrations.mode=apply` and init() cannot reach ready. Operators who
  depend on the old lazy-migrate-on-first-tool-call behaviour should
  set `AQUIFER_MIGRATIONS_MODE=off` (plus run `migrate()` out of band)
  or `=check` (run out of band and let init() verify).
- **Phase 2 MVP scope**: only `consumers/mcp.js` is wired. The
  persona consumers (`consumers/miranda`, `consumers/default`) and
  the openclaw-plugin path still rely on lazy ensureMigrated; Phase 3
  will propagate the handshake there once the MCP path has burn-in.
- No schema change, no column rewrite.

## [1.5.6] - 2026-04-20

C1 canonical revision model for `miranda.insights` — an insight now has
a stable **canonical identity** (what it's about) and an unbounded chain
of **revisions** (how our understanding of it has refined). Prior model
conflated the two: title-hash idempotency meant a refined body under the
same title was either a duplicate-skip (losing the refinement) or a
write that diverged from every downstream reader holding the old row.
Extractor runs over overlapping windows (daily 14/50 + weekly 60/200)
kept producing near-identical insights that were either dropped as
collisions or accumulated as parallel siblings with no lineage.

### Added — `core/insights.js`

- **Pure helpers** (zero DB) — `normalizeCanonicalClaim`,
  `normalizeBody`, `normalizeEntitySet`, `defaultCanonicalKey`. Canonical
  key = sha256(`type|agentId|normalize(canonicalClaim)|sorted(entities)`).
  Whitespace / case / punctuation folding documented in-module; trailing
  punctuation tolerated. Entity set participates so the same claim about
  different subjects stays distinct.
- **`revisionIdempotencyKey(canonicalKey, body, evidenceWindow)`** —
  replaces title-hash idempotency. Rerun on same window returns the
  existing row (Rule 4 stale replay). Different body on same canonical
  opens a revision (Rule 2/3).
- **`commitInsight` four rules**:
  1. Idempotency hit → return existing (no DB write).
  2. Canonical hit, different body, newer evidence → INSERT new row
     with `canonical_key_v2 = <key>`, inline `UPDATE ... SET
     superseded_by = NEW.id, stale = true WHERE canonical_key_v2 = <key>
     AND id <> NEW.id AND stale = false`.
  3. Canonical hit, different body, older/equal evidence → still
     INSERT but do not supersede (back-fill revision).
  4. Canonical hit, same body, stale replay → return existing row
     without flipping stale.
- Preflight is two bounded SELECTs: idempotency key first, then
  canonical key. Neither holds a lock; the inline UPDATE in rule 2 does.
- Title is now best-effort display text. Fallback generation tags
  `metadata.title_source = 'fallback'` so downstream can tell.
- `parseUpperFromRange` helper parses PG tstzrange upper bound for the
  newer-evidence comparison.

### Added — `schema/006-insights.sql`

- **`canonical_key_v2 TEXT`** column — nullable (old rows have NULL, no
  retrofit).
- **`idx_insights_canonical_v2_active`** — non-unique partial index on
  `(canonical_key_v2) WHERE canonical_key_v2 IS NOT NULL AND stale =
  false`. Non-unique by design: rules 2 + inline UPDATE collapse the
  active set to at-most-one per canonical key; a unique constraint would
  require holding a lock across the INSERT/UPDATE pair.
- Column `COMMENT` documents the canonical-identity contract.

### Added — `scripts/extract-insights-from-recent-sessions.js`

- Prompt JSON schema now requires `canonicalClaim` (short factual
  predicate, the "what it's about") and `entities` array per insight.
  Prompt explains the contract (canonical identity, revision opens when
  body refines) with examples.
- `commitInsight` call forwards `canonicalClaim` and `entities` through.

### Migration notes

- **Schema-only ALTER**, no data rewrite. Existing rows keep
  `canonical_key_v2 = NULL`; revision rules only apply to rows with a
  canonical key set. Next extractor run populates canonical keys on
  newly-written rows.
- **Old rows are NOT retrofitted** — by design. Canonical claim is
  extractor-derived and we don't have it for rows written under the
  title-hash model. Natural decay: as stale rules replay over time, old
  insights supersede / age out and the active set migrates to the v2
  model.
- No index rebuild needed on large tables (new index is partial and
  covers only canonical-key-set active rows).

## [1.5.5] - 2026-04-20

Treat-root-cause fix for `miranda.sessions.ended_at` pollution. The
column was being overwritten to `now()` on every `upsertSession` /
backfill commit, so backfilled-or-re-committed sessions lost their true
last-message timestamp and collapsed to the time of the most recent
batch. Downstream recency-aware features (recall windowing, insights
evidence windows, state-change backfill) were all reading the wrong
"when did this conversation end" from the pollution.

### Changed

- **`core/storage.js`** — `upsertSession` INSERT and UPDATE paths now
  derive `ended_at = COALESCE(EXCLUDED.last_message_at, existing.ended_at)`
  instead of `ended_at = now()`. Only advances when the caller supplies
  a newer `lastMessageAt`; otherwise preserves the prior value.
- External companion fix in `extensions/afterburn/bin/backfill-normalized.js`
  (separate repo) mirrors the same COALESCE pattern so bulk backfills
  cannot re-pollute.

### Added

- **`test/session-ended-at.integration.test.js`** — three regression
  locks: (a) first commit sets ended_at from lastMessageAt, (b) re-commit
  without new lastMessageAt preserves prior ended_at, (c) backfill
  commit with older lastMessageAt does not roll ended_at backwards.
  Guards against the specific 2026-04-20 pollution re-emerging.

### Migration notes

- **Historical pollution (203 rows) was repaired in-place** on
  2026-04-20 via transactional UPDATE that recomputed `ended_at` from
  `last_message_at`. Backup kept in `miranda._backup_ended_at_20260420`.
  Fresh installs are unaffected.
- If you operate a deployment that has been on pre-1.5.5 with regular
  backfills, spot-check a few `(ended_at, last_message_at)` pairs —
  if ended_at is newer than last_message_at by more than a few seconds,
  that row was polluted; repair with
  `UPDATE miranda.sessions SET ended_at = last_message_at WHERE ended_at > last_message_at + interval '1 minute'`
  (tune the grace interval to your ingest pattern).

## [1.5.4] - 2026-04-20

Internal patch bump — consolidates the 1.5.1-1.5.3 patch series under a
single release marker before the 1.5.5 / 1.5.6 / 1.5.7 wave landed.
No additional user-facing changes beyond 1.5.3. Semver-wise the 1.5.4
tag is a no-op gate: keep operators' upgrade pins monotonic without
forcing a rebuild cycle for a content-less release.

## [1.5.3] - 2026-04-20

Prompt-quality fix + optional Claude-CLI backend for
`scripts/extract-insights-from-recent-sessions.js`.
Real-world A/B on 181 sessions showed the prior prompt produced only 3
shallow insights — all technical bug patterns (timeout, version drift,
workflow). It consistently missed META-LEVEL behavioural signals
(user preferences, discipline gaps, decision-style signatures) that are
only visible when reading multiple sessions back-to-back.

### Changed

- **`buildExtractionPrompt`** — adds a "What to look for" section
  steering the extractor toward behavioural preferences, discipline
  gaps, decision-style signatures, and workflow scaffolding. Bumps
  expected output to 6-12 insights for windows >50 sessions with >=3
  distinct themes. Reframes 0 insights as the sparse-window exception,
  not a safe fallback under uncertainty.
- Importance guidance now spreads the scale: 0.85-0.95 reserved for
  meta-level preferences + discipline gaps (highest leverage, directly
  shape agent behaviour), 0.65-0.80 for stable technical patterns /
  workflows, 0.45-0.60 for lower-leverage observations. Prior prompt
  let everything cluster at 0.70-0.85 regardless of leverage.
- Explicitly calls out that "only surfaced technical bug frustrations
  and missed meta-level behavioural signal" = failed task.

### Added

- **Claude CLI adapter** — set `AQUIFER_INSIGHTS_CLI=claude` to spawn
  `claude -p --model <m> --output-format text` instead of using a
  provider API. Uses OAuth from the user's keychain (do NOT pass
  `--bare`, which disables OAuth). Rationale: an empirical A/B on 181
  sessions showed that mid-tier models (minimax-M2.5) miss
  meta-level behavioural signals that Opus/Sonnet pick up readily. For
  a once-a-day batch job, the cost delta is small and the quality
  delta is large.
- Env knobs: `AQUIFER_INSIGHTS_CLI_MODEL` (default `opus`, alias or
  full name accepted), `AQUIFER_INSIGHTS_CLI_BIN` (default `claude`),
  `AQUIFER_INSIGHTS_CLI_TIMEOUT_MS` (default 600000).
- Script logs the active backend on start:
  `[extract-insights] llm backend: claude cli (opus)` vs
  `api provider`.

### Migration notes

- No schema change. Re-run the cron / script to re-distill with the
  new prompt. `commitInsight` idempotency key includes title + sorted
  session IDs, so new titles will write; matching old titles skip.
- Consider `TRUNCATE miranda.insights RESTART IDENTITY` before
  re-running if you want a clean baseline.
- To opt into the CLI backend on a cron, set the env vars in the
  service unit. The host running the cron must have `claude` on PATH
  and an authenticated OAuth session. `--bare` mode is NOT used — it
  would strip OAuth and force an API key, defeating the purpose.

## [1.5.2] - 2026-04-20

Extends the 1.5.1 insights-schema fix to every embedding column across
`schema/001-base.sql` and `schema/002-entities.sql`. The unsized
`vector` anti-pattern was present in four places; pgvector HNSW index
creation was permanently impossible on all of them. On installs that
migrated from a version with sized columns (e.g. miranda schema) this
happened to work; fresh installs (e.g. jenny schema) silently degraded
to sequential vector scans.

### Changed

- **`schema/001-base.sql`** — `session_summaries.embedding` and
  `turn_embeddings.embedding` are now `vector(1024)`. Both HNSW `DO`
  blocks no longer catch `invalid_parameter_value` (kept
  `feature_not_supported` / `out_of_memory` / `program_limit_exceeded`
  as safety nets).
- **`schema/002-entities.sql`** — `entities.embedding` is now
  `vector(1024)`. No HNSW yet (entity lookup is name-trgm), but the
  sized declaration means future HNSW work drops in cleanly.

### Added

- Idempotent coerce `DO` blocks in `001-base.sql` (session_summaries,
  turn_embeddings) and `002-entities.sql` (entities) that ALTER any
  existing unsized `vector` column to `vector(N)`. Mirrors the 1.5.1
  insights coerce. Dim priority: existing row dim → `aquifer.embedding_dim`
  GUC → 1024 default. Logs `[aquifer] <table>.embedding coerced from
  unsized vector to vector(N)` when triggered.
- `test/schema-contract.test.js` — three new assertion groups for
  001-base (`session_summaries` sized, `turn_embeddings` sized, coerce
  blocks present) and 002-entities (sized + coerce). Regression guard
  for the embedding-dim anti-pattern.

### Migration notes

- Re-run `aquifer.migrate()` on any deployment upgraded from pre-1.5.2.
  Coerce blocks ALTER in-place — fast for small tables, O(n × dim) for
  `turn_embeddings` at scale (each row rewritten). Plan a maintenance
  window if `turn_embeddings` has >100k rows.
- Non-1024 embedding providers: `SET LOCAL aquifer.embedding_dim =
  <dim>` before migrate(), or manually `ALTER TABLE` after install.

## [1.5.1] - 2026-04-20

Schema fix — `miranda.insights.embedding` was declared as unsized `vector`
which makes pgvector HNSW index creation permanently impossible. The
previous "defer until first embedded row" pattern was a broken diagnosis:
pgvector requires the COLUMN to have a dimension at index creation time,
not the data. A fresh 1.5.0 install would write insights rows via
`aquifer.insights.commitInsight()`, re-run migrate(), and still not get
the vector index. Operators were silently doing linear scans.

### Changed

- **`schema/006-insights.sql`** — `embedding` column is now `vector(1024)`
  (matches the ollama / bge-m3 autodetect default). Fresh installs build
  `idx_insights_embedding` HNSW on first migrate. The HNSW `DO` block now
  only catches `undefined_object` / `feature_not_supported` / OOM /
  internal-limit conditions, not `invalid_parameter_value` (which was
  masking the real schema bug).

### Added

- **`schema/006-insights.sql`** — idempotent coerce block ALTERs any
  existing unsized `vector` column to `vector(<dim>)` before HNSW build.
  Dim priority: existing row dim → `aquifer.embedding_dim` GUC → 1024.
  Logs `[aquifer] insights.embedding coerced from unsized vector to
  vector(N)` when triggered. No-op if column already sized.

### Migration notes

- Existing 1.5.0 deployments: re-run `aquifer.migrate()`. The coerce block
  will ALTER in-place (fast; table is small) and build the HNSW index.
- Non-1024 embedding providers (openai 1536, etc.): `SET LOCAL
  aquifer.embedding_dim = 1536` before `migrate()`, or manually
  `ALTER TABLE` after install. Future 1.6.x will wire this from
  `createAquifer` config.

## [1.5.0] - 2026-04-19

Chinese FTS rework — the zhcfg tsconfig was silently degrading to
char-level tokenization on Traditional-Chinese corpora because zhparser's
scws dictionary is Simplified-only and every Traditional character fell
out of vocabulary. Indexed text looked segmented (v/n tags present) but
lexemes were single chars, and `ts_rank_cd` carried no real signal — a
retro-recall-bench comparing fts-simple vs fts-zhcfg would produce a
null result on this corpus.

### Changed

- **`schema/001-base.sql`** — migration now prefers `pg_jieba` over
  `zhparser`. When `pg_jieba` is available, `zhcfg` is (re)created as a
  `COPY = public.jiebaqry` alias — search-engine mode, which indexes both
  the full compound (`記憶系統`) and its sub-components (`記憶`, `系統`)
  so a user query at any granularity matches. The trigger function's
  `to_tsvector('zhcfg', ...)` calls route to jieba without code change.
- **Cross-schema safety**: `zhcfg` is a database-wide object, but
  `migrate()`'s advisory lock is per-schema. The DO block now acquires
  a transaction-scoped global advisory lock (`pg_advisory_xact_lock`)
  around the DROP/CREATE so concurrent `migrate()` calls on different
  Aquifer schemas in the same DB don't race on the tsconfig.
- **Namespace-qualified lookups**: every `pg_ts_config` query now filters
  on `cfgnamespace = 'public'::regnamespace`, and DROP/CREATE use
  `public.zhcfg` explicitly — stops a same-named config elsewhere in
  `search_path` from confusing detection or getting overwritten.
- **Idempotent upgrade path**: an existing zhparser-backed `zhcfg` is
  DROPped and rebuilt as a jiebaqry alias on the next `migrate()` if
  `pg_jieba` is now installed. Already-jieba-backed configs are left
  alone (noop).
- **Recovery branch (S9)**: if an operator has dropped `pg_jieba` but
  `zhcfg` still points at the jieba parser, future `session_summaries`
  writes would throw `parser "jiebaqry" does not exist`. The DO block
  now detects this and either rebuilds `zhcfg` on zhparser (if
  available) or drops it so consumers fall back to `simple`.
- **Defensive EXCEPTION handler**: the entire zhcfg DO block is wrapped
  — ownership mismatches, blocked DROPs, concurrent races now
  `RAISE WARNING` and leave the existing config intact instead of
  aborting the whole `migrate()`.
- **Fallback order**: jieba → zhparser → simple. Pure Simplified
  deployments that still want zhparser keep working unchanged; the
  zhparser branch now only fires when jieba is unavailable *and* zhcfg
  hasn't been created yet. Added `eng` token type to zhparser mapping
  so English words in mixed-language text are no longer silently
  dropped (was a 1.4.0 bug, carried over and now fixed).
- **Post-flight visibility**: `migrate()` now prints a one-line summary
  after completion (`[aquifer] FTS post-flight: backend=... jieba=...
  zhparser=... selected=...`) so operators can tell whether `pg_jieba`
  actually installed or whether it silently degraded to simple —
  `RAISE NOTICE` from migration DDL is swallowed by node-postgres by
  default.

### Operator notes

- **Installing `pg_jieba`** (not in official postgres images). PG 16 example:

  ```bash
  apt-get install -y build-essential cmake git \
    libpq-dev postgresql-server-dev-16
  git clone --recursive https://github.com/jaiminpan/pg_jieba /tmp/pg_jieba
  cd /tmp/pg_jieba && mkdir build && cd build
  cmake .. && make -j"$(nproc)" && make install
  ```

  Then replace the dictionary with a Traditional-aware one:

  ```bash
  DICT=/usr/share/postgresql/16/tsearch_data/jieba_base.dict
  cp "$DICT" "$DICT.bak"
  curl -fsSL -o "$DICT" \
    https://raw.githubusercontent.com/fxsjy/jieba/master/extra_dict/dict.txt.big
  ```

  `dict.txt.big` is the jieba project's official Traditional Chinese
  dictionary (~584k entries, Traditional + Simplified). Pin a specific
  commit SHA via `https://raw.githubusercontent.com/fxsjy/jieba/<sha>/extra_dict/dict.txt.big`
  if reproducibility matters. After replacing the dict, existing
  backends keep the old one cached in memory — restart your app
  (so backends reconnect) or run `SELECT pg_terminate_backend(pid)`
  against idle connections.

- **Docker users**: after the `apt install + make install + dict swap`,
  snapshot the container:

  ```bash
  docker commit <db_container> pg-jieba:local
  ```

  Without this, a `docker compose down && up` on the stock
  `postgres:16` image loses the extension. Contributors welcome to
  upstream a Dockerfile — see issue template.

- **Re-baseline after pg_jieba updates**: `zhcfg (COPY = jiebaqry)` is a
  one-time snapshot of jiebaqry's mapping when the config was created.
  Dictionary changes propagate automatically (they live in the parser
  layer, not the config layer), but if you upgrade `pg_jieba` and its
  new version changes the *mapping* (token type → dictionary), you'll
  want to rebuild `zhcfg`: `DROP TEXT SEARCH CONFIGURATION public.zhcfg`
  then re-run `migrate()`.

- **Existing rows** keep their old (possibly char-level) `search_tsv`
  until the row is re-touched. Force a bulk reindex with
  `UPDATE <schema>.session_summaries SET summary_text = summary_text;`
  — the trigger recomputes tsv on UPDATE. On 19k+ rows this takes
  tens of seconds and holds row-level locks for the duration; run
  during a low-traffic window, or batch with
  `WHERE session_row_id % 20 = 0` (and similar offsets) if you need to
  interleave with live writes.

## [1.4.0] - 2026-04-19

Same-day double release after a full /develop pass (Discover → Define →
Develop → Deliver). Wave 1 hardens the existing recall path; Wave 2 adds two
new capability tables (entity_state_history, insights) for temporal
state-change tracking and reflection-style higher-order observations.

### Added

- **`aquifer.entityState`** — temporal state-change tracking on entities.
  - Schema: `005-entity-state-history.sql` (single table, no triggers, partial
    UNIQUE on current row, partial UNIQUE on idempotency_key).
  - API: `applyChanges(client, ...)`, `applyChangesStandalone(input)`,
    `getEntityCurrentState(...)`, `getEntityStateHistory(...)`.
  - Out-of-order backfill safe: predecessor / successor overlap check before
    inserting a closed-interval historical row, equal-timestamp rejected as
    `AQ_CONFLICT`.
  - Source-conflict (current row written by a different `source`) returns
    `AQ_CONFLICT` instead of overriding — caller decides priority.
  - Default idempotency key includes source + canonical_json(value) +
    evidenceSessionId.
- **`pipeline/extract-state-changes.js`** — opt-in LLM extraction of state
  changes from session content. Strict prompt rejects tentative language and
  requires explicit time anchors. Configured via
  `createAquifer({ stateChanges: { enabled, whitelist, promptFn,
  confidenceThreshold, timeoutMs, maxOutputTokens } })`. Default OFF.
- **enrich() integration** — when stateChanges.enabled and parsedEntities
  match the whitelist, runs extract pre-tx and applies in-tx via SAVEPOINT so
  conflicts can't poison the parent transaction.
- **`aquifer.insights`** — higher-order reflection / pattern memory.
  - Schema: `006-insights.sql` (TSTZRANGE evidence_window, unsized vector
    with HNSW deferred until first embedded row, GIN on source_session_ids).
  - API: `commitInsight(...)`, `recallInsights(query, opts)`,
    `markStale(id)`, `supersede(oldId, newId)`.
  - Insight types: `preference | pattern | frustration | workflow`.
  - Recall blends semantic × importance × recency (linear decay over
    `recencyWindowDays`, default 90, configurable).
  - Empty-query recall returns importance-blended results with linear recency
    decay (not just `ORDER BY importance DESC`).
  - `supersede` verifies tenant + agent consistency and rejects self-cycles.
  - `defaultIdempotencyKey` includes body + evidenceWindow so legitimate
    revisions aren't swallowed as duplicates.
- **`scripts/extract-insights-from-recent-sessions.js`** — standalone
  cron-runnable extractor (Route B). Reads recent sessions, single LLM call,
  commits via API. Bypasses cron-prompt JSON parsing fragility.
- **`scripts/retro-recall-bench.js`** + **`scripts/sample-bench-queries.sql`**
  — six-pipeline retro evaluation harness (fts-simple / fts-zhcfg /
  summary-vector / turn-only / hybrid / hybrid-rerank) with nDCG@5, MRR,
  p50/p95 latency, empty/judgeable rates. JSON + Markdown output.
- **`scripts/drop-entity-state-history.sql`**, **`scripts/drop-insights.sql`**
  — bitter-lesson escape hatches; both new tables are DROP CASCADE clean.
- **Selective rerank gate** — `shouldAutoRerank({query, mode, ranked,
  hasEntities, autoTrigger})` pure helper. Three-stage gate `provider ready
  + (force OR auto)`. Configurable via `createAquifer({rerank: {autoTrigger:
  {modes, minQueryChars, minQueryTokens, minResults, maxResults,
  maxTopScoreGap, alwaysWhenEntities, ftsMinResults}}})`.
  `_debug.{rerankApplied, rerankReason, rerankErrorMessage}` surfaced.
- **`storage.searchSummaryEmbeddings(pool, opts)`** — extracted from
  `core/aquifer.js` private closure into reusable export, matches
  `searchTurnEmbeddings` style.
- **`storage.searchSessions(pool, query, { ftsConfig })`** — accepts
  `'simple'` (default, BC) or `'zhcfg'` (whitelist enforced; injection-safe).
- **Consumer surface** — Miranda persona + default persona `session_recall`
  MCP tools now expose `entities`, `entity_mode`, and `mode` parameters
  (previously only available on the core API). Descriptions rewritten with
  usage guidance.

### Changed

- **`recall(query)` empty/null/undefined now THROWS** — previously returned
  `[]` silently, masking caller bugs. Throws `'aquifer.recall(query): query
  must be a non-empty string'`. Manifest + consumer tools also enforce
  `minLength: 1`. **Breaking** for callers that relied on silent empty
  return; trim and validate before calling.
- **`buildRerankDocument(row, maxChars)`** — now prefers
  `structured_summary` fields (title, overview, topics, decisions,
  open_loops) over bare `summary_text`; cross-encoder gets substantive
  Chinese content instead of short recap text.
- **zhparser FTS regression revert** — v0.6.0 had upgraded FTS from `simple`
  → zhparser; the 1.x open-source rewrite reverted to `simple`. 1.4.0
  restores zhparser. `schema/001-base.sql` migrate now creates the extension
  and `zhcfg` text search configuration (DO block with EXCEPTION fallback so
  installs without zhparser still succeed). Trigger functions in
  `001-base.sql` and `004-completion.sql` use `IF EXISTS pg_ts_config WHERE
  cfgname='zhcfg' THEN to_tsvector('zhcfg',...) ELSE to_tsvector('simple',
  ...)` runtime branch — enabling zhparser POST-install benefits new inserts
  without manual re-migrate.
- **`core/aquifer.js` migrate()** — auto-detects `ftsConfig` from
  `pg_ts_config` and threads it to `storage.searchSessions` so FTS recall
  uses zhparser when available.
- **entity boost cross-tenant safety** — `entity_sessions` boost queries
  now filter by `tenant_id` and `agentIds`. Previously the boost map was
  keyed by `session_id` alone, allowing cross-tenant pollution if multiple
  tenants emitted the same `session_id`.
- **`shouldAutoRerank.hasEntities`** — also true when query-derived entity
  matching produced a non-empty `entityScoreBySession` (not just when caller
  passed `entities` explicitly).
- **`searchSessions` LEFT JOIN → INNER JOIN** — `WHERE` already referenced
  `ss.search_text` / `ss.search_tsv`, making the LEFT semantically INNER.
  Made explicit; documented as "search-over-enriched-sessions".
- **`scripts/sample-bench-queries.sql`** — actually parametrised by
  `:"schema"` (previously `\set schema 'miranda'` was set but all `FROM
  miranda.sessions` lines hardcoded the literal). Use `psql -v
  schema=aquifer -f ...` to override.
- **`createAquifer({ insights: { recencyWindowDays } })`** — new config,
  default 90, replaces previously-hardcoded 90-day recency window in
  `recallInsights` ranking.

### Fixed

- entity_state_history out-of-order backfill no longer creates overlapping
  intervals; predecessor/successor neighbour check before insert.
- entity_state_history equal-timestamp historical conflict now rejected with
  `AQ_CONFLICT` (previously could create duplicate interval starts).
- entity_state_history `resolveEntity({entityId})` now enforces
  `entityScope` when the caller passes one (closes cross-scope read leak).
- insights `supersede(old, new)` verifies tenant + agent consistency and
  rejects self-cycle (FK alone allowed cross-tenant supersession chains).
- insights idempotency key includes body + evidenceWindow (revisions
  previously swallowed as duplicates when only body / window changed).

### Internal

- `core/entity-state.js` and `core/insights.js` follow the
  `state.js`/`narratives.js` factory + AqResult envelope conventions.
- 87 new unit tests (entity-state 27, extract-state-changes 24, insights 22,
  should-auto-rerank 12, search-summary-embeddings + fts-config 8). 862
  total tests pass; ESLint 0 errors / 0 warnings; `npm pack --dry-run` and
  `publint` clean; `npm audit` zero vulnerabilities.

### Deployment notes

- Gateways do NOT auto-migrate. After upgrading, run
  `node -e "require('@shadowforge0/aquifer-memory').createAquifer({schema:
  'miranda', entities:{enabled:true}}).migrate()"` once to land 005/006 +
  the new zhparser-aware trigger functions.
- For existing rows to benefit from zhparser segmentation, backfill
  `search_tsv` with a no-op UPDATE (`UPDATE schema.session_summaries SET
  summary_text = summary_text WHERE id BETWEEN ...`). 19355 rows in 33
  seconds in production; row-level locks only, no downtime.

## [1.3.0] - 2026-04-19

### Completion-capability API surface

Introduces 12 new capability namespaces implementing the aquifer-completion
spec. All new methods return the canonical `AqResult<T> = { ok, data } | { ok,
error: AqError }` envelope. Legacy APIs (commit/enrich/recall/feedback/etc.)
keep their throw semantics for BC — no breaking changes.

#### Added — new schema (004-completion.sql)

Pure-additive DDL, always migrated. All parameterised on `${schema}` for the
future `miranda → aquifer` rename.

- `sessions.consolidation_phases JSONB NOT NULL DEFAULT '{}'::jsonb` —
  per-phase state map for orchestration.
- `narratives` — cross-session state snapshots with scope-based addressing
  and supersede chain. Partial unique index enforces one `active` row per
  `(tenant, agent, scope, scope_key)`.
- `consumer_profiles` — profile registry keyed by composite PK
  `(tenant_id, consumer_id, version)` + `UNIQUE (consumer_id, version,
  profile_hash)` catches silent drift.
- `timeline_events` — append-only event log with idempotency_key UNIQUE,
  category + occurred_at indexes, search_tsv.
- `session_states` — latest-snapshot-per-scope with supersede chain via
  `is_latest` partial unique.
- `session_handoffs` — append-only handoff log.
- `decisions` — append-only decision log with status
  (proposed/committed/reversed) CHECK enum.
- `artifacts` — producer-declared output records with lifecycle
  `pending → produced|failed|discarded`.
- Shared `set_updated_at()` trigger function reused across tables.

#### Added — capability surfaces

- `aq.narratives.{upsertSnapshot,getLatest,listHistory}` — supersede chain
  atomic via transaction; idempotent replay.
- `aq.timeline.{append,list}` — category/since/until filters.
- `aq.state.{write,getLatest}` — goal/active_work/blockers/affect projected
  to explicit columns, full payload in JSONB.
- `aq.handoff.{write,getLatest}` — status enum enforced at API + DB.
- `aq.profiles.{register,load}` — deep canonical JSON hash prevents silent
  drift; `AQ_CONFLICT` returned on hash collision.
- `aq.decisions.{append,list}` — ON CONFLICT DO NOTHING fallback SELECT.
- `aq.artifacts.{record,list}` — upsert lifecycle, `produced_at` auto-set on
  pending → produced transition.
- `aq.consolidation.{claimNext,transitionPhase,getState}` — 10-phase state
  machine with `pg_advisory_xact_lock` + claimToken; stale claim reclaim;
  `forceReplay=true` for terminal → claimed.
- `aq.bundles.{export,import,diff}` — cross-table session export across 7
  buckets, import with `mode=dry-run|apply` + `conflictPolicy=skip|upsert|fail`.

#### Added — error envelope

- `core/errors.js`: `AqError` class with `code`/`retryable`/`details`/
  `toJSON()`, `ok(data)` / `err(code, msg)` / `asResult(asyncFn)` factories.
  13 known codes registered (`AQ_INVALID_INPUT`, `AQ_NOT_FOUND`,
  `AQ_CONFLICT`, `AQ_PHASE_CLAIM_CONFLICT`, etc.).

#### Added — consumer deliverables

- `consumers/miranda/profile.json` — Miranda's canonical consumer profile
  (session_state + handoff + decision_log + timeline v1 schemas, artifact
  producers, extraction hints).
- `consumers/miranda/render-daily-md.js` — reference implementation for the
  artifact capability. Pure function: `(aquifer, date) → { markdown,
  artifact }`. Renderable directly; artifact record ready for
  `aq.artifacts.record()`.
- `MCP_TOOL_MANIFEST` + `writeMcpManifestFile()` + `aquifer mcp-contract`
  CLI — canonical 5-tool manifest for bi-directional registration. Gateway
  imports in-process; CC MCP server reads
  `/tmp/aquifer-mcp-contract.json`.

### Tests

891 → 900 (+9 for MCP manifest, plus 60+ new capability integration tests
under `test/*.integration.test.js`). All green. Lint clean on new code (2
pre-existing warnings in `consumers/shared/factory.js` and
`consumers/shared/llm.js`).

## [1.2.1] - 2026-04-19

### Quick Start DX — zero-env try-it path

`npx aquifer quickstart` now autodetects the local stack so fresh
installs work without exporting anything:

- New `consumers/shared/autodetect.js` with `autodetectForQuickstart(env,
  probes)` — probes `postgresql://aquifer:aquifer@localhost:5432/aquifer`
  and `http://localhost:11434/api/tags`, returns a detected env map.
  Probes are injectable for unit testing.
- `consumers/cli.js` main(): runs autodetect before building the Aquifer
  instance, but **only for the `quickstart` command**. Detected values are
  pushed to `process.env` and echoed so the operator can `export` them for
  permanent use. Production commands (`mcp`, `migrate`, `recall`, ...)
  stay strict and require explicit env.
- README Quick Start: collapsed from three steps + four env exports to
  two commands (`docker compose up -d` + `npx --yes @shadowforge0/aquifer-memory quickstart`)
  with no env. MCP client snippet retained.
- `docker-compose.yml` hint updated to `EMBED_PROVIDER=ollama` (matching
  the 1.2.0 autodetect path instead of the legacy `AQUIFER_EMBED_*` four).

### Tests
728 → 736 (+8 for autodetect), all green. Lint clean on new code.

## [1.2.0] - 2026-04-18

### Installability pass — zero-boilerplate install-and-go

Closes five install gaps so a fresh host can go from `npm install` to a
running Aquifer with only `.env` + `install.sh` + a gateway restart. Jenny
was the first external consumer to validate this path end-to-end.

#### Added
- `core/aquifer.js` env-driven defaults: `DATABASE_URL` / `AQUIFER_DB_URL`
  fallback for pool construction, `AQUIFER_SCHEMA` + `AQUIFER_ENTITY_SCOPE`
  pulled from env, `EMBED_PROVIDER` / `EMBED_ENDPOINT` autodetect via
  `resolveEmbedFn` (explicit fn > config.embed object > env).
- `consumers/shared/llm-autodetect.js`: resolves LLM endpoint from
  `AQUIFER_LLM_PROVIDER` (minimax / opencode / anthropic-compat).
- `consumers/openclaw-ext/`: drop-in OpenClaw extension that registers all
  three hooks (`before_reset`, `before_prompt_build`, `session_recall`).
  `consumers/openclaw-plugin.js` kept as the low-level API.
- `consumers/default/`: parameterized persona — `agentName`,
  `observedOwner`, `schema`, `daily_entries` layout configurable; drops in
  without editing source for the common case.
- `consumers/default/daily-entries.js`: self-contained DAL matching the
  canonical `*.daily_entries` shape.
- `scripts/install-openclaw.sh`: symlinks the ext into
  `$OPENCLAW_HOME/extensions/`.
- `Aquifer` instance surface: `getPool()` / `getLlmFn()` / `getEmbedFn()`
  so personas can reuse resources without reaching into internals.
- `test/installability.integration.test.js`: zero-arg `createAquifer()`
  contract test.

#### Changed
- `consumers/default/resolveCommon`: opts are now optional; falls back to
  the Aquifer instance's pool/llm/embed getters.

#### Notes
- `consumers/miranda/` intentionally untouched in this release — the
  refactor onto the default persona is deferred.
- Tests: 711 → 728 (+17), all green.

## [1.1.0] - 2026-04-18

### Aquifer completion — persona layer ships inside Aquifer

Ends the era of host-side `~/.openclaw/shared/lib/miranda-memory/`. The
Miranda persona now lives in-tree as a plugin on top of a generic
claude-code host adapter, and three shipped consumers stop reinventing
the commit/enrich/dedup/format scaffolding.

#### M1 — consolidation pipeline + facts schema (alpha.1)
- `schema/004-facts.sql`: `facts` + `fact_entities` with
  candidate/active/stale/archived/superseded lifecycle; tenant-aware,
  idempotent.
- `pipeline/consolidation/{apply,index}.js`: 8-action transaction
  (promote / create / update / confirm / stale / discard / merge /
  supersede) scoped by `(tenant, agent)`. Schema-agnostic.
- `core/aquifer.js`: `enableFacts()` + `consolidate()` on the instance;
  migrate runs `004-facts.sql` when `facts.enabled: true` at construction.
- `consumers/shared/entity-parser.js`: `parseEntitySection` lifted out so
  consumers stop doing `core/entity` deep imports.
- `docs/postprocess-contract.md`: stable-in-1.x contract for the enrich
  `postProcess` hook.

#### M1.5 — shared ingest primitives
- `consumers/shared/normalize.js`: `normalizeMessages({ adapter })` wraps
  `pipeline/normalize`; returns a commit-ready shape with skip stats,
  boundaries, and tool usage.
- `consumers/shared/ingest.js`: `runIngest()` encapsulates the standard
  normalize → commit → enrich(postProcess) / skip flow with
  `(agentId, sessionId)` dedup, in-flight guard, TTL eviction, and an
  `enrich: boolean` option returning a `committed_only` status for
  pull-style backfill.
- `consumers/shared/recall-format.js`: default English recall formatter
  plus `createRecallFormatter({ header, empty, title, body, matched,
  score, separator })` for persona overrides.
- `consumers/openclaw-plugin.js` / `opencode.js` / `mcp.js`: refactored
  onto the shared scaffolding; host-specific normalize stays per-host,
  everything downstream goes through `shared/`. Behavior-equivalent to
  the pre-refactor implementations.

#### M2 — claude-code host adapter + miranda persona layer (alpha.2)
- `consumers/claude-code.js`: generic host adapter with
  `runEnrich / runBackfill / runContextInject`. No persona logic — the
  caller injects `summaryFn`, `entityParseFn`, and `postProcess`.
- `consumers/miranda/`: persona plugin — `instance.js` (Aquifer singleton
  bound to `schema='miranda'`, entities + facts, rerank via OpenRouter),
  `llm.js` (MiniMax wrapper, OpenClaw Anthropic-compat endpoint, M2.5
  `<think>` stripping), `prompts/summary.js` (six-section 繁體中文 prompt
  + parsers for recap / entities / working-facts / handoff),
  `daily-entries.js` (self-contained DAL for `miranda.daily_entries` with
  Taipei date + textHash6 dedupe), `workspace-files.js` (emotional-state,
  recap JSON, learned-skills artifacts), `context-inject.js`
  (`buildSessionContext` + `extractFocusTodoMood` + `computeInjection`),
  `recall-format.js` (zh-TW narrative formatter on shared base),
  `index.js` (`mountOnOpenClaw` + `buildPostProcess`).
- `package.json` exports: `./consumers/claude-code` +
  `./consumers/miranda`.

#### M3 — production cutover (alpha.3 → 1.1.0)
- `consumers/miranda/index.js`: `mountOnOpenClaw` split into
  `registerAfterburn` / `registerContextInject` / `registerRecallTool` so
  different OpenClaw extensions can claim just the hooks they own without
  double-registering. Fixes `before_reset` double-fire when
  `afterburn/index.js` and `driftwood/index.js` both mounted the full
  plugin.
- OpenClaw gateway (afterburn + driftwood extensions) runs against the
  new plugin end-to-end: `before_reset` / `before_prompt_build` /
  `session_recall` all flow through
  `@shadowforge0/aquifer-memory/consumers/miranda`.
- CC hooks swapped to the new module paths: `cc-afterburn.js`,
  `cc-afterburn-backfill.js`, `cc-context-inject.sh`,
  `mcp/miranda-tools.js`, `scripts/kg/backfill_entities.js`. Deep-import
  workarounds removed.
- `~/.openclaw/shared/lib/miranda-memory/` retired (renamed
  `miranda-memory.DELETED-20260418` for rollback).
- `knowledge_search` moved to `~/.openclaw/shared/lib/knowledge-search/`
  as a standalone host-only tool.

#### Tests
- M1: 527 → 581 (+54 — 17 consolidation, 27 entity-parser, 10 facts-schema).
- M1.5: 581 → 636 (+55 — 20 shared-normalize, 15 shared-ingest, 20
  shared-recall-format). Refactor preserves green count.
- M2: 636 → 683 (+47 — 25 miranda-prompts, 14 miranda-persona, 8
  claude-code-adapter).
- M3: 683 green through production smoke.

## [1.0.4] - 2026-04-18

### Fixed
- Expose `normalizeEntityName` from the package root so consumers don't
  need to reach into `./core/entity` (which the 1.0 exports field
  rejects).
- Declare `eslint` as a devDependency so the pre-commit hook added in
  `141b164` can actually run lint.

## [1.0.3] and earlier

1.0.0 (`d1e014a`) shipped the bootstrap API, OpenCode consumer, and
session continuity work. The 1.0.1–1.0.3 line covered HNSW hardening,
trigram CJK search, FTS ranking fixes, pre-commit hooks, and contract
fixes for bootstrap / feedback / turn-embed recall. See `git log
v1.0.0..v1.0.4` for the full list.

Pre-1.0 releases (0.1 – 0.9) established the open-source core: commit /
recall / enrich pipeline, entity + trust scoring, postProcess hook,
cross-encoder reranker, MCP + CLI consumers, installability delivery
(docker-compose, quickstart, example configs). See `git log v1.0.0`.

[1.2.0]: https://github.com/shadowforge0/aquifer/releases/tag/v1.2.0
[1.1.0]: https://github.com/shadowforge0/aquifer/releases/tag/v1.1.0
[1.0.4]: https://github.com/shadowforge0/aquifer/releases/tag/v1.0.4
