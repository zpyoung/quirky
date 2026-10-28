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

## D9: Respect absent non-GitHub Tasks provider prerequisites
- **Question:** mobile.md names GitLab, Linear and Jira Tasks, but which provider contracts can a paired phone actually consume?
- **Options:** fabricate provider rows/data; build unreviewed provider backends inside a phone component; expose truthful availability and defer each backend-dependent flow.
- **Chose:** ship complete reachable GitHub Tasks through public tasks/hosting APIs, including available PR mutations. GitLab/Linear/Jira source selectors explain the unavailable provider. Include their query/filter/list-board/detail/comments/field edits/workspace-link flows in the one follow-up with the exact provider API prerequisite. Do not override blocked GitLab provider decisions.
- **Why:** quirky.tasks is explicitly GitHub-backed; no quirky.linear or quirky.jira plugin exists. GitLab hosting/API/UI/workspace queue items are blocked, not ready foundations for a phone consumer. Source availability must not imply a usable backend.
- **Evidence:** plugins/quirky.tasks manifest and src/ui.tsx provider availability; queue status and authoritative queue entries m4-hosting-api-gitlab/m4-hosting-ui-gitlab/m4-worktrees-create-from-gitlab blocked; PhoneFilesTasks inventory and handler survey.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** provider-owned public task list/detail/mutation/workspace contracts land.
- **Source:** deferred: non-GitHub Tasks providers

## D10: Require a real terminal artifact producer before exposing outside-worktree edits
- **Question:** what does the source's Save terminal artifact action actually authorize?
- **Options:** mislabel ordinary file Save; accept arbitrary absolute phone paths; defer the source/grant prerequisite while shipping contained file editing.
- **Chose:** normal Files stays worktree-contained. Preserve the independent terminal-artifact flow in the one follow-up: authoritative terminal path producer, opaque grant/source route, resolve/read/preview/conditional write and grant-refresh refusal classification. Never mint outside-worktree authority merely from a phone-supplied absolute path.
- **Why:** upstream source only exposes this action for writable nontruncated text with source terminalArtifact; it verifies the base content before overwrite and renews a refused grant. Quirky has no corresponding terminal artifact producer/API or opaque route contract. PDF export and normal editor Save are not substitutes.
- **Evidence:** read-only upstream mobile/src/files/MobileFilePreviewScreen.tsx and mobile-file-preview-request.ts; upstream files.readTerminalArtifact/readTerminalArtifactPreview/writeTerminalArtifact/resolveTerminalPath call shapes; Quirky terminal/editor API inventory; PanelRoute currently carries contained relative paths only.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** authoritative terminal artifact grants become part of the public terminal/files API.
- **Source:** deferred: terminal artifact authority prerequisite

## D11: Keep configured environments out of phone metadata at the producer
- **Question:** vault preparation and raw agent listing include host credentials even if a page later hides those fields.
- **Options:** client-side redaction; recursive transport scrubbing; exact producer projections and no secret-bearing calls.
- **Chose:** deny vault.prepareResume and agents.list to phones. History calls vault.resume directly because it already prepares server-side; VaultActions omits optional Session.launch only for mobile callers. Base commit3fc2dceb likewise projects mobile session list/get/create/resume/restore/setName. Add public quirky.mobile/agentCatalog with defaultAgent and agent id/label/installed/enabled/isDefault/resumable, no command/args/env/path. Publish module/test-only commit619876b9 for the base to cherry-pick, avoiding a child-to-base dependency cycle. Field installed matches canonical agent metadata; no available alias.
- **Why:** real mobile-role vault acceptance reproduced the configured secret inside launch.env before the fix. Catalog inspection showed effective configured env; withholding display is too late once a page has received it. Local callers and host launch records retain the real environment.
- **Evidence:** vault actions.ts59–90,262–280; AgentsService.info538–558; encrypted catalog regression green1test6assertions; vault regression red at secret presence then green1test5assertions; merged base Session regression and both tests3pass25assertions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a new phone method returns a launch plan or credential-bearing agent metadata.
- **Source:** supersedes sb-mobile-app D13 (catalog field installed, not available); assumed — autonomous

