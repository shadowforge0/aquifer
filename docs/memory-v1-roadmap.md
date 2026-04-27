# Aquifer Memory v1 Roadmap

狀態：agent team 收斂後的實作切分；2026-04-26 已推進到 Slice 5 初版。Public serving 已有 opt-in curated mode，預設仍保留 legacy mode 以維持既有 consumer 相容。

這份文件接在 [memory-scope-v1.md](memory-scope-v1.md) 後面，用來把 v1 scope 轉成可落地的 PR slices。這不是目前 1.5.x public API contract，也不是一次性大改計畫。

## 總判斷

v1 初始階段不要重寫 ingest，也不要直接改現有 `session_recall` / `session_bootstrap` 的 public MCP 語意。

最小正確路線是：

```text
保留 1.5.x session pipeline 作為 legacy/evidence plane
  + 新增 curated sidecar
  + 先支援 decision / open_loop
  + 用 golden tests 鎖 curated-only contract
  + 之後再逐步切 public serving surface
```

原因很直接：目前 `sessions`、`session_summaries`、`turn_embeddings` 已經承擔 host ingest、summary、FTS、embedding 與 recall。它們更像 v1 的 evidence substrate，不應在初始 PR 推倒。真正缺的是旁邊那條乾淨的 curated plane，以及能證明 raw/evidence 不會繞過 promotion 進 runtime 的 tests。

## 現況判定

可沿用：

- `sessions`、`session_summaries`、`turn_embeddings` 可先降格成 legacy/evidence plane。
- `normalizeMessages()`、`runIngest()` 可保留作 host adapter / normalized evidence input。
- `decisions`、`session_states`、`entity_state_history`、`insights` 可借局部模型，例如 idempotency、supersede chain、valid time、canonical key。
- 現有 `bootstrap.test.js`、`shared-normalize.test.js`、`recall-mode.test.js`、feedback tests 可作 regression coverage，但不能當 v1 acceptance。

不能直接沿用成 v1 source of truth：

- `session_summaries` 目前仍是 serving source，不是 curated memory。
- `turn_embeddings` 目前會回 matched turn，可能帶 raw transcript 污染。
- 現有 `facts` 表是 legacy `subject_key + statement` consolidation store，不是 v1 structured assertion plane。
- `session_feedback` 會調 `session_summaries.trust_score`，只能視為 legacy ranking feedback，不是 v1 feedback event model。

## Slice 0：Contract Tests First

狀態：已落地 DB-free golden tests。

目的：在不碰 DB schema 與 public API 的情況下，先把 v1 不可退讓的邊界寫成 DB-free golden tests。

檔案範圍：

- `test/fixtures/memory-scope-v1/**`
- `test/v1-recall-curated-only.test.js`
- `test/v1-bootstrap-determinism.test.js`
- `test/v1-pollution.golden.test.js`
- `test/v1-scope-inheritance.golden.test.js`
- `test/v1-feedback-semantics.test.js`

必測 case：

- Raw-only hit 對 curated recall 回空。
- 同語意 raw evidence、rejected candidate、active curated memory 同時存在時，只回 active curated winner。
- 同 snapshot、同 scope、同 budget 的 bootstrap byte-identical。
- Mandatory bootstrap set 超 budget 時回 overflow/degraded，不 silent drop。
- Commentary、tool narration、failed hypothesis、wrapper metadata、session-start injected context、rendered markdown、stack trace、secret 不得進 curated memory。
- `exclusive/defaultable/additive/non_inheritable` scope inheritance deterministic。
- Feedback 可以影響 ranking/review priority，但不能改 active winner、scope、authority、valid time 或 backing fact。

Golden fixture shape：

```text
test/fixtures/memory-scope-v1/<case>/
  input.json
  expected-candidates.json
  expected-curated.json
  expected-bootstrap.json
  expected-bootstrap.txt
  expected-recall.json
  expected-asof.json
```

Non-goals：

- 不接 PostgreSQL。
- 不改 `aquifer.recall()` 或 `aquifer.bootstrap()`。
- 不承諾 recall quality。
- 不處理 old DB distill。

## Slice 1：Curated Foundation Sidecar

狀態：已落地 additive schema、core sidecar 與 `aquifer.memory.*` namespace；尚未取代 top-level recall/bootstrap。

目的：新增 additive v1 foundation schema 與 core sidecar，不影響現有 1.5.x public serving surface。

檔案範圍：

- `schema/007-v1-foundation.sql`
- `core/memory-records.js`
- `core/memory-promotion.js`
- `core/memory-bootstrap.js`
- `core/memory-recall.js`
- `core/aquifer.js` 只做 migration 註冊與 `aquifer.memory.*` namespace 掛載
- focused tests for schema shape、promotion gate、sidecar recall/bootstrap

第一個 migration 只新增：

- `scopes`
- `versions`
- `memory_records`
- `evidence_refs`
- `feedback`

暫不新增：

- `raw_events`
- `evidence_items`
- `compaction_runs`
- v1 structured `facts`

理由是初始 foundation 沒有 live reader 依賴 raw/evidence/compaction tables；現有 `facts` 名稱已被 legacy 表占用，不能直接擴成 v1 assertion plane。

第一批 accepted memory kinds：

