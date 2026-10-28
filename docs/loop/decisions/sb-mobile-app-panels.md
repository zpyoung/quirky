# sb-mobile-app-panels decisions

## D1: Own every enumerated panel and direct-host notification flow
- **Question:** what does this queue slice include?
- **Options:** mobile foundation again; only static panels; all enumerated flow8 and notification consumer flows.
- **Chose:** mobile Source Control/Review/Files/Tasks/Accounts/History/resume and Notifications consumer flows, on LAN/tailnet. Reuse sb-mobile-app foundation; never duplicate transport or imply nonexistent provider/background-push delivery.
- **Why:** queue title and mobile.md enumerate these flows. API feature owners remain authoritative.
- **Evidence:** queue.ts wait --lane4; mobile.md flow8, Notifications and push, Notifications settings.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** authoritative queue scope changes.
- **Source:** locked by docs/loop/queue.json

## D2: Resolve all relevant gray areas using source-grounded defaults
- **Question:** layout/density/loading/empty/errors/interaction, response/auth/pagination, storage/idempotency and retry/mapping/conflicts.
- **Options:** wholesale Orca port; desktop-panel embedding; thin phone route modules using existing public APIs.
- **Chose:** thin phone route modules with exact Quirky contracts, Changes/Pull Request/Commits tab order, per-host/worktree state, explicit stale/error/empty states, confirmation guards, bounded responsive sheets, no mutation replay and no secret transfer. Detailed default answers and acceptance examples are in logic.md.
- **Why:** source verified phone behavior and existing encrypted bridge preserve one API and existing ownership. Copying upstream would introduce incompatible RPC/cloud/legacy behavior.
- **Evidence:** docs/quirk/specs/2026-10-28-sb-mobile-app-panels/logic.md; docs/architecture.md:298-301; mobile.md:153-182,429-438,500-506.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** real built phone surface disproves usability or bridge feasibility.
- **Source:** assumed — autonomous

## D3: Use night-mode autonomous workflow and isolated implementations
- **Question:** how to apply normal skills unattended with a live early dependency?
- **Options:** human/research/spec gates; autonomous combined spec/contracts and at most three workers.
- **Chose:** no human asks, no research swarm, one combined self-reviewed spec, commit shared contracts first; three disjoint component worktrees and absolute-path-only tools. Parent owns shared integration after dependency arrives. Catch up once before land; one final cross-family review/fix batch; required real smoke and UI dogfood.
- **Why:** authoritative LOOP night rules and prior mobile contamination lessons.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; sb-mobile-app D3; sb-mobile-daemon D11.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** loop instructions change.
- **Source:** locked by docs/loop/LOOP.md

## D4: Pair OpenAI omp workers with Gemini reviewer
- **Question:** which reachable cross-family reviewer?
- **Options:** opus; Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini; three concurrent implementers maximum.
- **Why:** actual pi-watch --check opus exited5 with0/8 shipping/authenticated candidates; --check gemini exited0 google/gemini-3.1-pro-preview:high.
- **Evidence:** this iteration reviewer probes; xd://lsp status reports no configured language servers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Gemini dispatch cannot run.
- **Source:** assumed — autonomous

## D5: Add notification-only replay rather than grant general daemon events
- **Question:** existing notifications API has no mobile subscription or replay; should phones get events.subscribe?
- **Options:** broad daemon events; foreground-only badge reads; scoped bounded notification replay.
- **Chose:** public quirky.mobile/notificationPoll and notificationTest, connection-scoped authenticated device identity,256-record epoch/cursor log, filter-before-replay cursor advancement, one pending waiter per device, disconnect cleanup. Sample macOS IOHIDSystem HIDIdleTime and IOConsoleLocked without exposing user/session data; unknown presence never silences. Test alert bypasses away filtering, no native desktop banner.
- **Why:** Core.broadcast sends all subscribed events without mobile role filtering. A general event grant would unnecessarily expose unrelated plugin data. Long polling fits existing trusted bridge call interface without a new privileged stream.
- **Evidence:** packages/daemon/src/service.ts:74-82; packages/protocol/src/plugins.ts:277-303; actual ioreg output in iteration; notification-replay tests3pass/16assertions and encrypted subscription acceptance1pass/11assertions after red failures.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a typed per-client JSON event subscription capability is introduced.
- **Source:** assumed — autonomous

## D6: Extend Git's public contract for guarded branch switching
- **Question:** mobile Source Control names Switch Branch but no public checkout method exists.
- **Options:** falsely call setBase; defer reachable Git operation; add guarded branch-switch operation.
- **Chose:** PhoneScm also owns the exact Git/protocol busy-operation/desktop exhaustiveness paths it enumerated: new switchBranch and describeSwitchBranch methods, exact listed ref, clean uncapped tree and no active operation, per-worktree lock, optional expected source branch/HEAD, explicit confirmation. Parent owns final mobile allowlist.
- **Why:** public API growth belongs with required feature; changing comparison base is not checkout.
- **Evidence:** agent PhoneScm API survey; existing packages/protocol/src/model.ts GitBusyOp; plugins/quirky.git/src/daemon/lock.ts.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** branch switching conflicts with the existing worktree ownership rules.
- **Source:** assumed — autonomous

## Progress
Contracts/spec committed eb750d27. Three disjoint component workers running in /tmp/quirky-panels-{scm,files-tasks,activity}; HEAD eb750d27, scopes in /tmp/quirky-panel-run.42yijv/journal.json. PhoneScm scope explicitly expanded for guarded Git branch switch. Parent implemented notification-only replay/service and encrypted acceptance (green3unit+1integration); raw presence sampling verified on macOS. Dependency lane5 published newer bridge state/extension contracts53b19b61; merge those next. Native app/pages still in progress. Web dogfood doctor ready. No final suite/build/UI/review claims.
