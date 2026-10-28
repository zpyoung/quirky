# m7-sweep-terminal-completion decisions

## D1: Follow build-first policy with exhaustive parity accounting
- **Question:** Which workflow governs this completion and its large inherited inventory?
- **Options:** Run all historical reviews/suites; omit inherited gaps; implement independent flows and record every remaining flow under LOOP's single successor rule.
- **Chose:** Build first, tests written but not run, no reviews/dogfood campaign, typecheck gate, one catch-up. Exactly one queue item. Use one permitted successor only for unbuilt flows, never verification/debug tasks.
- **Why:** Authoritative LOOP explicitly moves testing/debugging to m7-test-triage and permits one unbuilt-flow follow-up. The parent inventory is exhaustive; completion is not a parity-complete claim.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; parent logic.md audit inventory; canonical queue wait --lane 9.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End phase has begun or a locked requirement conflicts.
- **Source:** locked by docs/loop/LOOP.md

## D2: Reuse existing authorities in three independent vertical components
- **Question:** Which approach preserves API, data and integration gray-area invariants?
- **Options:** Replace state machines; create UI-only features; extend current public owner APIs.
- **Chose:** Q owns ask presentation/notification lifecycle; D/S owns Dashboard and agent Fork/resume; W owns stock worktree options and safe sleep/cleanup. Three disjoint scopes, no cross-component prerequisites; parent commits all types/spec first.
- **Why:** Existing Ask, Activity, agent resolver and worktree removal already carry durable identity/safety. A second store/launcher would diverge. The current single scout mapped explicit owner paths, not external research.
- **Evidence:** TerminalCompletionMap; plugins/quirky.ask/asks.ts; agent-status/src/activity.ts; agents/src/service.ts; worktree/src/daemon/remove.ts.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A necessary public capability cannot be added safely within its scope.
- **Source:** assumed — autonomous

## D3: Choose disclosed hidden state and inert previews
- **Question:** Visual/error/attention defaults and data precedence?
- **Options:** Hide acknowledged completions as idle; show total of visible cards only; retain completed state and disclose hidden idle. Render trusted HTML; sandbox untrusted output.
- **Chose:** Completion stays Done regardless of acknowledgment, total includes hidden idle, filters are scriptable. Ask previews are inert sandboxed rich content; actual terminal envelope summary flashes four seconds; delayed unattended notification cancels on focus/resolution and never steals terminal focus.
- **Why:** Avoid source Orca hidden-idle zero-total defect and preserve explicit ask UX/security requirements.
- **Evidence:** agent-status.md Dashboard observations; ask.md preview sandbox, right-sidebar focus, escalation and result summary sections; spec Q1-Q3/D1-D2.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** New provider/surface evidence requires a different observable outcome.
- **Source:** locked by research/orca-features/ask.md and agent-status.md

## D4: Preserve native and remote capability boundaries
- **Question:** Can absent shell/host capabilities be faked to close parity?
- **Options:** Private native FFI/Chrome substitution; silently execute locally; explicit unsupported prerequisite.
- **Chose:** Supported public API only; exact owner or refusal. No new native/private patch, no local fallback for remote. Distinct unbuilt native/remote flows remain in the disposition ledger and eventual successor, existing owners are not duplicated.
- **Why:** Architecture fixes system webviews for humans, plugins on public API, one history and background non-adoption. Native permission/TCC cannot be asserted by source or browser substitutes.
- **Evidence:** docs/architecture.md Decisions; parent D17-D18; sa-browser-pane native constraint decisions; queue owner reconciliation.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** Supported upstream public capability lands.
- **Source:** locked by docs/architecture.md

## D5: Preserve unrelated metadata and use omp implementation without new reviews
- **Question:** How do unattended preflight and backend choices work?
- **Options:** Stash/remove inherited .serena; leave it untouched. Start reviewer probes; skip unstarted reviews under current policy.
- **Chose:** Leave untracked .serena untouched and unstaged. IMPLEMENTER=omp task, AUTHOR_FAMILY=openai; no reviewer run/probe or clearance claimed because LOOP forbids new review rounds in this phase. LSP attempted: no configured server.
- **Why:** Unexpected files belong to user; native task tool is available. Review backend availability adds no assurance when review is prohibited.
- **Evidence:** Initial git status; xd://lsp status reply; authoritative LOOP build-first rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End-phase review work is claimed.
- **Source:** locked by docs/loop/LOOP.md