- `decision`
- `open_loop`

其餘 kinds 先允許成 `candidate` / `quarantined` / rejected reason，不進 active curated plane。

Sidecar API：

```js
aquifer.memory.extractCandidates(...)
aquifer.memory.promote(...)
aquifer.memory.recall(...)
aquifer.memory.bootstrap(...)
```

這些 API 先不取代 top-level `aquifer.recall()` / `aquifer.bootstrap()`，也不改 MCP manifest。

Acceptance：

- Migration additive、idempotent。
- 舊 `session_recall` / `session_bootstrap` tests 仍通過。
- 同 evidence snapshot 抽 candidates 兩次結果一致。
- Promotion gate 對非 `decision/open_loop` 不會 active promote。
- Curated bootstrap 對同 snapshot + budget byte-identical。
- Evidence-only session 不會出現在 `aquifer.memory.recall()`。

## Slice 2：Enrich Safety Gate

狀態：初版已落地。`enrich()` 會先產生 sanitized copy，再餵給 summary、entity/state-change extraction 與 turn embedding；raw session 仍留在 `sessions.messages` 作 evidence。

目的：在 `enrich()` 的 summary/embedding fan-out 前增加 evidence safety gate，避免污染先進 `session_summaries`、FTS、turn embeddings。

第一個 choke point：

```text
core/aquifer.js enrich()
  before summaryFn / summarize()
  before summary embedding
  before turn embedding
```

Gate 最少做四件事：

- Eligibility classification：哪些 message/evidence 可進 summary、embedding、candidate extraction。
- Secret/privacy redaction：summary、FTS、embedding 只能吃 redacted copy。
- Quarantine tags：`host-private`、`session-injected`、`commentary`、`tool-output`、`secret-risk`。
- Evidence-only routing：不合格內容只能留 evidence/legacy session，不得進 curated candidate 或 summary facts/open loops。

Negative tests：

- Bootstrap injected context 不得被新 session summary 再吸收成 decision/open_loop/fact。
- `dailyContext` 內含 secret 時，不得進 summary/index/embedding。
- User turn 含 token、cookie、connection string 時，`summaryText`、`search_text`、`turn_embeddings.content_text`、`matchedTurnText` 不得回吐原文。
- Codex commentary 即使不是 tool 前敘述，也不得升格成 summary facts/open loops。
- Tool output、stack trace、SQL error、env dump 不得進 `summary_text/search_text`。
- Host-private/session-scope 內容不得跨 `source` 或 host 出現在 bootstrap/recall。
- Quarantined/redacted turn 可以讓 session 被找到，但不能回 matched raw text。

Non-goals：

- 不做 output formatter regex scrubber 當主要安全策略。
- 不做 graph DB、cross-host sharing、old DB distill。
- 不調 aggressive feedback/rerank heuristics。

## Slice 3：Typed Memory、Scope、Lifecycle

狀態：初版已落地。Promotion 目前接受 `fact`、`state`、`decision`、`preference`、`constraint`、`entity_note`、`open_loop`、`conclusion`，並加入 authority、scope、canonical key、supersede 與 `asOf` 查詢行為。

目的：把 v1 memory identity、scope inheritance、authority、lifecycle 補完整，讓 `decision/open_loop` 之外的 kinds 有合法落點。

範圍：

- 完整 memory types：`fact`、`state`、`decision`、`preference`、`constraint`、`entity_note`、`open_loop`、`conclusion`。
- Canonical key：`kind + subject + aspect/predicate + scope + context_key/topic_key`。
- Scope inheritance：`exclusive`、`defaultable`、`additive`、`non_inheritable`。
- Lifecycle：`candidate`、`active`、`stale`、`superseded`、`revoked`、`tombstoned`、`quarantined`、`archived`。
- Valid time 與 system time 分離。
- Feedback event model 不再 mutate truth。

需要小心：

- 不直接復用 legacy `facts` 當 v1 assertion plane。
- 若要 structured facts，使用新表名或新 migration 設計，例如 `fact_assertions_v1`，等命名穩定後再定。
- 不讓 scope default 成 global。

Acceptance：

- `traceability_rate = 100%`
- `scope_leak_rate = 0`
- 同 authority 衝突不 silent merge。
- `asOf` 查詢對 promotion、supersede、revoke、open-loop close、fact validity intervals 可解析。
- Feedback 不能改 active winner。

## Slice 4：Serving Mode Switch

狀態：初版已落地為 opt-in serving mode。`memory.servingMode = 'curated'` 或 `AQUIFER_MEMORY_SERVING_MODE=curated` 會讓 top-level `recall()` / `bootstrap()` 走 curated plane；legacy evidence lookup 改由 `evidenceRecall()` 與 MCP `evidence_recall` 顯式呼叫。

目的：把 public `bootstrap` / `session_recall` 從 legacy sessions/summaries path 切到 curated plane，並把 evidence lookup 顯式分出來。

範圍：

- `aquifer.bootstrap()` 改成 curated source，或新增 versioned opt-in 後再改預設模式。
- `aquifer.recall()` 改成 curated source，或新增 `memoryMode` gating 後再改預設模式。
- MCP manifest 更新描述：`session_recall` 不再是 stored sessions search，而是 curated memory search。
- 新增 `evidence_recall`，如保留 `jsonl_recall`，只作 artifact access。
- Existing session/summaries recall 只保留為 legacy/evidence/debug path。

