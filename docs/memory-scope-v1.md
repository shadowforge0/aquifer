# Aquifer Memory Scope v1

狀態：設計收斂草案。

這份文件定義下一版 Aquifer 記憶模型的目標邊界，不是目前 1.5.x runtime 行為的說明。現有 repo 已經有 sessions、summaries、entities、facts、insights、bootstrap 與 recall surface；這份文件的目的，是把未來契約切清楚，避免把 raw session storage 跟 runtime memory 繼續混在一起。

Aquifer 是記憶 repo。OpenClaw、Codex、CC 是 Aquifer 支援的 hosts。Miranda 是 MK 本機數位助理 instance，屬於 deployment/persona 層，不是 Aquifer 核心記憶模型。

## 核心判斷

Aquifer v1 只應承諾三件事：curated memory contract、temporal/scope model、governance semantics。不要在 v1 同時解 graph DB、舊 DB migration、ranking 最佳化、feedback learning、UI 或標註平台。

最重要的規則是：

```text
stored in DB 不等於 usable as memory
```

完整對話與 host artifacts 可以進 DB，但只屬於 evidence。只有通過 promotion 的 curated memory 可以影響 bootstrap 或 `session_recall`。

## 資料平面

v1 分成兩個 physical planes 與三個 serving surfaces。

`evidence plane` 保存 raw 或 normalized evidence。它可以很大、很髒、host-specific、短期保存、redacted、quarantined 或 archived。它用於驗證、蒸餾、除錯與 audit。它不是 runtime memory。

`curated plane` 保存 accepted runtime memory。它必須夠小、夠乾淨、有 scope、有 provenance、有 lifecycle，才能直接注入或 recall。

三個 serving surfaces：

- `bootstrap` 是 deterministic session-start context builder，只讀目前 active 且 scope 適用的 curated memory。
- `session_recall` 是任務中搜尋記憶，只讀 curated memory。
- `evidence_recall` 與 `jsonl_recall` 是顯式取證或 raw artifact access，用來回答「原始上發生什麼」，不是回答「現在 Aquifer 該相信什麼」。

`jsonl_recall` 若保留，只能是低階 artifact access，不是 memory API。

## Pipeline

v1 pipeline 是單向、可追溯、可裁決：

```text
host raw events
  -> raw events
  -> normalized evidence
  -> memory candidates
  -> promotion / quarantine / rejection
  -> curated memory
  -> bootstrap / session_recall
```

Host adapters 可以做 host-specific normalization、session stitching、artifact capture 與 metadata 補齊。它不能直接寫 curated memory，不能定義 authority policy，不能繞過 promotion，也不能把 transient narration 標成 memory。

Candidate extraction 可以提名記憶，但不能決定最終真值。LLM 與 agents 只能提出 candidates，不能自我升格成 accepted memory。

## 術語

`Raw event` 是 host 捕捉到的原始輸入，例如 message、tool call、tool result、JSONL row、rendered artifact 或 host metadata envelope。

`Evidence` 是由 raw event 正規化後、有 provenance 的證據單位。Evidence 可以支援或反駁 memory，但本身不是 runtime memory。

`Candidate` 是從 evidence 抽出的待審記憶，可以評分、去重、定 scope、比對衝突，但還不是可信記憶。

`Curated memory` 是通過 promotion 的 accepted memory。只有 curated memory 可以供 bootstrap 與 `session_recall` 使用。

`Entity` 是 referent 與 alias anchor，可以是人、專案、系統、repo、topic、event、document、tool 或物件。

`Fact` 是關於 entity 或 relationship 的 descriptive claim。Fact 必須帶 scope、time validity、authority 與 provenance。

`State` 是具有時間性的 fact 子類，可能 stale、expired 或 superseded。

`Decision`、`preference`、`constraint` 是 normative memory，描述應該做什麼、偏好什麼、禁止什麼。

`Conclusion` 是從多筆 evidence 或 facts synthesis 出來的工作判斷。Conclusion 有價值，但不能跟 fact truth 混在一起；它可以被後續 evidence 推翻。

`Open loop` 是未完成、需要跨 session 延續的事項，直到 closed、expired 或 superseded。

`Scope` 是記憶適用範圍，例如 global、user、workspace、project、event、session、host 或 assistant instance。