## D12: Use bounded draft transfers and authoritative workspace outcomes
- **Question:** how to preserve1MiB file editing through64KiB mobile string limits, and how Tasks reports an already-linked workspace.
- **Options:** silently cap edits; send an oversized request; existing bounded editor transfer. Treat every result as created; preserve resumed as an authoritative distinct outcome.
- **Chose:** direct drafts at most48KiB; larger drafts use UTF-8 transfer begin/chunk/commit/cancel,48KiB decoded chunks and1MiB total, CAS revision and acknowledged offsets. Admit draft transfer only, not create/import/overwrite. Recognize actual Tasks resumed results, never label them created, and navigate to the authoritative worktree after completion. Keep navigation errors visible without denying that creation already succeeded.
- **Why:** source preview cap exceeded transport string budget; existing public editor transfer already solves this without new authority. Provider fixture analysis confirmed kind:resumed on repeated start. Regression failed invalid-versus-resumed before the parser fix.
- **Evidence:** editor manifest407–438; FilesTasks transfer implementation; activity proof source report; files-tasks model regression red then green; panel policy tests3pass19assertions; model+policy7pass81assertions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the bridge or Tasks workspace result contract changes.
- **Source:** assumed — autonomous

## D13: Audit and integrate complete component source before surface verification
- **Question:** worker source claims are not build or UI proof.
- **Options:** accept reports; audit exact scopes/HEAD and run targeted checks after the wave barrier.
- **Chose:** all three HEADs stayedeb750d27 and source paths matched declared scopes; inherited .serena remained unstaged. Parent ran Activity3tests11assertions, FilesTasks4tests61assertions, SCM+branch15tests46assertions, committed7566633c/780fb5f6/1f3564b1, merged and removed all three component trees. Removed mock resume forwarding and tautological dirty-navigation tests rather than repinning them. A real panel-entry compile then exposed escaped JSX attributes in Activity; fixed only those lines, and compilation bundled7modules successfully with React external. This is compile proof only, not a browser or native pass.
- **Why:** model-only tests do not parse/render feature TSX. Scope audit prevents default-workspace contamination; build and actual user-surface proof remain separate gates.
- **Evidence:** parent component audit outputs, targeted tests and commit results; TypeScript parse diagnostics; bun build apps/mobile/src/panels/index.tsx --target browser --external react --external react/jsx-runtime --external react-dom/client compiled0.33MB.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an external worker edit appears outside its declared tree.
- **Source:** assumed — autonomous

## D14: Correct process-fixture isolation without guessing at user-state rollback
- **Question:** did each new daemon fixture isolate both Quirky state and agent configuration homes?
- **Options:** assume temporaryQUIRKY_HOME was enough; repair the fixture boundary and disclose the missing before-state.
- **Chose:** owned HOME/QUIRKY_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR; disable unrelated auto-hooks before daemon activation; clear inherited Git directory/index/object pointers in the physical Git proof. Preserve environment and stop/remove owned resources. Record the earlier ambient-HOME gap in BLOCKERS and do not blindly remove or restore real user files.
- **Why:** the first notification API/CLI fixtures replaced only QUIRKY_HOME. All-built-in activation included hook support, so that was not a valid isolation guarantee. No before-state hash was recorded and output did not confirm a write; neither actual mutation nor zero effects can be claimed.
- **Evidence:** original notifications fixture startHarness call and smoke setup; corrected3file regression3pass28assertions; corrected CLI settings/catalog/sealed notification/replay smoke passed; docs/loop/BLOCKERS.md isolation observation.
- **Reversibility:** medium
- **Confidence:** high for fixture correction, unknown for earlier home effects
- **Revisit if:** a trustworthy pre-run user-configuration backup becomes available.
- **Source:** assumed — autonomous