Acceptance：

- `session_recall` 不能 fallback raw transcript。
- `bootstrap` 不讀 raw/full transcript。
- `evidence_recall` 不 implicit feed bootstrap。
- Reset 後 old-only entities 回空是正確。
- 舊 live path 的保留行為有明確 deprecated/evidence label。
- Serving surface completeness：core API、MCP manifest、stdio MCP consumer、host compatibility tool descriptions、setup docs、tool-surface tests 必須一起對齊；不能只改其中一層。

## Slice 5：Consolidation 與 Old DB Boundary

狀態：guarded apply / ledger / claim 基礎已落地，但仍不是完整 daily/weekly/monthly rollup。Schema 已有 `compaction_runs` ledger、coverage 欄位、`applying` claim state、`apply_token`、applying row shape check、DB-time `lease_expires_at`，以及同 tenant/cadence/window/policy 的 one-applying-worker guard。Core 已提供 deterministic compaction plan、daily/weekly/monthly aggregate candidate planning、coverage recording、open-loop stale planning、old DB archive snapshot distill、`active -> stale` CAS retire helper、`claimRun()`，以及 `applyPlan()` 讓 claim、lifecycle update 與 compaction ledger 在同一 transaction 內提交；claim path 會用 schema-scoped、canonical period、transaction-scoped advisory lock 序列化同 window/policy 的 worker，避免不同 input hash 的 loser 以 unique violation 失敗，並會在 claim 前把超過 DB lease 的 stale `applying` row 標成 `failed` 後再嘗試新 claim。這代表 Slice 5 已從 planner/helper 推進到保守 candidate/writer 基礎，但還缺 operator surface、scheduler，以及把 aggregate candidates 接到正式 promotion / idempotent lineage 的 DB-backed path。

目的：落 daily/weekly/monthly consolidation 與 old DB reset/distill 的治理邊界。

範圍：

- `compaction_runs`
- session close / daily / weekly / monthly deterministic jobs
- provenance merge
- open loop close/stale/expire
- old DB immutable archive snapshot
- offline distill 只輸出 candidates

Acceptance：

- 同 snapshot 重跑 consolidation 輸出一致。
- `active_conflict_rate = 0`
- Compaction 不改 active winner，除非 promotion policy 明確產生 supersede/revoke。
- Old DB 不在 live recall/bootstrap path。
- Distill 不能繞過 promotion gate。

已落地：

- `planCompaction()` 驗證 cadence 與 period window，並輸出 deterministic `sourceCoverage` / `outputCoverage`。
- `planCompaction()` 對 `daily` / `weekly` / `monthly` closed windows 會依 active curated memory 的 scope / context / topic 分組產生 deterministic aggregate `conclusion` candidates；canonical key 包含 tenant、scope、context、topic、cadence、policy version 與 closed window，payload 記錄 `candidateHash`、source memory ids / canonical keys，evidence refs 以 `derived_from` 指回 source memory。這些 candidates 只存在 planner/run output，仍是 `status='candidate'`，不會由 compaction apply path 直接寫成 active memory。
- `recordRun()` 寫入 `source_coverage` / `output_coverage`，並避免已 `applied` 的同 dedupe key row 被後續 `planned` / `failed` / `skipped` 倒退覆寫。
- `schema/011-v1-compaction-claim.sql` 補上 `claimed_at`、`worker_id`、`apply_token`、`applying` status、applying claim shape check 與 one-applying-worker partial unique index；歷史 `applied` row 不進 unique index，避免舊 DB 有不同 input hash 的 applied ledger 時 migration 失敗。
- `schema/012-v1-compaction-lease.sql` 補上 `lease_expires_at`、`reclaimed_at`、`reclaimed_by_worker_id`、applying lease check、舊 applying row idempotent backfill，以及對齊 claim window filter 的 partial index。
- `claimRun()` 先以 schema-scoped、canonical period、transaction-scoped advisory lock 序列化同 tenant/cadence/window/policy，再確保 planned row，最後以 `status='planned'` 與同 window 無 `applying/applied` winner 作為 claim 條件；公開 `claimRun()` 在真 pool 下也會 checkout client 並包住 `BEGIN/COMMIT`，避免 xact lock 在單句 `pool.query()` 後失效。
- `claimRun()` 會用 DB `transaction_timestamp()` 寫入 `claimed_at` 與 `lease_expires_at`；lease 預設 600 秒、最低 10 秒。超過 `lease_expires_at` 的同 window `applying` row 會在同一 advisory-lock transaction 內轉成 `failed`，釋放 one-applying-worker index 後才嘗試新 claim。必要時 caller 可用 `reclaimStaleClaims: false` 關閉 reclaim。
- `updateMemoryStatusIfCurrent()` 以 current-status guard 做 lifecycle CAS，非 active target 會關閉 bootstrap / recall visibility。
- `applyPlan()` 目前只支援由 plan 產生的 `active -> stale` retire；真 DB pool path 會先 claim，再把 memory lifecycle update 與 `compaction_runs` finalize 放在同一 transaction。拿不到 claim 時不做 lifecycle mutation。Aggregate candidates 只會進 compaction run output，必須由後續正式 promotion path 才能成為 active curated memory。
- Focused v1 tests 與 lint 已驗證；完整 `npm test` 在目前 shell env 仍有既有 env default 污染造成的 `edge-failure.test.js` 3 fail，清 env 單跑該檔通過。