`Applicability inheritance` 是 controlled rule，用來決定某 scope 的 memory 是否能套用到另一個 scope。它不是自動 global promotion。

`Synthesis` 是跨 session 的記憶蒸餾與收斂，不等於 raw transcript 摘要。

## v1 Scope

v1 必須定義：

- Evidence、candidate、curated memory 三層分離。
- Runtime memory types：`fact`、`state`、`decision`、`preference`、`constraint`、`entity_note`、`open_loop`、`conclusion`。
- 每筆 curated memory 都有明確 scope 與 applicability inheritance。
- Valid time 與 system time 分離。
- Finalization 的人類檢視面：使用者必須能直接看到「實際整理進 DB 的記憶內容」，不是只看到 id、hash、row count 或 raw JSON。
- SessionStart injection 的最小 active context contract：只載目前有效且下一段需要接手的 curated memory，不載完整 handoff render 或流程紀錄。
- Daily / weekly / monthly consolidation 的升格規則：當日狀態、跨週模式、長期原則必須分層，不得把錯誤或過期狀態一路 roll up。
- Promotion authority、conflict policy、feedback semantics、delete semantics。
- Deterministic bootstrap 與 curated-only `session_recall`。
- `evidence_recall` 與可選 raw artifact access，跟 memory recall 分開。
- 舊 DB reset 與 archive distillation 邊界。
- 最小版本 metadata：schema、normalizer、extractor、promotion policy、embedding model、ranker。

v1 應使用 PostgreSQL 作為 source of truth。Graph-like 行為可以先用 relational edge tables、recursive CTE、materialized views、FTS 與 pgvector 支撐。v1 不需要獨立 graph DB。

## Non-Goals

v1 不提供預設 full-transcript search 作為 memory recall。

v1 不把 raw transcript、tool output、debug narration、failed hypothesis、rendered markdown 或 host wrapper metadata 注入 runtime memory。

v1 不把技術回傳欄位當成使用者可檢查的記憶輸出。`handoffId`、`transcriptHash`、row count、render path、test list、DB write plan 只能作為 audit footer，不能作為 finalization 的主內容。

v1 不把 Miranda 做成 schema 概念。

v1 不承諾舊 DB backward compatibility 或 online migration。

v1 不自動升格所有 LLM 抽出的內容。

v1 不做通用 knowledge graph 產品。

v1 不解完整 cross-host sharing policy，只先提供 deny-by-default isolation 與 explicit curated promotion。

v1 不讓 feedback 直接改寫真值。

v1 不要求 UI、annotation platform、external facts ingestion 或 automatic re-embedding orchestration。

## Memory Identity

Curated memory identity 必須穩定到可以測試、去重與 supersede。最小 canonical key：

```text
kind + subject + aspect/predicate + scope + context_key/topic_key
```

Facts 的 structured assertion 至少包含：

- `subject_entity_id`
- `predicate`
- `object_kind`
- `object_entity_id` 或 `object_value_json`
- `qualifiers_json`
- `valid_from`
- `valid_to`
- `observed_at`
- `stale_after`
- `authority`
- `status`
- `assertion_hash`

`valid_from` 與 `valid_to` 描述 claim 在世界中的有效時間。`accepted_at`、`revoked_at`、`superseded_at` 描述 Aquifer 何時採信或退休該 claim。這兩種時間不能混。

## Scope 與 Inheritance

每筆 memory 都必須有 scope。預設 scope 應該是最窄安全範圍，不是 global。

建議 scope kinds：

- `global`
- `user`
- `workspace`
- `project`
- `event`
- `session`
- `host_runtime`
- `assistant_instance`

Inheritance 必須顯式且保守：

- `exclusive`：最窄適用 memory 勝出。
- `defaultable`：較廣 scope 的 memory 可作為預設，但可被較窄 scope override。
- `additive`：多層 memory deterministic merge 並去重。
- `non_inheritable`：只在原 scope 生效。

Preferences 通常是 `defaultable`。Constraints 通常是 additive 或 strict，較窄 scope 可以加嚴，但不能默默放寬較廣 scope 的限制。Decisions 通常是 scope-bound。Open loops 通常 non-inheritable，除非明確 promoted。Host runtime evidence 預設 non-inheritable。

