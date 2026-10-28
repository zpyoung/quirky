# m7-terminal-runtime-native-and-worktree-parity decisions

## D1: Preserve the complete inherited obligation and extend existing owners
- **Question:** What is the scope, and which implementation approach should autonomous brainstorming select?
- **Options:** Replace existing authorities; treat old non-goals as exemptions; extend existing public owners and account for every inherited flow.
- **Chose:** Extend current owners. The full predecessor disposition ledger and assigned queue title remain the acceptance inventory. Reconcile later shipped owners before coding; no declaration of exhaustive terminal parity from a bounded landing.
- **Why:** The roadmap requires every source flow and no source defects, while LOOP permits one implementation-only successor for genuinely unbuilt flows. Existing stores/resolvers/identity authorities must not diverge.
- **Evidence:** docs/quirk/specs/2026-10-28-m7-sweep-terminal-completion/logic.md:62-94; docs/roadmap.md:13-56; queue wait lane11 returned this item.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Current source shows a later owner already implements a ledger row.
- **Source:** locked by docs/loop/LOOP.md and docs/roadmap.md

## D2: Resolve API, CLI and integration gray areas with exact caller and target identity
- **Question:** Which error/output/authentication/selection/conflict defaults are safe across Ask, providers, remote runtimes and worktrees?
- **Options:** Infer identity or execute locally; expose typed refusal; preserve authenticated caller and exact owner through public APIs.
- **Chose:** Preserve authenticated caller/session/incarnation/dispatch identity. Namespaced schema-declared APIs drive both CLI and UI. Local commands keep current usage/runtime exit codes. Explicit remote selection never falls back locally, and ambiguous/stale/unknown owner evidence refuses. Nonempty authoritative model discovery alone may retire saved choices; a failed/empty probe preserves them. Raw arguments retain canonical resolver precedence. Never use terminal status as question/approval authority.
- **Why:** The source feature docs and inherited decisions distinguish absent capability from success; identity spoofing or a second launch/status machine would violate the plugin boundary and consumer expectations.
- **Evidence:** cli.md Remote runtimes and Caller identity; ask.md Server registration routing and Hand-off; launch-settings.md Model retirement; predecessor D4,D6,D14.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** A supported new host/provider capability provides stronger evidence.
- **Source:** locked by docs/architecture.md; assumed — autonomous

## D3: Resolve visual, data, lifecycle and recovery gray areas without hidden authority
- **Question:** How should navigation, filtering, loading/errors, native controls and persistent state behave?
- **Options:** UI-only state or optimistic success; duplicate metadata; reuse owner persistence and explicit loading/empty/error/refusal states.
- **Chose:** Owner-persisted state, readable scriptable commands, stable identities/order and explicit recovery. Hidden rows/counts remain discoverable; selecting sleeping workspaces wakes only their views, never restarts or stops processes. Cleanup rechecks canonical dirty/liveness/removal safety. Inactive views unmount, preserving PTY history and editor leases. Native SDK operations require a public shell bridge; no private FFI, browser prompt substitute, fake notification acknowledgement or invented signing identity.
- **Why:** Source worktrees.md separates sleep from destructive removal; architecture requires visible-only views and plugin API growth, not private imports. Pinned SDK exposes directory selection but no notification permission/click/dismiss utility hooks.
- **Evidence:** worktrees.md:129-198,292-299; term-ui.md tabs/settings; predecessor D6,D9; sa-browser-pane-native-host-controls D3,D6.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Supported native hooks or signed distribution prerequisites become available.
- **Source:** locked by docs/architecture.md; assumed — autonomous