仍未完成：

- 真 PostgreSQL 多 worker concurrency smoke 已加為 `AQUIFER_TEST_DB_URL` gated integration：驗證獨立 worker instance 對同 snapshot 只有一個能 apply、同 window 不同 input hash 的 loser 不會 reject 或留下 live apply，也覆蓋 stale applying lease reclaim。
- Daily / weekly / monthly job entrypoint、CLI 或 scheduler。
- Rollup aggregate candidate 的正式 DB-backed write/promotion path、idempotent lineage，以及錯誤/過期 daily 不得升格到 weekly/monthly 的完整 golden corpus。
- Tenant-safe lineage composite FK 的完整補強。

## Slice 6：Curated Core Lifecycle 與 Codex-first Finalization

狀態：6A 已落地，6B 前兩段已落地；hook / CLI UX / DB-backed end-to-end smoke 尚未接成完整 consumer trigger。

目的：把 curated memory 從 sidecar helper 推進成 core-owned lifecycle，並先用 Codex 作為唯一必做 consumer 驗證正常使用路徑。6B 不追求多 consumer parity；Claude Code / OpenClaw 只保留 extension contract，等 Codex path 驗證後再接。

### Slice 6A：Transaction-safe Curated Writer

狀態：已落地。

範圍：

- `core/memory-records.js` 提供 per-candidate transaction wrapper。
- `core/memory-promotion.js` 在同一 transaction 中完成 canonical lock、active lookup、supersede、new active insert/upsert、evidence link。
- `tenantId + canonicalKey` 以 transaction-scoped advisory lock 序列化，避免 zero-row concurrent promote 繞過 equal-authority conflict policy。
- Active row lookup 支援 `FOR UPDATE OF m`。
- 新增 DB-gated curated writer integration smoke；無 `AQUIFER_TEST_DB_URL` 時按 integration 慣例 skip。

已驗證：

- `node --test test/v1-typed-lifecycle.test.js`
- focused v1 regression
- clean-env full `node --test test/*.test.js`
- `npm run lint`
- `git diff --check`

### Slice 6B：Codex-first Agent-mediated Finalization

狀態：finalization foundation 已有，但不能只用 row count、hook smoke 或 `v1Finalization=finalized` 判定完成。已有 `session_finalizations` ledger、core `finalizeSession()` API、Codex digest marker、normalized transcript hash、recovery eligibility scan、同意後 sanitized/token-budgeted transcript view、manual handoff finalization、SessionStart recovery 可呼叫 API、decline/defer 去重、ledger-truth 測試、Codex recovery CLI、SessionStart 使用者提示文字，以及本機 hook smoke。SessionStart recovery 已改成先列出可 DB recovery 的 JSONL 清單，再由使用者選擇全補、挑選補或不補；未補但保留手動入口的項目會標為 `deferred`。尚未完成的 blocking contract 是：finalization 後必須輸出人類可檢查的 committed curated memory 整理結果；SessionStart 只能載最小 active context；錯誤/作廢 memory 不能進 active recall/bootstrap/daily/weekly/monthly；DB-backed import -> finalize -> curated recall/bootstrap 必須端到端可見。

核心判斷：

- 主路徑不是 afterburn；主路徑是 finalization。
- Finalization 是單一 core-owned 動作：接收已 normalized 且 sanitized 的 session transcript、agent 產生的 `summaryText` / `structuredSummary` / optional handoff payload，然後原子寫入 `session_summaries`、curated candidates、promotion、evidence refs 與 finalization status。
- Handoff、Codex session-end hook、SessionStart recovery、afterburn/backfill 都只是不同 trigger，不能有四套 truth semantics。
- Handoff 是 foreground finalization，不是 legacy handoff log 包裝。它必須讓使用者看到「實際整理進 DB 的記憶內容」：accepted memory、active open loops、superseded/quarantined/incorrect memory、下一段 SessionStart 會載入與不會載入的內容。
- `handoffId`、`transcriptHash`、promoted count、test list、render file path 只能作為 audit footer；不能作為 handoff 的主輸出，也不能證明記憶內容符合 spec。
- 正常使用不依賴額外 afterburn LLM API。整理成本由當前 Codex CLI agent tokens 承擔；這是成本模型，不是零成本承諾。
- Afterburn 降級為 maintenance/backfill lane：只補漏掉的 Codex session、歷史 orphan rows 或 operator 明確要求補帳的情境。

Codex trigger priority：

1. Manual handoff：使用者明確說 handoff / 收工 / 記一下時，直接 finalization；這是最可靠的收尾訊號。
2. Codex session-end hook：若 Codex 能提供可靠結束事件，結束時自動 finalization。
3. Codex SessionStart recovery：新 session 開始時先掃 finalization ledger、本機 recovery decisions 與 Codex JSONL，排除 current transcript 後建立「可 DB recovery」清單；提示使用者選擇全補、挑選補、全部延後或全部拒絕。只有使用者選定要補的 session 才能把 sanitized transcript view 交給當前 CLI agent 摘要並完成 finalization。
4. Afterburn/backfill：operator / maintenance 補漏，不是 day-1 主路徑，也不應出現在 getting-started 的主要動線。