例子：

- `Aquifer 支援 OpenClaw、Codex、CC` 是 product/project-scope conclusion。
- `Miranda 對 MK 使用繁中 briefing style` 是 assistant-instance/user-scope preference 或 constraint。
- `這次只定義不改檔` 是 session/task scope，不應自動變成長期政策。

## 時間模型與 Distillation

Temporal distillation 是 memory consolidation pipeline，不只是 timer summary。

v1 最小時間階層：

- Session close：從 session 捕捉 evidence 與 candidates。
- Daily close：保留較多細節，產出 daily memory bundle。
- Weekly consolidation：依 project、entity、thread 合併 daily bundles，去重、關閉或老化 open loops。
- Monthly distillation：只保留 durable decisions、preferences、constraints、stable facts、重要 conclusions、長期 open loops，舊細節降到 archive。

每一層的語意不同：

- Session finalization 產出本段可被記住的 curated memory 與必要 evidence，不等於操作流水帳。
- Daily bundle 記當日狀態、當日完成/卡點、當日仍有效的 open loops，以及當日被作廢或修正的狀態。
- Weekly consolidation 只升格跨日仍成立的模式、決策、風險、工作方向與 unresolved loops；單次 test pass、工具輸出、debug id、臨時 render plan 不得升格。
- Monthly distillation 只保留長期原則、穩定偏好、架構方向、持續性 facts / constraints，以及仍未完成但確實長期有效的 open loops。

錯誤、過期或已被使用者否定的內容可以保留為 evidence 或 lifecycle event，但不得成為 active daily/weekly/monthly output。若某筆 daily memory 後續被判定 incorrect / superseded，weekly/monthly 必須看到其 lifecycle state，不能把舊 daily 當 current truth。

Consolidation trigger 不只時間：

- 多個 candidates 共享同一 canonical key。
- 新 evidence 與 active memory 衝突。
- Open loop 超過 TTL。
- 窄 scope memory 可能需要升到較廣 scope。
- Normalizer、extractor、ranker 或 promotion policy version 改變。

每次 compaction run 應記錄：

- `compaction_run_id`
- `run_kind`
- `window_start`
- `window_end`
- `ruleset_hash`
- `source_memory_ids`
- `output_memory_ids`
- `status`
- `stats`

同一 input snapshot、同一 versions、同一 ruleset 必須產生同一 outputs。

Compaction writer 必須分階段落地，不能把「有 ledger」誤當成「rollup 已可正常使用」。第一階段只允許 deterministic plan、coverage ledger，以及 guarded lifecycle retire，例如把已過期的 active open loop 以 CAS 從 `active` 轉成 `stale`；它不得產生 active aggregate memory，也不得繞過 promotion gate。第二階段加入 `compaction_runs` claim/apply token、同 period live apply winner 約束、transaction-scoped claim window lock 與 DB-backed concurrency smoke。第三階段才產生日/週/月 aggregate candidates，且 canonical key 必須包含 tenant/scope/cadence/closed window，候選仍需走 promotion。

目前已落地的是第一階段、第二階段與第三階段的 candidate planner 骨架：`planCompaction()`、coverage-aware `recordRun()`、`claimRun()`、`updateMemoryStatusIfCurrent()` 與 `applyPlan()`。`compaction_runs` 已有 `applying`、`apply_token`、applying row shape check、one-applying-worker guard、schema-scoped/canonical-period claim window advisory lock，以及基於 DB-time `lease_expires_at` 的 stale applying lease reclaim；歷史 `applied` ledger 不進 unique index，避免舊 DB migration 因不同 input hash 的既有 applied row 失敗。`planCompaction()` 對 daily/weekly/monthly closed windows 會產生 deterministic aggregate candidates，canonical key 包含 tenant/scope/context/topic/cadence/window，payload 包含 `candidateHash` 與 source memory lineage；`applyPlan()` 在真 DB pool path 會先 claim，claim 不到就不做 lifecycle mutation，aggregate candidates 只會留在 run output，不能直接成為 active memory。DB-gated multi-worker smoke 已覆蓋同 snapshot single-winner、不同 input hash loser path 與 stale applying reclaim。這只能宣稱 open-loop retire、claim guard、candidate planning 與 ledger apply path 已有 transaction-safe 骨架，不能宣稱 daily/weekly/monthly rollup writer 已完整完成；仍需 operator job、正式 promotion/write path 與 DB-backed lineage。

