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

## D7: Bind subscription cancellation to an authenticated device and generation
- **Question:** how does disabling or leaving the page release a long poll when the shared native RPC connection stays alive?
- **Options:** wait25seconds and risk re-enable conflicts; close the shared connection; generation-scoped cancellation.
- **Chose:** optional subscriptionId on polls and notificationCancel; only the authenticated caller's matching waiter is cancelled. A stale old-page cleanup cannot cancel a replacement. The page root owns one DirectNotifications manager across all routes; settings edit its shared preferences and in-app alerts navigate using authoritative worktree/session IDs.
- **Why:** page unmount is not transport disconnect, and a device-global late cancel races the next page generation. No new broad event or socket privilege is necessary.
- **Evidence:** notification-replay.test.ts stale-generation and cross-device regression; encrypted notifications.test.ts cancellation/replacement/revocation and real quirky.notifications/send capture;5tests39assertions passed. Actual CLI->daemon->sealed-phone->CLI replay smoke passed with both desktopAway false and true sampled on separate runs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public bridge gains per-request cancellation.
- **Source:** assumed — autonomous

## D8: Keep native background push separate from direct foreground subscriptions
- **Question:** should the direct-only phone claim upstream APNs/FCM registration and background delivery?
- **Options:** call Orca's service; fake background push with foreground events; defer the external push service while shipping real direct subscriptions.
- **Chose:** real scoped direct foreground subscriptions and in-app notification routing; no upstream service calls or token registration. Record APNs/FCM gateway/native entitlement/token/lease/background-tap integration in the single follow-up before landing. macOS idle/lock filtering ships now; Linux/Windows presence probes and actual mobile device background behavior require platform work.
- **Why:** neither Quirky notifications nor mobile APIs provide native push registration/gateway; external operator-controlled delivery credentials and native app entitlements are unavailable. Architecture disallows upstream hosted relay and never authorizes reusing Orca's push account/service. A socket event is not background OS delivery.
- **Evidence:** quirky.notifications manifest public status/send/test/preview; mobile.md429-438; sb-mobile-app D2/D6 and spec excluded hosted services; actual reviewer/runtime capability survey.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an operator-controlled push service and native app delivery credentials are configured.
- **Source:** deferred: native background push service

## Progress
Contracts/spec committed eb750d27. Parent notification service17bbe2b7, with cancellation/CLI correction now verified5tests39assertions plus actual CLI smoke. Dependency bridge state contracts merged through53b19b61. Three independent component workers still running; parent owns shared route/auth integration only after base lands per itsD7. Native handoff written pending. Web dogfood driver ready; final affected-suite/scripts/typecheck/build/built-UI/review/land remain to execute. No whole-suite local run is planned: night-mode rule reserves it for queue land despite protocol changes.