Codex adapter ownership：

- Codex consumer 只擁有 JSONL / filesystem 知識、Codex normalize contract、recovery task orchestration。
- Core 擁有 finalization write path、DB lifecycle state、candidate extraction/promotion、evidence/provenance。
- `postProcess` 仍是 best-effort hook，不能當 source-of-truth writer；不能把 curated finalization 塞進 `postProcess`。

資料與狀態 contract：

- 新增 DB-backed finalization ledger，避免混用 `sessions.processing_status`。最小欄位包含 `session_row_id`、`transcript_hash`、`status`、`mode`、`host`、`error`、`claimed_at`、`finalized_at`、`finalizer_model`。
- DB 是 finalization source of truth；本機 marker 只能是 recovery cache / UX hint。
- Local marker key 不得直接使用 raw `session_meta.id`；必須使用安全 digest 或安全編碼，防 path traversal、marker spoofing、collision。
- Finalization 唯一鍵至少涵蓋 `(tenant, source, agent, session_id, transcript_hash, phase)`，防止 handoff / session-end / recovery / backfill 重複 promotion。
- Transcript hash 改變時，已 finalized session 可重新進 pending review；同 digest 被拒絕後不得重複提示，直到 digest 改變。
- Recovery decision 狀態至少包含 `declined`、`deferred`、`skipped`。`declined` 表示使用者拒絕 recovery；`deferred` 表示本次 SessionStart 不補且不再自動打擾，但 operator 可用手動命令與 `--include-deferred` 找回來補；`skipped` 表示 deterministic policy 判定不應進 DB，例如 user turns 不足。
- Terminal finalization 狀態不得被後續 retry/upsert 降級覆蓋；`finalized`、`skipped`、`declined`、`deferred` 都必須保持 monotonic，除非明確同狀態重寫 metadata。`failed` 可 retry。
- Human review output 必須由 committed finalization snapshot 產生，且用人話列出記憶語意，不得直接回傳 raw JSON payload 當 user-facing handoff。
- 錯誤 finalization 必須能標成 `incorrect` / `quarantined` / `superseded` / `revoked` 或等價 lifecycle state，並從 active curated serving、SessionStart、daily/weekly/monthly rollup 移除。

SessionStart recovery safety gate：

- 提示前可讀 Codex JSONL 以做 deterministic eligibility scan，包括 safe session id、workspace/source/agent/sessionKey provenance、message/user counts、normalized transcript hash、safety gate、byte/message/prompt budget 與 short-session policy；但不得把 transcript text 注入本次對話，不得呼叫 LLM，不得寫 DB，不得 promotion。
- Eligibility scan 必須先篩掉不能 DB recovery 的 JSONL，例如 short session、current transcript、unsafe session id、wrong workspace/source/agent、over-budget、hash mismatch、missing/unreadable/corrupt file 或已被 finalization ledger / decision marker terminal suppress 的項目。Prompt 只能列出可 DB recovery 的候選。
- 候選必須通過 workspace/project/source/agent/sessionKey provenance match；沒有可驗證 provenance 不提示、不讀 transcript。
- 使用者同意某一候選後，才可以把該候選的 sanitized transcript view 載入目前 CLI agent context 讓 agent 摘要；仍必須排除當前 SessionStart transcript。
- Recovery prompt 只能看到 sanitized / token-budgeted transcript view，不能看到 raw tool output、bootstrap 注入、stack trace、env dump、secret-bearing content。
- Live recovery 必須有硬限制：`maxRecoveryBytes`、`maxRecoveryMessages` 或 turns、`maxRecoveryPromptTokens`。超過限制時降級為 backfill，不偷吃 live session tokens。
- Recovery transcript view 必須重用 Codex normalize / safety gate，不另寫 raw parser；live prompt 預設只吃 user turns 與可公開 assistant final answer。
- 多個可 DB recovery JSONL 必須一次列出清單，而不是只提示第一筆。提示必須提供全補、挑選補、全部延後、全部拒絕的操作路徑。
- 使用者挑選補其中幾筆時，未補的候選必須被標成 `deferred` 或等價可手動恢復狀態，避免下次 SessionStart 重複打擾；手動 preview/prompt 必須能用 `--include-deferred` 或等價選項找回。
- Raw candidate scan limit 不得先於 eligibility filter 截斷結果；若最新幾個 JSONL 是 short、current、corrupt 或 wrong-provenance，仍必須繼續掃到 configured eligible candidate limit 或 scan budget 耗盡。

Acceptance：