## Finalization 與 Human Review Surface

Finalization 是把一段 session 從 evidence/candidate 轉成 runtime memory 的唯一收尾動作。Manual handoff、session-end hook、SessionStart recovery、backfill 都只是不同 trigger；成功標準必須相同。

一個 successful finalization 必須同時產生兩個 surface，且兩者必須來自同一個 committed snapshot：

- Machine surface：寫入或更新 evidence、session summary、candidate/promotion result、curated memory、evidence refs、finalization ledger。
- Human review surface：用簡潔人話輸出「已整理進 DB 的記憶內容」，讓使用者能判斷這筆記憶是否可回查、可接續、會不會污染未來 context。

Human review surface 的主內容必須按 memory 語意呈現，而不是按 DB 欄位呈現：

- 本段目前狀態：這段 session 對目前工作的最新有效狀態。
- 已接受記憶：actual active curated decisions、states、facts、conclusions、preferences、constraints、entity notes。
- 未完成事項：仍 active 的 open loops，必須有 scope、owner 或下一步語意。
- 已作廢/修正：本段推翻、supersede、quarantine 或標成 incorrect 的舊記憶。
- 下一段 SessionStart 會載入：只列會進 active bootstrap 的最小接續資訊。
- 不會載入：工具流水帳、測試輸出、debug id、render plan、row counts、raw transcript、被拒絕或作廢的內容。

Canonical shape：

```text
已整理進 DB：

目前狀態：
<這段 session 結束後仍成立的狀態，一到三句。>

已記住：
<accepted active curated memory，以人能回查的語句列出 decision/state/fact/conclusion/preference/constraint/entity note。>

未完成：
<active open loops；沒有就寫「無」。>

已作廢或隔離：
<superseded / incorrect / quarantined / revoked 的內容；沒有就寫「無」。>

下一段只需要帶：
<SessionStart 會注入的最小 active context。>

不要帶：
<不會進 SessionStart / active recall / rollup 的 debug、test、tool、render、id/hash/count、raw evidence 或錯誤狀態。>
```

Human review surface 可以在最後附 audit footer，例如 finalization id、transcript hash、promoted count、quarantine count、schema/policy version。這些 footer 不能取代人話整理，也不能作為使用者驗收主體。

如果系統只能回傳 JSON、id/hash、row count、test output、render path，卻不能輸出 committed curated memory 的人話整理，這次 finalization 不算 user-accepted。它最多是 debug write，不應進 active curated serving。

`handoffText` 是 legacy continuity surface，只能作為 optional metadata 或 daily/handoff log。它不能單獨成為 `summaryText`，也不能單獨 promotion 成 v1 memory。`summaryText` 必須摘要整段 sanitized transcript；`structuredSummary` 必須產出 memory candidates。

## Promotion 與 Authority

Promotion 應該是 policy gate，不是單一分數門檻。

最小三道 gate：

1. Eligibility gate：判斷內容類型是否能成為 memory。
2. Authority gate：判斷來源是否足以支撐該 memory type。
3. Scope/privacy gate：判斷適用範圍、安全狀態、是否可服務 bootstrap 或 recall。

Authority order：

```text
user explicit
  > repo / DB / test executable evidence
  > verified curated summary
  > LLM inference
  > raw transcript
```

Raw transcript 可以支援 evidence，但不應自動變成 accepted memory。LLM inference 可以提名 candidates，但不能批准自己。

來源、scope、時間窗、authority 或 privacy posture 不清楚時，必須 quarantine。

## Conflict Policy

Normative memory 與 descriptive memory 使用不同 conflict rules。

Normative memory 包含 decisions、preferences、constraints、pins、revokes、explicit instructions。User explicit instruction 在 preference 上優先，但 repo/test evidence 可以證明偏好是否已被實作。

Descriptive memory 包含 facts、states、entity attributes、observable system claims。Current executable evidence、repo state、tests、source-of-truth DB 或 live tool observations 優先於舊 curated claims。User statement 如果跟 executable evidence 衝突，應先記成 claim 或 planned change，不應直接覆蓋 active fact。