## D6: Distinguish an unbuilt native bridge from an absent SDK hook
- **Question:** Which native prerequisites really exist in the pinned public SDK?
- **Options:** Assume all native APIs absent; use private FFI; inspect the public SDK and classify each flow precisely.
- **Chose:** Public Electrobun2.0.4 Utils.openFileDialog supports canChooseDirectory and returns string paths; the missing piece is a public Quirky shell/plugin bridge, not native SDK feasibility. Utils.showNotification only accepts title/body/subtitle/silent and returns void; its public utility surface exposes no permission query or click/dismiss API. No native acceptance or delivered banner is claimed.
- **Why:** A callable folder dialog and an unacknowledged notification are different capabilities. Unsupported permission/dismiss behavior cannot be invented, while folder-picker integration remains reachable engineering work.
- **Evidence:** apps/desktop/.hutch/devkit/api/sdks/main/core/Utils.ts:66-122,212-240; SDK event search; apps/desktop/src/bun/index.ts:261-265; native-capability-audit.json printed by source-only executable audit. Utils source SHA256 a4a063380c1e7c37d7355b27269d6a7f8e5e9379af761f1f68a641b3aba5dbae.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Supported native permission/event APIs or a Quirky public folder dialog bridge land.
- **Source:** assumed — autonomous

## D7: Retain shipped statusline and native findings without duplicate work
- **Question:** Which later owners and native reports supersede parent inventory omissions?
- **Options:** Rebuild Claude statusline; mark inherited reports passing; reconcile exact shipped paths and open failures.
- **Chose:** Keep quirky.session-info's per-launch Claude statusline overlay, guarded telemetry and consent/chaining as shipped implementation. Preserve m1-term-ui SC37 native clipboard failure under existing fix-native-m1-term-ui-1028; keep its Finder drop/physical modifier/WebGL tool blockers distinct. m1-notifications banner/audio/tray/Dock scenarios remain blocked, not pass. Dock completion already landed; automation remote and sidebar-extras followups keep their own authority.
- **Why:** Existing source/decision evidence establishes statusline ownership but not every private-OSC/transcript/remote status producer. Native tool limitations do not prove app success or justify duplicate fix items.
- **Evidence:** quirky.session-info/src/service.ts, statusline-runner.ts and manifest telemetry/enableTelemetry/statusline; m3-session-info D5-D9; docs/loop/native/m1-term-ui.json and m1-notifications.json; current queue owner listing.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Current native reports or another landing provide stronger evidence.
- **Source:** locked by docs/loop/decisions/m3-session-info.md

## D8: Reuse maintained sanitizer dependencies instead of a private renderer import
- **Question:** Ask preview needs richer rendering but currently declares only React dependencies.
- **Options:** Private import from editor; hand-written Markdown/security parser; explicit owning-package dependencies matching maintained editor versions.
- **Chose:** Ask component may declare maintained renderer/sanitizer dependencies in its own package.json; parent owns the root lock update after the implementation barrier. Empty sandbox and restrictive CSP remain defense in depth.
- **Why:** Reusing a dependency convention is allowed; private cross-plugin source imports and an improvised parser would violate public plugin boundaries or increase security risk.
- **Evidence:** quirky.editor/package.json react-markdown/remark/rehype/DOMPurify versions; AskCompletion prerequisite message and parent authorization.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A shared public rendering library replaces owning-package dependencies.
- **Source:** assumed — autonomous

## D9: Sleep parks panels, never processes
- **Question:** Does source parity require refusing any workspace with a running terminal?
- **Options:** Refuse live sessions; stop agents; close exact workspace views while preserving processes and buffers.
- **Chose:** Correct W2 to the third option. Sleep is reversible view lifecycle; sleeping rows remain listed by default, selection wakes them, and descendants follow only explicit subtree choice. Cleanup retains strict process/dirty/liveness blockers. Exact unavailable view routing remains explicit rather than closing unrelated windows.
- **Why:** Direct source reread says Sleep closes active panels to free memory and selection wakes it. The initial autonomous safety framing was too restrictive if applied to non-destructive panel parking. No process death proof is needed because no process is stopped.
- **Evidence:** research/orca-features/worktrees.md:140-144,165,179; dated logic-spec amendment; parent correction sent to WorktreeCompletion before return.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Public view ownership cannot identify the exact workspace safely.
- **Source:** supersedes m7-sweep-terminal-completion D2 sleep interpretation; locked by research/orca-features/worktrees.md