- Codex fresh install 不需要額外 afterburn LLM API，就能透過 handoff 或 session-end hook 讓下一段 bootstrap/recall 看見 curated memory。
- Manual handoff 完成時，使用者能在同一回合看到簡潔人話版「已整理進 DB」：本段狀態、已接受記憶、未完成事項、已作廢/隔離內容、SessionStart include/exclude。只有 audit footer 可以顯示 id/hash/count。
- 若前一段或多段未 finalized，下一次 Codex SessionStart 能先列出可 DB recovery 清單；使用者可選擇全補、挑選補、全部延後或全部拒絕。被選中的項目完成 finalization 後，本次 session 可受益。
- 使用者拒絕或延後 recovery 時，系統只記錄 declined/deferred，不把 transcript text 載入 context、不寫 finalization/promotion、不重複自動提示同 digest；deferred 必須保留手動補回入口。
- Afterburn/backfill 關閉時，Codex primary path 仍成立；開啟時只做補漏，不與 handoff/session-end/SessionStart recovery 重複 promotion。
- Finalization crash 或 promotion failure 不會留下「summary 已寫、curated 未寫但狀態已 done」的裂縫，也不破壞既有 active winner。
- Host-private / session-injected / tool output / secret content 不會被升格成 summary、candidate 或 curated memory。
- SessionStart 只載 active curated minimal context，不載完整 handoff render、測試輸出、工具流水帳、DB write plan、id/hash、render path、錯誤或已作廢 memory。
- Daily / weekly / monthly consolidation 不把 failed handoff、debug output、row count 或已被否定的狀態升格；daily 可記當日錯誤狀態，weekly/monthly 只能升格仍成立的規則、決策、模式或長期 open loop。
- Claude Code / OpenClaw 在本 slice 只保留事件介面與狀態契約，不要求 runnable parity。

必測：

- Codex `session_meta.id` 含 `/`、`..`、控制字元、超長字串時拒絕或安全 digest 化，且不寫 unsafe marker path。
- SessionStart recovery 未選定補某一候選前，transcript text injection、summary/LLM、`commit`、`finalizeSession`、`memory.promote` call count 都是 0。Eligibility scan 可以讀 JSONL 並 normalize 以產生 counts/hash/budget，但其輸出不得包含 transcript text。
- 多個 JSONL backlog 中，SessionStart prompt 必須列出所有 configured limit 內的 eligible candidates；short/current/corrupt/wrong-provenance candidates 不得出現在清單。
- 挑選補部分 candidates 後，未補 candidates 必須記為 `deferred`，下一次 SessionStart 預設不再提示；手動 `--include-deferred` 或等價命令可再次找到它們。
- Raw scan limit 不得造成最新 short/ineligible JSONL 擋住較舊 eligible JSONL。
- Import 與 recovery 對同一 JSONL 的 normalize 結果、`sessionId`、`userCount`、message count、`transcript_hash` 一致。
- 不同 project/workspace 的 Codex JSONL 不會出現在當前 recovery 候選。
- 未傳 self-exclusion 也不會撈到當前啟動中的 transcript。
- User decline 後同 digest 不再提示，且沒有 DB write / promotion / token 消耗。
- Over-budget transcript 只顯示 metadata preview 並降級為 backfill。
- Faked `done` / `enrich-only` marker 不能 override DB ledger truth。
- Long commentary、tool output、stack trace、secret-bearing turns 不得進 recovery prompt、summary 或 promotion。
- Handoff output golden：對同一 finalization fixture，user-facing output 必須列出 accepted/open/superseded/quarantined/include/exclude；不得只輸出 JSON/id/hash/count。
- SessionStart injection golden：同一 finalized fixture 中，debug/test/tool/render/id/hash/raw evidence 不得出現在 SessionStart context；active open loop 與 current state 必須出現。
- Incorrect finalization golden：被標成 incorrect/quarantined/superseded 的 handoff memory 不得出現在 curated recall/bootstrap 或 daily/weekly/monthly active rollup。
- Codex import -> finalize -> curated recall/bootstrap smoke 可跑；legacy `evidenceRecall` 仍是 evidence plane。

## Slice 7：Scope-Safe Serving 與 Feedback Split

狀態：已落地。2026-04-28 agent team 推進後，curated public serving 已有 scope contract、formatter shape、feedback split 與 evidence boundary。

目的：讓 public `session_recall` / `session_bootstrap` 在 curated mode 下有明確 scope contract、穩定 output shape 與 feedback target。

範圍：

- Curated recall 支援 active scope / applicability gate，或明確拒絕 unsupported filters。
- Bootstrap 可從 MCP/CLI/config 接受或推導 active scope。
- Curated recall result shape 對齊 formatter / CLI / MCP / host wrappers。
- `session_feedback` 保留 legacy session trust 語意；curated memory feedback 需要新增或清楚分離 target。
- v1 feedback 是 append-only event，能影響 ranking/review priority，但不改 truth。
- `evidence_recall` 必須是顯式、narrow、audit-friendly 的 evidence/debug tool；沒有 session/source/date/host 等邊界 filter 時應拒絕或明確標成 unsafe debug。

Acceptance：

- Scope leak negative tests 覆蓋 DB recall 與 bootstrap。
- Curated MCP `session_recall` 輸出不會變成 `(untitled)` 或空 body。
- Public feedback 對 legacy session 與 curated memory target 不混淆。
- `feedback` table 寫入可被 DB recall ranking 或 review priority 使用。
- Broad evidence search 不會被誤當 memory recall 使用。

完成證據：