同 authority 衝突時，先比窄 scope，再比 valid time，再比 stable source id。仍無法裁決時 quarantine，不 silent merge。

## Feedback

Feedback 不是 truth mutation。

建議 vocabulary：

- Retrieval feedback：`helpful`、`irrelevant`、`scope_mismatch`
- Truth/lifecycle：`confirm`、`stale`、`superseded`、`incorrect`、`conflict`、`expired`
- Curation/policy：`promote`、`pin`、`unpin`、`authority_mismatch`、`sensitive`、`archive`

Retrieval feedback 可以影響 ranking、trust score 或 review priority。它不能直接改 memory content、authority、observed time、scope 或 active winner。

## Delete 與 Retention

Delete 需要產品語意，不只是 SQL deletion。

最小 lifecycle states：

- `candidate`
- `active`
- `stale`
- `superseded`
- `revoked`
- `tombstoned`
- `quarantined`
- `archived`

Raw evidence 的 retention 應短於 curated memory。未 redacted raw evidence 若真的保留，必須在 search 與 embedding indexes 外。Redacted evidence 可保留供 distillation 與 audit。Archive 預設 offline，不屬於 live recall。

## 安全與污染控制

禁止自動 promotion 的類別：

- Tool narration 與 progress commentary。
- Failed hypotheses 與 abandoned debugging paths。
- Host wrapper metadata。
- Session-start injected context。
- 由同一 session 派生的 rendered markdown。
- Raw tool output 與 stack traces，除非被轉成 scoped、supported claim。
- Secrets、credentials、tokens、cookies、keys、connection strings、private environment values。

Redaction 必須發生在 indexing 或 embedding 前。Embeddings 與 FTS indexes 只能吃 redacted copy。

Host-private evidence 不得跨 host。跨 host sharing 只能發生在 redaction、promotion 與 explicit scope classification 之後。

Archive distillation 必須讀 immutable snapshot，只輸出 candidates，並重新走同一條 promotion pipeline。它不能直接寫 accepted memory。

## PostgreSQL Model

建議 v1 schema direction：

- `raw_events`：append-only host-captured inputs。
- `evidence_items`：normalized、redacted evidence units。
- `scopes`：scope tree 與 inheritance metadata。
- `entities`：canonical referents 與 aliases，依 namespace scope 區隔。
- `facts`：structured descriptive assertions。
- `memory_records`：runtime-visible accepted memory。
- `evidence_refs`：facts 或 memories 指向 evidence 的 provenance links。
- `versions`：schema、normalizer、extractor、promotion policy、embedding model、ranker versions。
- `compaction_runs`：deterministic consolidation audit。
- `feedback`：retrieval 與 lifecycle feedback events。

`memory_records` 是 bootstrap 與 `session_recall` 的 runtime source。`facts` 是 assertion plane。`fact` 類型的 memory record 應指向 `backing_fact_id`，不要在文字欄位裡重複藏 structured truth。

適合先用的 PostgreSQL 能力：

- Recursive CTEs：scope ancestry 與 supersession chains。
- Materialized views：active visible memory 與 fact edges。
- GIN FTS：lexical search。
- pgvector HNSW：curated-memory semantic candidates。
- JSONB：只放 qualifiers 與尚未穩定成欄位的 metadata。

Graph 是 projection，不是 source of truth。`mv_fact_edges` 可以把 entity-to-entity facts 攤成 edge view，支援有限 traversal。獨立 graph DB 應等到線上 multi-hop path reasoning 成為真 bottleneck 再談。

## Bootstrap Contract

`bootstrap` 不是搜尋。它從 active curated memory materialize deterministic bundle。

排序政策應 versioned 且 deterministic。建議 priority：

1. Active constraints 與 safety rules。
2. Active user/workspace/project preferences。
3. Current project/session state。
4. Open loops。
5. Recent 或 pinned decisions。
6. 與 active scope 相關的 stable facts 與 conclusions。

Mandatory set 放不進 token budget 時，bootstrap 應回報 overflow 或 degraded output，不要 silent drop required memory。

同 snapshot、同 active scope、同 budget、同 policy version 必須輸出 byte-identical result。

## SessionStart Injection Contract

SessionStart injection 是 bootstrap 的 host-facing output，不是 handoff render，不是 session summary dump，也不是 daily log 全量回放。