## D4: Use contract-first, three-component unattended build-first execution
- **Question:** How do the skill approval/research/review/testing gates apply?
- **Options:** Human questions/research/review swarms; autonomous defaults with scoped implementation; skip evidence entirely.
- **Chose:** No human questions, visual companion, adhd, research swarm, suite, formal review or dogfood campaign. One source-mapping scout; one self-reviewed logic spec with final technical contracts, committed before at most three independent omp task implementers. IMPLEMENTER=omp task, AUTHOR_FAMILY=openai; eventual cross-family reviewer preference Opus, no availability or pass claimed. Preserve foreign untracked .serena/. No configured LSP server (status attempted). Parent performs typecheck and developer-required disposable changed-path runtime smoke, catches up once immediately before land, and reads incoming binding decisions.
- **Why:** Authoritative LOOP build-first section overrides the normal skill workflow; higher-priority behavioral verification still requires narrow exercised proof. No test/review/debug successor is allowed.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; xd://lsp status returned no language servers; initial git status.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End phase starts or authoritative loop policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D5: Preserve platform and later feature ownership boundaries
- **Question:** Which existing phone/Browser/editor/automation/orchestration flows must not be rebuilt?
- **Options:** Recreate overlapping features; treat related features as equivalent; retain exact existing owners and build only distinct missing composition.
- **Chose:** Retain landed phone panels/foreground notifications/terminal-artifact grants, immutable automation provenance and sidebar filters, Browser agent/import/routing controls, editor resource leases, host-power/shutdown fencing, dock and existing native clipboard owner. Interactive native chat/voice and provider-owned remote execution remain governed by their own explicit exclusions/prerequisites. GitLab/Bitbucket/Gitea/Azure hosting, Objective runner and PR sitter exclusions remain. Build/smoke on macOS only; Linux/Windows/WSL install/hook/native behavior is not claimed.
- **Why:** A similar feature is not the requested missing flow, and overlapping ownership would fork authority. No operator-controlled signing/service credentials can be invented by this loop.
- **Evidence:** predecessor D7,D13,D14; sb-mobile-app-panels-unbuilt-flows D1-D5,D8,D11; docs/architecture.md Decisions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Later landings change the exact public owner contracts.
- **Source:** deferred: platform

## D6: Remap declared bindings at the existing kernel resolution boundary
- **Question:** How should terminal shortcuts remain user-remappable without a second event interceptor or stale menu hints?
- **Options:** Plugin-local hardcoded keyboard interception; distro edits; profile overrides at UiService/buildUiModel.
- **Chose:** Public keybinding.list/set/reset, persisted by binding contribution ID; null disables, reset restores current inheritance. Preserve command/context and Terminal-first policy; explicit user overrides outrank inherited collisions, with deterministic shadowed rows rather than losing entries. Settings and terminal menu hints consume the same effective model; update all windows on ui.keybindings.changed.
- **Why:** WindowPluginHost already chooses active context-matching bindings from this model. Another listener would leave original bindings live and could leak shortcut bytes into shells.
- **Evidence:** packages/daemon/src/plugins/ui-model.ts and ui-service.ts; packages/ui/src/plugins/host.ts handleKey; authored keybinding-overrides.test.ts and distro-collision regression (not run).
- **Reversibility:** medium
- **Confidence:** high for contract; runtime proof pending
- **Revisit if:** End-phase keyboard scenarios find a context/precedence mismatch.
- **Source:** assumed — autonomous

## D7: Build a read-only iOS Simulator tab against the real supported provider
- **Question:** Can the missing Mobile Emulator tab be implemented without equating it to phone panels or restoring dropped generic computer control?
- **Options:** Treat phone panels as an emulator; fabricate images; compose an exact selected Xcode simulator screenshot provider.
- **Chose:** Terminal owns emulators/emulatorFrame and a session-free hosted Mobile Emulator view. Real xcrun simctl list/screenshot, explicit UDID (never booted alias), no device boot/shutdown/control/fallback. Visible tabs poll one second after each completed frame; hidden tabs unmount and stop polling. Bounded child output/timeout, temporary frame files, PNG byte/pixel bounds, truthful unavailable/empty/shutdown/stale-frame/error/refresh states.
- **Why:** term-ui.md names a preview tab while agents retain their own tools. This is distinct from the shipped mobile companion and does not introduce native chat, a Swift shell or generic computer-use authority. The supported simctl executable is available; no real simulator was read or mutated during source investigation.
- **Evidence:** xcrun --find simctl exited0 with /Applications/Xcode.app/Contents/Developer/usr/bin/simctl; terminal emulator.ts and EmulatorView.tsx; authored isolated external-provider API test (unrun).
- **Reversibility:** medium
- **Confidence:** medium until actual changed-path smoke and nightly native check
- **Revisit if:** The real SDK/provider cannot return bounded screenshot data for an explicitly selected simulator.
- **Source:** assumed — autonomous