- `core/aquifer.js` 在 curated mode 會注入 config/env/default active scope，並拒絕 `agentId`、`source`、`dateFrom/dateTo`、`entities`、`mode` 等 legacy-only filters；legacy `recall()` 仍保留 compatibility path。
- `core/memory-recall.js` 的 DB recall 依 `activeScopeKey` / `activeScopePath` 預先限制 scope，並用 applicability resolver 收斂 inherited rows；DB feedback score 會納入 `feedback` table 的 `memory_record` target。
- `session_feedback` 保留 legacy session trust；新增 public `memory_feedback` MCP/CLI/API surface，寫入 append-only curated feedback event，不修改 memory truth。
- `evidence_recall` 沒有 `agentId`、`source`、`dateFrom/dateTo`、`host`、`sessionId` 等 audit boundary 時會拒絕，除非明確 `allowUnsafeDebug=true`。
- `test/consumer-mcp.integration.test.js` 已用真 PostgreSQL 驗過 8-tool MCP surface 與 `memory_feedback` round-trip。

## Slice 8：Operator Jobs 與 Old DB Archive

狀態：核心 operator workflow 已落地；old DB archive 仍維持 dry-run candidate distill，不對外宣稱自動 quarantine/import 完成。

目的：把 consolidation / old DB distill 從 pure helper 變成 operator-safe workflow。

範圍：

- `compaction_runs` 的 apply path、status transition、attempt/audit behavior。
- Manual / daily / weekly / monthly job entrypoint，可由 CLI 或 scheduler 呼叫。
- Open-loop stale/expire status update 由 core policy 套用，不由外部 script 自訂。
- Old DB immutable archive manifest / snapshot。
- Archive distill 只輸出 candidate，promotion 前不得出現在 recall/bootstrap。
- Archive import 預設不可使用 `verified_summary` authority；除非 redaction、scope classification、host provenance 與 review policy 都可驗證。

Acceptance：

- DB-backed compaction run idempotent。
- 並行 worker 不會互踩 active winner。
- Old DB archive import 可重跑且 hash deterministic。
- Archive 中的 secret、session-injected context、host-private planning docs 會被 quarantine。
- Distilled candidates 未 promote 前 invisible。

完成證據：

- `core/memory-consolidation.js` 新增 `runJob()`，可用 manual/daily/weekly/monthly window 從 DB owner `records.listActive()` 讀 active scoped snapshot，預設 dry-run，只在 `apply=true` 時走 claim/apply；aggregate promotion 仍須顯式 `promoteCandidates=true`。
- `consumers/cli.js` 新增 `compact` command，支援 `--cadence`、`--period-start`、`--period-end`、`--active-scope-key/path`、`--apply`、`--promote-candidates`。
- Archive distill 預設 `raw_transcript` authority、`status='candidate'`、`visibleInBootstrap=false`、`visibleInRecall=false`，promotion 前不進 serving。
- DB-backed compaction claim integration 覆蓋並行 worker、stale claim reclaim、candidate ledger idempotency、promoted lineage、rollback 與非 active source exclusion。

仍保留的邊界：

- Old DB archive 的 secret/session-injected/host-private quarantine 仍不是自動 import workflow；目前只保證 distill candidate invisible 且低 authority，不宣稱可無審核 promotion。

## Slice 9：Surface Alignment 與 Release Readiness

狀態：已落地到 release-readiness gate；尚未 publish。

目的：讓 public surface、package artifact、docs、examples、metadata、rollback story 與 implementation 同步。

範圍：

- README / translated README / setup docs / MCP manifest / stdio MCP / CLI / wrappers tool surface 一致。
- `.env.example` 與 `aquifer.config.example.json` 說明 `AQUIFER_MEMORY_SERVING_MODE=curated|legacy`。
- Package surface 不包含內部 v1 planning docs。
- Package surface 不包含 destructive helper scripts，除非它們被明確移成 internal-only 且不在預設 publish surface。
- Wrapper metadata version 與 release identity 對齊，或明確標成 compatibility-only。
- Isolated `AQUIFER_TEST_DB_URL` integration gate。

Acceptance：

- `npm pack --dry-run --json` 不包含 internal specs。
- README/setup 不 overclaim planner-only consolidation。
- Real DB MCP integration 有跑，不是 soft skip。
- Rollback 只需 env/config 切回 legacy，不需要 destructive DB rollback。

完成證據：

- MCP manifest、stdio MCP server、README / README_TW / README_CN、setup docs 與 integration test 對齊 8 tools：`session_recall`、`evidence_recall`、`session_feedback`、`memory_feedback`、`feedback_stats`、`session_bootstrap`、`memory_stats`、`memory_pending`。
- MCP server version 改用 `package.json` version；`.env.example` 與 `aquifer.config.example.json` 都列出 `AQUIFER_MEMORY_SERVING_MODE` 與 active scope 設定。
- Package surface 移除 destructive drop SQL，`npm pack --dry-run --json` 測試確認不含 internal v1 planning docs 與 drop helpers。
- README/setup 寫明 curated rollback 為 `AQUIFER_MEMORY_SERVING_MODE=legacy` + restart，不需破壞性 DB rollback。
- `AQUIFER_TEST_DB_URL="$DATABASE_URL" npm test` 已跑完整真 DB suite，沒有 soft skip。