SessionStart 只能載入下一段能立即用到的最小 active context：

- still-active constraints、preferences 與 safety rules。
- current project/session state。
- active open loops 與下一步。
- recent active decisions 或 conclusions。
- 必要的 scope/entity anchors。

SessionStart 禁止載入：

- complete handoff render。
- raw transcript 或 evidence dump。
- test output、tool output、debug narration、DB write plan、row counts、id/hash、render path。
- rejected、quarantined、incorrect、superseded、expired、tombstoned 或 archived memory。
- 已被 daily/weekly/monthly 證明過期的舊狀態。

若 mandatory active context 超過 budget，SessionStart 必須回報 degraded/overflow，並 deterministic 地保留 constraints、current state、open loops。它不得用 raw evidence fallback 補字數，也不得 silent drop required memory。

## Recall Contract

`session_recall` 只搜尋 curated memory。

它可以融合 FTS、pgvector、entity filters、scope proximity、authority、freshness、support count 與 feedback priors。它不能為了命中率 fallback 到 raw transcript 或 evidence items。

`evidence_recall` 只搜尋 evidence，且應要求更窄 filters，例如 scope、host、source、session 或 time range。它必須是顯式且可 audit 的取證工具。

## Incorrect Memory Handling

錯誤 finalization、錯誤 promotion、錯誤 handoff、錯誤 rollup 都必須能從 active serving path 移除，不得靠「再寫一筆新 summary」掩蓋。

最小處理語意：

- `incorrect`：內容錯誤，不可進 active recall/bootstrap。
- `superseded`：曾經有效，但已被較新 memory 取代。
- `revoked`：使用者或高權威來源明確撤銷。
- `quarantined`：來源、scope、authority、privacy 或 conflict 未通過 gate。
- `tombstoned`：保留刪除/audit 記錄，但不再提供 runtime。

被標成上述狀態的 memory 可以被 `evidence_recall` 查到，但 `session_recall`、`bootstrap`、SessionStart、daily/weekly/monthly active rollup 都不能把它當 current truth。清理錯誤 DB 寫入時，必須同時處理 finalization ledger、summary、curated records、evidence refs、fact assertions、daily/handoff legacy surfaces 與可能的 rollup outputs，避免留下 orphan 或 active 污染。

## 舊 DB 策略

舊 DB 可以從 live serving 拋棄。

Reset acceptance：

- 新 v1 DB 可從 empty active store 啟動。
- Bootstrap 正常工作。
- 新 sessions 可寫入。
- `session_recall` 對 old-only entities 回 empty 是正確結果。
- 舊 DB、embedding index、FTS table、cache、archive shadow 都不在 live recall path。

舊 DB distillation 是可選 offline job：

```text
old DB snapshot
  -> redacted archive evidence
  -> deterministic extraction
  -> candidates
  -> normal promotion gate
  -> curated memory
```

任何 distilled item 都不能跳過 provenance 或 promotion。

## Acceptance Tests

Blocking v1 invariants：

- `forbidden_promotion_rate = 0`
- `traceability_rate = 100%`
- `scope_leak_rate = 0`
- `active_conflict_rate = 0`
- Human review coverage = 100%：每次 finalization 都能輸出人話整理，且主內容來自 committed curated memory，不是技術欄位。
- SessionStart noise rate = 0：SessionStart 不載入 debug/test/tool/render/id/hash/raw evidence。
- Incorrect active leakage = 0：被標錯誤、作廢、過期或 quarantine 的 memory 不得出現在 active recall/bootstrap/rollup。
- Bootstrap 對同 snapshot 與 budget byte-identical。
- Feedback 不 mutate truth。
- Evidence recall 不得 implicit feed bootstrap。

Golden suites：

