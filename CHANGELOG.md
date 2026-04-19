# Changelog

All notable changes to `@shadowforge0/aquifer-memory` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project uses semantic versioning.

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