## D8: Reuse compatible bounded renderer addons and exact public document destinations
- **Question:** Which rendering/tab composition closes distinct missing flows without invalidating xterm or editor leases?
- **Options:** Major xterm upgrade/private renderer parser; duplicate document authority; compatible owner-declared addons and public hosted editor commands.
- **Chose:** xterm5.5-compatible addon-image0.8.0 and ligatures0.9.0, lazy visible-pane load, stale import/unmount fencing, image cache8MiB/pixel1M and input4MiB, initial addon readiness before replay. This addon supports SIXEL and iTerm images, not Kitty graphics; no Kitty support claim. Existing application terminal theme ownership stays unchanged. New/Open Markdown and Open File in Editor preserve exact workspace/group through the public editor picker and existing leased document surface; existing Browser/handoff owners remain.
- **Why:** Published peer ranges match the pinned xterm. An unmounted addon must not recreate hidden resources, and a tab picker must not silently send a split's document to another group. Floating Markdown/editor has no authorized document root and refuses visibly instead of inventing filesystem authority.
- **Evidence:** https://registry.npmjs.org/@xterm/addon-image/0.8.0 ; https://registry.npmjs.org/@xterm/addon-ligatures/0.9.0 ; upstream addon public typings at commit9ba6c00a; editor overlayState/QuickOpenOverlay and terminal commands/extras source.
- **Reversibility:** medium
- **Confidence:** medium until changed-path browser smoke
- **Revisit if:** A compatible Kitty-capable addon or public floating-document owner is implemented.
- **Source:** assumed — autonomous; deferred: Kitty graphics and floating authorized document composition

## D9: Preserve explicit signing and native notification prerequisites
- **Question:** Do this workstation and pinned SDK provide the outside authority required for production helper/TCC and notification lifecycle claims?
- **Options:** Invent an ad-hoc production identity; private native SDK patch; retain observed prerequisites and ship reachable public bridges separately.
- **Chose:** security find-identity -v -p codesigning returned `0 valid identities found` (exit0). Do not claim signed production helper/TCC/admission/upgrade packaging. Predecessor D6's supported SDK audit remains binding: directory chooser exists, showNotification returns void and supplies no permission/click/dismiss utility hooks. No generated/private FFI patch or false banner acknowledgement.
- **Why:** A public folder/window bridge is reachable engineering; a nonexistent signing credential or SDK callback cannot be supplied by source stubs or success heuristics.
- **Evidence:** observed security command this iteration; m7-sweep-terminal-completion D6; sa-browser-pane-native-host-controls D3,D6.
- **Reversibility:** medium for packaging; easy when supported hooks/identity exist
- **Confidence:** high for observed environment/API limits
- **Revisit if:** A valid authorized signing identity and supported native lifecycle hooks are available.
- **Source:** deferred: signed helper identity and supported notification hooks

## D10: Reject incomplete components and continue them within the original width cap
- **Question:** Can test-only future contracts or merely missing create fields count as shipped work?
- **Options:** Accept partial reports as complete; label source omissions outside blockers; continue each original component through focused serial recovery while parent finishes shared integration.
- **Chose:** Reject original A/C incomplete handoffs. Original workers explicitly stopped and acknowledged no further edits. Focused serial retries continue their same worktrees and preserve prior changes, with at most three simultaneous implementers including B. Parent owns native structured/Ask integration and Dashboard consumer files reserved from the status retry. No check, commit or acceptance is inferred from a worker report.
- **Why:** A3/A4 initially contained tests without implementation, and C4 lacked forwardable fields despite existing public session support. Those are reachable engineering work, not external authority prerequisites or a reason to silently reduce the item.
- **Evidence:** TerminalAuthority and WorktreeParity incomplete reports and stop acknowledgements; focused ProviderStatusFinish and WorktreeCreateFinish contracts; revised spec ownership.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A concrete outside authority rather than an unimplemented source field blocks a distinct flow.
- **Source:** assumed — autonomous