## D15: Repair both advertised CLI and guarded confirmation contracts
- **Question:** structural plugin validation found a camelCase CLI key and missing describer guard fields.
- **Options:** relabel the advertised command or omit source guards; preserve both public contracts and fix their registration/schema.
- **Chose:** mobile open-settings uses the actual short CLI module key. describeSwitchBranch accepts and validates optional expectedBranch/expectedHead forwarded by the confirmation dispatcher; the narrow phone policy includes the same fields. Remove the incidental API-schema property-copy assertion; retain real CLI decline/confirm and physical Git branch checks.
- **Why:** the actual CLI smoke reproduced no command open-settings. The guarded CLI regression never reached its expected ask because describer schema validation rejected the forwarded source snapshot. After repair, the CLI smoke opens the real settings view and guarded decline/confirm test passes.
- **Evidence:** MobilePluginStructure report; settings smoke red then green; guarded branch CLI red wait timeout then1test5assertions green; actual method describer forwarding in packages/daemon/src/plugins/confirm.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the kernel changes destructive describer argument forwarding.
- **Source:** assumed — autonomous

## D16: Prepare private-branch panel admission before the base queue item lands
- **Question:** baseD7 delays shared admission edits until its landing, but the canonical early-item procedure requires implementing and verifying against pending dependency branches.
- **Options:** leave completed panel consumers unverifiable until the base full-suite land; prepare the additive cutover only on this item's private branch.
- **Chose:** parent alone wires its bounded panel-policy module into this branch's existing admission function, removes replaced literal definitions and the scope/identity collision, and runs sealed consumer acceptance. Lane5's worktree and branch remain untouched. Preserve all incoming base methods on the final dependency merge and wait for queue readiness before landing.
- **Why:** several canonical deps checks returned ready:false with only sb-mobile-app pending. The new contained-editor acceptance failed -32001 before cutover. This is implementation against committed contracts, not a base ownership takeover or a bypass of landing dependencies. A single integration owner resolves any additive merge overlap.
- **Evidence:** authoritative LOOP.md Early items steps2–4; scoped editor acceptance red; component source/HEAD audits; parent-only panel-authorization module and actual producer schemas.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the base changes the admission contract rather than adding methods.
- **Source:** supersedes sb-mobile-app D7 (private-branch admission timing only)

## D17: Apply the already-over-two-hours completion rule without overstating verification
- **Question:** which remaining review/dogfood steps apply after the item's time window while the base is still pending?
- **Options:** start new full campaigns; finish existing source/integration and required test/typecheck/runtime smoke, then land as soon as dependencies allow.
- **Chose:** no new feature flows, formal review round or full dogfood campaign. Finish encrypted API acceptance, typecheck and actual changed-surface smoke; record exact exercised evidence and limits. The native handoff and one completion follow-up retain unmet prerequisite-dependent flows and any unexercised full UI variants. Never end while dependency work or owned helpers run, and never land before deps ready.
- **Why:** authoritative night mode says an already-over-two-hours item lands as soon as its own checks pass, skipping a review/dogfood pass not started. Developer verification still requires a real runtime smoke; compilation alone is not surface proof.
- **Evidence:** authoritative LOOP.md Night mode and Early items; iteration checkpoint clock; canonical deps ready:false.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes the completion rule.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Feature source components merged and original trees removed. Parent safe metadata APIs and vault projection verified; scoped panel admission module written and unit-verified but not wired into shared base authorization until base lands perD7. Two isolated encrypted acceptance components exist at /tmp/quirky-panels-{git-editor-proof,activity-proof}, source-only and not yet accepted; parent must run them against final policy. Browser host helper is being authored under /tmp/quirky-panel-run.42yijv/ui against actual final PageApp and sealed RPC, no fake backend. Dependency still pending; current base through3fc2dceb merged, full native/pages/bundle still awaited. Final affected suite/scripts/typecheck/build/real UI/review/followup/land remain. No whole-suite local run: night mode reserves it for queue land.