## D10: Compose issue drafts through the existing public session input
- **Question:** Is issue-to-agent draft launch blocked on another plugin prerequisite?
- **Options:** Treat it as unavailable; duplicate provider draft logic; add the missing worktree forwarding field.
- **Chose:** W owns plugin-local CreateParams/schema/CLI/dialog submitPrompt selection and forwards the public session/create field. Direct GitHub issue with no explicit prompt uses its exact issue URL and unsubmitted default; explicit selection wins; generic prompt default stays submitted.
- **Why:** Public session/create already supports draft delivery. Worktree/create({github,...}) is the real owning entry; no separate createFromGithub method or protocol expansion is needed.
- **Evidence:** session manifest submitPrompt; worktree/src/daemon/create.ts startAgent; DashboardContinuity and WorktreeCompletion source handoffs; logic S2.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A provider fails its declared native draft/readiness contract.
- **Source:** assumed — autonomous

## D11: Fix compiler and actual browser failures without starting an end-phase campaign
- **Question:** What actually failed during integration and the minimum changed-path smoke?
- **Options:** Treat worker reports or compilation as UI proof; suppress failures; repair the owning source path and retain exact limits.
- **Chose:** Fix missing Dashboard UI closure, fixture imports/types, WorktreeRow defaults and mandatory CLI flag descriptions. Replace Ask's browser-inaccessible react-dom/server dependency with the maintained unified/remark/rehype string pipeline, keeping all sanitization/sandbox fences. Reuse the existing worktree Dialog for cleanup rather than its unstyled sidebar-clipped wrapper. Remove new mock-forwarding/class-copy assertions instead of re-pinning them; add Escape-dismiss consumer coverage.
- **Why:** Initial typecheck reported one parse error, then38 diagnostics in7 files. Actual daemon rejected the Dashboard manifest for two missing flag descriptions. Actual browser could not load Ask due to the unmapped server module; cleanup appeared clipped within the sidebar. These are real new-path failures, not waived end-phase tests. No unrelated failure/debug campaign began.
- **Evidence:** Compiler artifact17; manifest-diagnostics.json; actual browser text/error and screenshots omp-sshots-15b7f7bed59a56a2.webp versus repaired omp-sshots-15b7f8f6695a56a4.webp; repaired UI bundle9files/25modules and full typecheck exit0.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End-phase acceptance finds a consumer-visible regression.
- **Source:** assumed — autonomous

## D12: Limit verification claims to observed private runtime and visible paths
- **Question:** What is verified now versus written or pending?
- **Options:** Claim all terminal parity; run prohibited suites/dogfood; state exact smoke and gate evidence.
- **Chose:** Full typecheck passed after repairs. Actual standalone daemon/CLI/PTY smoke in fresh private HOME/QUIRKY_HOME exercised stock options/readback, selected parent+child sleep/wake, exclusion of fresh cleanup candidates and stale-preview refusal, Dashboard completion retained Done after acknowledgment, captured provider Fork and Ask answer. Killing only the owned PTY host then public restore preserved the exact session/provider/model/effort. Actual four-wait gate shed the fifth with Conflict/runtime_busy and released all slots on cancellation. Real Chrome rendered Dashboard, changed stock grouping with API readback, rendered hostile rich preview inertly and showed then dismissed the actual terminal summary; repaired cleanup modal was centered and fully visible.
- **Why:** These observations establish runnable changed paths, not exhaustive scenario clearance. Tests are written but unrun by current LOOP policy. No formal review or dogfood campaign, paid-provider proof, physical-native clearance, eligible aged-candidate bulk-deletion proof or measured three-minute banner timing is claimed. Source-issue draft coverage is written, not live-GitHub acceptance.
- **Evidence:** runtime-smoke.json; cold-restore-smoke.json; ask-wait-gate-smoke.json; ask-preview-ui-smoke.json; ui-smoke-summary.json; screenshots15b7f79a495a56a1,15b7f8e304da56a3,15b7f8f6695a56a4; private runtime printed CLEANED and exited0. New native Q2/Q3 scenarios pending.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End-phase tests or native handoff contradict an observation.
- **Source:** locked by docs/loop/LOOP.md