- Host parity：OpenClaw、Codex、CC 對同語意 input 產生同一組 curated memory。
- Pollution：commentary、tool narration、failed hypotheses、injected context、rendered artifacts、wrapper metadata 都不能進 curated memory。
- Scope inheritance：persona-local、session-local、workspace、project、entity facts 都留在正確 scope。
- Temporal `asOf`：promotion、supersede、revoke、open-loop close、fact validity intervals 都能正確解析。
- Compaction determinism：同 snapshot 重跑 daily/weekly/monthly 產生同 outputs。
- Rollup semantics：daily 記當日狀態，weekly 只升格跨日模式/決策，monthly 只保留長期原則；錯誤 daily 不得升格到 weekly/monthly。
- Human finalization output：同一 committed finalization 必須能產生簡潔人話輸出，列出 accepted、open、superseded/quarantined、SessionStart include/exclude。
- Old DB reset/distill：reset 不依賴 legacy live path，distill idempotent 且 promotion-gated。
- Feedback semantics：允許 ranking change，不允許 truth change。

Golden corpus 應包含 raw evidence、expected candidates、expected curated memory、expected bootstrap output、expected recall output、expected `asOf` snapshots。Oracle files 必須人工定義並鎖版，不能從目前實作輸出回填。

## vNext Candidates

這些概念要保留在文件裡，但不納入 v1 blocking scope。

Graph-native retrieval：entity neighborhood expansion、path reasoning、contradiction graph、community detection。等 v1 fact/entity/scope model 穩定後再做。

External graph DB：Neo4j、FalkorDB、Kuzu、Apache AGE。只有在 PostgreSQL materialized views 與 recursive CTEs 無法支撐真實 runtime path 時才考慮。

Advanced archive distillation：manual review queue、batch provenance dashboard、old DB cold-start seed workflow。

Feedback learning：用 feedback 調 ranking、review priority、promotion thresholds、stale detection，但不直接改 truth。

Embedding/version drift repair：embedding model 或 policy 改版後，重跑 re-embed、re-rank、re-materialize projections。

Richer quality signals：source trust、evidence coverage、contradiction density、support count、memory age、review confidence。

Cross-host sharing policy：OpenClaw、Codex、CC 之間 selective sharing。前提是 v1 已有穩定的 `host-private` 與 `workspace-shared` scopes。

External facts sources：repo metadata、issue tracker、calendar event、docs index、source-of-truth DB snapshot。這些只能先作為 evidence/import source，再走同一條 promotion pipeline。

Retrieval orchestration：在 bootstrap、`session_recall`、`evidence_recall`、synthesis lookup、graph search 之間做明確路由。前提是每個 surface 的 contract 已固定。

Benchmarks：large-corpus recall quality、compaction quality、token budget efficiency、distillation precision/recall、long-memory benchmark suites。

## 參考專案與可借概念

主參考：

- [Graphiti](https://github.com/getzep/graphiti)：temporal context graph、episode provenance、validity windows、incremental updates、hybrid retrieval。
- [Microsoft GraphRAG](https://github.com/microsoft/graphrag)：graph extraction、community hierarchy、global/local retrieval、traceable artifacts。
- [Letta](https://github.com/letta-ai/letta)：stateful agent memory、memory tiers、context-window management。
- [Mem0](https://github.com/mem0ai/mem0)：memory-layer API vocabulary、add/update/delete/noop operations、graph memory direction。
- [Cognee](https://github.com/topoteretes/cognee)：extraction 與 knowledge-memory pipeline ergonomics。
- [pgvector](https://github.com/pgvector/pgvector)：PostgreSQL-native vector search。

次參考：

- [LangMem](https://github.com/langchain-ai/langmem)：semantic、episodic、procedural memory taxonomy；background memory management。
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval)：long-term memory evaluation，包含 extraction、multi-session reasoning、knowledge updates、temporal reasoning、abstention。
- [LoCoMo](https://github.com/snap-research/locomo)：long-term conversational memory data format，包含 sessions、timestamps、summaries、events、QA、evidence ids。
- [Apache AGE](https://github.com/apache/age)：未來可能評估的 PostgreSQL graph extension，不是 v1 dependency。

採用度是參考排序訊號，不是架構真理。高星專案適合借 vocabulary 與 proven patterns，但 Aquifer 的 authority、scope、promotion、pollution controls 必須維持自己的 contract。

## 最終邊界

Aquifer v1 成功的標準，是不同 hosts 可以有不同 runtime 行為，但對同一套記憶答案達成一致：什麼能被記住、什麼能被注入、什麼只能當 evidence、什麼只在特定 scope 生效、什麼已 stale、什麼已 superseded，以及什麼永遠不能跨過 curated boundary。