## vNext 明確排除

以下仍不進 normal-use blocking scope：

- Graph-native retrieval。
- External graph DB。
- Advanced manual review queue。
- Cold-start seed workflow。
- Feedback learning 自動調 promotion threshold。
- Embedding/version drift repair。
- Richer quality signals。
- Cross-host selective sharing。
- External facts source integration。
- Full retrieval orchestration。
- Benchmark program。

這些值得保留，但前提是 curated boundary、scope、authority、lifecycle 先穩。

## 下一個可開工 PR

Slice 6B 的下一步不是再證明「有寫進 DB」，而是補齊使用者可驗收的 finalization 閉環：同一份 committed memory 必須能被人檢查、被 curated recall/bootstrap 讀回、被 SessionStart 精簡注入，且錯誤記憶能從 active path 移除。SessionStart recovery selection 已有基礎：可 DB recovery 清單、全補/挑選/延後/拒絕操作、deferred manual path、short/current exclusion、terminal finalization guard 與 DB-backed full test。2026-04-28 已補 recovery consent 後的低摩擦 prompt -> finalize command 銜接、finalize 後 committed review surface 輸出、terminal row audit 欄位 immutability guard、DB-backed SessionStart minimal active context smoke、incorrect memory serving exclusion smoke，並新增 DB-backed Codex finalization -> curated bootstrap serving smoke。

```text
Codex finalization review surface and DB-backed serving smoke
```

最小檔案：

- `consumers/codex.js`
- Codex handoff / SessionStart hook entrypoint or CLI wrapper
- `core/session-finalization.js`
- `test/consumer-codex.test.js`
- DB-backed Codex finalization / recovery smoke

先不要碰：

- `consumers/claude-code.js`
- `consumers/openclaw-plugin.js`
- `consumers/shared/ingest.js`
- `consumers/shared/normalize.js` 的既有 contract
- `pipeline/normalize/adapters/codex.js` 的既有 skip semantics，除非只補必要 metadata
- default serving mode
- release docs / README 主線，直到 Codex path 有 DB-backed executable verification

已完成的 SessionStart recovery selection gate：

- Codex hook/CLI wrapper 已能呼叫 `prepareSessionStartRecovery()` / `finalizeCodexSession()`；handoff 已能呼叫 core `finalizeSession()`。
- Manual handoff 已整合到 v1 finalization 路徑，不再依賴 afterburn 的額外 LLM API。
- SessionStart recovery 提示已從單筆候選改為可 DB recovery 清單，並提供全補、挑選補、全部延後、全部拒絕路徑。
- Deferred recovery 預設 suppress SessionStart 重複提示，但可用手動 `--include-deferred` 找回。
- Short session / current transcript / ineligible raw JSONL 不進可補清單；raw scan limit 不得吃掉較舊 eligible JSONL。
- Consented prompt 會直接附上對應 finalize command，finalize 成功後 CLI 會輸出 core committed human review text。
- DB-backed smoke 已覆蓋 Codex recovery finalize -> memory promotion -> curated bootstrap serving、Codex handoff finalize -> shared core review/sessionStart/curated bootstrap serving、Codex import/afterburn -> shared core review/sessionStart/curated bootstrap serving、finalization row 的 minimal `session_start_text`、`incorrect` / `quarantined` / `superseded` 不進 curated recall/bootstrap、DB check constraint 防止 non-active visible leak、older state/open_loop 在 bootstrap scope+limit 下不被 newer decisions 或其他 scope 擠掉、daily rollup owner DB path 只用 active source rows promotion，以及 terminal finalization row 在 retry/upsert 下保持 audit 欄位不變。

下一段仍必須完成：

- Slice 6B 目前可關帳；下一段若繼續，轉到 Slice 7：scope-safe serving、curated recall/bootstrap formatter shape、feedback split 與 release/docs/package surface alignment。

驗證：

```bash
node --test test/v1-*.test.js test/bootstrap.test.js test/recall-mode.test.js test/shared-normalize.test.js test/feedback-agentid.test.js
node --test test/codex-handoff.test.js test/codex-recovery-script.test.js test/consumer-codex.test.js test/session-finalization.test.js test/storage-finalization-status.test.js
AQUIFER_TEST_DB_URL='postgresql://...' node --test test/codex-finalization-serving.integration.test.js
npm run lint
```

若有 `AQUIFER_TEST_DB_URL`，再跑 migration/integration：

```bash
AQUIFER_TEST_DB_URL='postgresql://...' node --test test/migration-handshake.integration.test.js test/v1-curated-writer.integration.test.js test/integration.test.js
```

## 最終判斷

Slice 0-5 已經把 v1 foundation 撐起來，Slice 6A 已補上 transaction-safe curated writer，但還不能稱為 normal-use ready。下一步不是繼續強化 afterburn，而是先把 Codex 做成可感知的 finalization path：handoff / session-end hook / SessionStart recovery / backfill 共用同一 core-owned finalization contract，且不需要額外 afterburn LLM API。Default serving mode 應維持 `legacy`，直到 Codex finalization、scope-safe serving、feedback split、operator jobs 與 release readiness 都通過。