## D13: Carry only exact unbuilt flows in one successor
- **Question:** How do the unstarted inventory families remain owned without creating prohibited verification work?
- **Options:** Omit them; falsely mark parity complete; register one unbuilt-flow successor and retain existing verification phase/native owners.
- **Chose:** Register m7-terminal-runtime-native-and-worktree-parity depending on this item, with the exhaustive remaining rows of the logic spec. It owns unavailable/caller-preserving Ask bridges, external CLI/remote selection, pop-out, transcript/private-OSC/remote status, model discovery/retirement, recipe composition, remaining terminal composition/render/key controls, remaining worktree filters/visibility/navigation/references/board/create/project extras, missing cleanup classifiers/per-window routing, and native public bridge/packaging prerequisites. No test/verify/review/debug follow-up is added. Existing automation, sidebar-extras, native SC37 and completed dock owners are not duplicated.
- **Why:** LOOP allows at most one successor for unbuilt flows and places verification in the end phase. Three components are implemented here; the original all-nine-doc parity obligation remains explicit rather than silently reduced.
- **Evidence:** Final exhaustive disposition ledger in this item's logic.md; Q/D/S/W capability handoffs and source audit. Queue registration result is recorded in Progress when observed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Another landed owner already implements one of those distinct flows; reconcile it before coding.
- **Source:** deferred: terminal runtime/native/worktree unbuilt flows

## D14: Preserve every incoming authority and remove duplicate remainder ownership
- **Question:** Did the single integration catch-up change this item's contracts?
- **Options:** Drop incoming automation/mobile fields; keep parallel metadata; combine both authorities and reconcile all14 incoming decision logs.
- **Chose:** Merge ffd662f5 preserves both controls/sleep/cleanup and immutable local automation provenance in schemas, migration/INSERT order, tree props, availability/navigation and reports. All14 exact MERGE_HEAD logs were read fully via the targeted scout. Preserve editor mounted-resource leases, synchronous host-power fencing, orchestration generation/operation identity and shutdown waiter order; no Ask/Dashboard action acquires execution authority. Remote dispatch/ledger still require public host generation and filesystem APIs; no local fallback. Exclude newly landed phone panels/foreground notifications/artifact grants, automation filters, Browser extras/import/routing, editor viewers and power/shutdown work from the successor.
- **Why:** No incoming decision invalidates Q/D/S/W. Five actual worktree conflicts needed composition, not choosing a side. Native Browser preview/host control blockers do not become fake terminal implementations.
- **Evidence:** incoming-decisions.json14 complete logs: editor-build-unbuilt, hosting-review-browser-routing, automation-remote, loops-visible-stop, Heimdall-host-power, orchestration-idle-pointer-shutdown, ledger-remote, automation-completion, Browser-agent-extras/native-host/workspace-preview/import-UI, mobile-panels and mobile-panels-unbuilt. Original WorktreeCompletion resolved only the5 conflicts. Full merged typecheck exit0; merged real standalone runtime assertions and actual Dashboard/centered cleanup UI passed again, screenshot15b7fbf93f370dd9. Its private runtime/browser stopped and exited0.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Another landing changes an owning public contract.
- **Source:** locked by incoming docs/loop/decisions

## Progress
Ready for canonical queue land. Three audited components and source-backed repairs are committed; sole catch-up ffd662f5 is resolved, all14 incoming binding logs reconciled, full merged typecheck exit0, refreshed UI9files/25modules and actual merged API/browser smoke passed. Native Q2/Q3 remain pending; acceptance tests are written but not run; no suite/review/dogfood/parity-complete claim. Canonical queue add exited0 and authoritative queue readback confirms exactly one successor m7-terminal-runtime-native-and-worktree-parity status todo with dependency this item. Canonical deps returned ready:true. Both private smoke services exited0 after cleanup, owned browsers closed and all component worktrees removed normally; unrelated metadata is preserved. Next: commit this final evidence/ledger update, detach, queue.ts land, preserve its actual verdict, then remove only owned scratch and end this single-item iteration.