## D11: Native question handoff uses the kernel-issued session lease, not forged plugin identity
- **Question:** How can an asynchronous Claude/Codex native callback preserve its real worker caller beyond a client handler's forwarding lifetime?
- **Options:** Forge a PluginCaller; retain expired forwarding objects; connect through the public local client API with the background session's own kernel-issued lease token.
- **Chose:** The owning structured service uses its live lease credential to open an authenticated local connection only for the native question lifetime. Register a bounded durable typed Ask and use ordinary caller-preserving handoff/wait; close on settlement/exit/shutdown. Ordinary tool approvals keep their existing card path. Preserve native IDs/labels/multiselect/free text; refuse secret requests before Ask creation. Question-only no-answer text is never an approval decision. Codex validates exact active thread/turn on both sides of the await.
- **Why:** The kernel already issues and verifies these credentials for structured sessions; no new authority source or impersonation API is needed. A stored Ask cannot make an expired provider lease live.
- **Evidence:** RuntimeSessionAuthority.openStructuredLease/resolveForConnection; public connectDaemon identity option; quirky.structured native-questions, runners and createAsk integration; authored native provider-frame tests (not run).
- **Reversibility:** hard (caller authority)
- **Confidence:** high for design; actual runtime proof pending
- **Revisit if:** A supported public in-process session-scoped call primitive replaces the credentialed local connection without weakening lifetime fences.
- **Source:** assumed — autonomous

## D12: Preserve exact handoff outcomes across replies and terminal restoration
- **Question:** Which identity and terminal-state edges must survive the cutover?
- **Options:** Compare JSON observation-channel snapshots; drop reply attestation; reuse typed owner identity and persist all terminal refusal outcomes.
- **Chose:** Preserve handoff identity in accepted checkpoints and both immediate/awaited answered results. Replay matches actual session/process incarnation, allowing terminal_launch to become restored_authority without accepting a replacement process. Unknown wait/cancel returns unavailable with no fabricated answer. An absent structured lease is definitive kernel-owner loss; absent/unprobed PTY evidence remains unknown. A coordinator may explicitly leave a required question unanswered as partial without relaxing ordinary card-submit required validation.
- **Why:** Dropping answer identity would falsely reject a genuine coordinator; comparing observation source would break same-process restart replay; partial/no-answer must not become consent or an endlessly invalid card submit.
- **Evidence:** parent repairs in dispatcher/orchestration/Ask; authored source-channel restoration, coordinator partial, unknown outcome and native conversion tests (unrun).
- **Reversibility:** medium
- **Confidence:** medium until disposable runtime proof
- **Revisit if:** Actual API/CLI handoff/restart execution contradicts these invariants.
- **Source:** assumed — autonomous

## Progress
Contract/spec commit740ff1b0 precedes implementation. Parent terminal/render/remap/editor/PTY source and tests authored; original incomplete A/C workers stopped, focused serial recoveries active in their original trees; B CLI/native bridge active. Parent completed native structured caller and Ask integration plus Dashboard public consumers without overlapping retry scopes. No permanent tests, typecheck, build, product smoke, review or dogfood run yet. Next: settle all components, audit scope/HEADs, commit/merge each and immediately remove its worktree, install using existing bun.lock convention, run typecheck and disposable actual API/CLI/web smoke, record exact dispositions/native pending evidence, catch up once/read incoming decisions, typecheck and canonical land. Do not end with work running or claim another queue item.
