# m5-loops-ui decisions

## D1: Both UI slices ship as one item
- **Question:** brainstorming purpose, consumers, scope, behavior, constraints and success; which title exclusions apply?
- **Options:** setup only; rail only; union of both named parts
- **Chose:** full setup + rail + queue/iteration controls + hosted-tab close/detach; CLI/API and visual flows U01-U12 required.
- **Why:** queue title explicitly unions the two parts. Core/preset runtime, sidebar/mobile/native notifications remain dependency/other-item responsibility.
- **Evidence:** queue wait lane1 m5-loops-ui; fork-loops.md Start a loop from UI, Observe and adjust, Closing a loop's tab; logic.md scope and U01-U12
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** queue scope changes
- **Source:** locked by docs/loop/queue.json

## D2: Use native structured output with a hosted loop tab
- **Question:** layout-style: terminal rail or structured journal? Consumer surface? Focus on create and fresh relaunch?
- **Options:** hidden PTY; interactive chat; read-only structured journal with hosted loop view
- **Chose:** read-only bounded journal beside rail, no interactive chat/composer; create opens background tab, relaunch never changes focus.
- **Why:** background agents must be native structured; core D2/D19 explicitly prohibit auto-adopting terminal panes. Orca observed fresh-session focus jump is a regression target, not parity behavior.
- **Evidence:** architecture.md145-178,205-220; m5-loops-core D2/D19; fork-loops.md409; quirky.terminal/openViewTab
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** locked architecture changes
- **Source:** locked by docs/architecture.md

## D3: Keep feature logic in its plugin and grow a generic plus-menu target
- **Question:** alternatives and grouping: global panel, terminal hard-coded integration or public plugin slot?
- **Options:** global panel; hard-coded loop import; generic terminal-plus menu contribution and hosted view
- **Chose:** quirky.loops owns dialogs/rail/commands; generic public terminal-plus menu target contributes Loop… after agent settings only for static create list. Existing pane menu remains compatible.
- **Why:** terminal owns tab strips, but built-in feature must use public API and remain disableable/replaceable. Existing hosted closeMethod/closeCommand supplies generic view mechanism.
- **Evidence:** roadmap.md19-38; LoopUiSeams map; protocol/src/ui.ts95-108; terminal/controller.ts1077-1095; layout/service.ts317-322,492-545
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** menu/schema seam cannot represent lifecycle safely
- **Source:** locked by docs/roadmap.md

## D4: Resolve all visual gray areas through feature defaults
- **Question:** information density/priority, responsive breakpoint, loading/empty/error state and interaction style?
- **Options:** custom design; existing shell conventions plus documented loop fields
- **Chose:** max1080 setup, name+prompt left/settings right; rail beside at720px else below; native form labels/accessible names. Empty prompt/queue/no-agents/loading/missing state explicit. Advanced collapsed per opening. Busy disables repeated submit; backend failure preserves draft and message. No new shortcut.
- **Why:** fork-loops.md specifies each observable default and validation text; reused React19 slot/root/dialog conventions avoid second shell.
- **Evidence:** fork-loops.md27-73,104-169; packages/ui/Dialog.tsx; worktree/test/ui.test.ts; U01-U03,U05,U12
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual narrow-window dogfood exposes inaccessible controls
- **Source:** locked by research/orca-features/fork-loops.md

## D5: Preserve draft text and full nested config sections
- **Question:** input/error data mapping: numeric invalid input, hidden advanced fields, preset/session transition, omitted/cleared edits?
- **Options:** coerce all text early; keep drafts and validate at submit
- **Chose:** string numeric drafts; exact finite/range validation, optional blank caps unlimited. UI max10/noProgress true; interval30/from-end, continue for queue/interval, fresh for until-done. Preset changes reset only Session. Check-dependent controls shown only with command; folder checkpoint hidden; cost eligibility follows doc. Full nested sections merged for edits; explicit clearing removes selected setting only.
- **Why:** early coercion loses invalid input and can submit NaN/zero. Dependency edit replaces sections whole. UI defaults differ deliberately from CLI.
- **Evidence:** fork-loops.md fields48-69/edit116-117; m5-loops-core D5/D20; m5-loops-presets D5; window/contracts.ts LoopDraft
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** strict create schema rejects a documented valid payload
- **Source:** locked by research/orca-features/fork-loops.md

## D6: Read authoritative snapshots; never infer stop from view absence
- **Question:** integration sync/conflicts/retry/auth and duplicate state behavior, unknown connectivity/cost?
- **Options:** local optimistic engine; authoritative snapshots with generation-fenced refresh
- **Chose:** public API/events/reconnect hydration, stale response/unmount fence, current snapshot for mutation/close. No silent retry of create. Unknown cost/diff unavailable, never0/pass. In-flight queue controls hidden and server races fail safely. History includes attempt identity and retained iterations beyond snapshot50.
- **Why:** daemon owns execution/lifetime and evidence; view absence has no process authority. Exact queue identity/state belongs dependency.
- **Evidence:** architecture.md145-178,205-220; fork-loops.md129-169,369; presets D3/D4; U05-U10
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** event ordering or reconnect test reveals lost state
- **Source:** assumed — autonomous

## D7: Closing live loop requires explicit choice; keep-running never stops child
- **Question:** close behavior, failure, scriptability, lifecycle/bulk closes and detached persistence?
- **Options:** stop implicitly; detach silently; explicit three-way user close with generic guard
- **Chose:** user close running/needs-you shows Cancel/Stop loop/Keep running. Stop-now must succeed before view removal. Failure leaves tab. Paused/ended and explicit bulk/lifecycle close detach views without prompt or worker stop. Guard every scripted tab-removal path; approve only matching loop/tab choice. Reopening uses declared loop command.
- **Why:** documented parity and daemon authority require no child stop from tab absence, while a script must not bypass explicit choice accidentally. Bindings can derive from durable hosted view input; add store metadata only if needed, not fabricated worker fields.
- **Evidence:** fork-loops.md167-169,340; layout/service.ts ensureViewsClosable; core D2; U11
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** close guard cannot distinguish authorized bulk/lifecycle path safely
- **Source:** locked by research/orca-features/fork-loops.md

## D8: All UI controls expose declared window commands and readable state
- **Question:** API/CLI response, versioning, authentication, rate limits, routing, output and exit semantics?
- **Options:** DOM-only controls; duplicate scripting model; shared handlers exposed as schema commands
- **Chose:** existing UI bridge/auth/schema envelope/generated CLI conventions, no new version/rate-limit layer. Commands address active setup/loop surface and share handlers with DOM; missing surface errors, not no-op. ui.state slot reports include drafts/validation/forms/iteration/close; layout owns hosted tab state.
- **Why:** every view-only action must be scriptable and window state daemon-readable. No screenshots used for agent-facing product API.
- **Evidence:** roadmap.md31-38,43-53; protocol UiPluginContext; U12
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a visible action lacks its CLI/API equivalent
- **Source:** locked by docs/roadmap.md

## D9: Autonomous spec review and full scoped work after the nightly target
- **Question:** brainstorming approvals/research/gray-area questions/spec format and execution gate when no person watches?
- **Options:** ask person; research swarm; autonomous feature-doc defaults and reviewed markdown
- **Chose:** no human questions/companion/adhd/swarm. Domains Visual/API/Data/Integration; all pertinent layout/density/loading/empty/errors/interaction, response/errors/auth, mapping/conflict/retry/idempotency gray areas resolved D2-D8. Essential six established in logic.md. Full logic+tech specs because subsystem boundary/>3files; prescribed Codex spec review, reduced independence acknowledged. Claim04:19UTC after04:00target; no new scope-reduction/time-deferral assumption.
- **Why:** LOOP prohibits asking a person. Feature doc, roadmap and earlier decisions supply research. Do not treat target deadline as permission to shrink acceptance.
- **Evidence:** authoritative git show build/roadmap:docs/loop/LOOP.md; date04:23:21Z; logic/tech specs; LoopSpecReview
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** locked-contract conflict has no safe implementation
- **Source:** locked by docs/loop/LOOP.md

## D10: Isolated components and cross-family review with Gemini fallback
- **Question:** SDD backend pairing, scopes, wave shape, inherited metadata and available code intelligence?
- **Options:** unavailable opus; reachable Gemini; same-family final review
- **Chose:** omp OpenAI task implementers, Gemini final reviewer google/gemini-3.1-pro-preview:high (actual probe succeeded; opus no authenticated model). Commit shared types first; width3 independent components setup, rail, public UI/tab integration; no overlapping files; parent owns specs/shared contract/decisions and integration. No LSP configured. Inherited .serena remains untouched/uncommitted. Worktrees under/tmp, removed after audit/integration.
- **Why:** one substantial vertical slice per component buys real parallelism. Config form export signatures fixed before rail consumes them. HEAD/scope audit gates acceptance, no worker commits. One final review+blocking fix batch per LOOP.
- **Evidence:** pi-watch --check opus exit5 and gemini exit0; xd://lsp status; LoopUiSeams; scratch/tmp/quirky-loops-ui.Xnoash
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** review backend fails or component scope changes
- **Source:** assumed — autonomous

## D11: Isolated macOS verification; platform appearance not claimed
- **Question:** tests, runtime smoke, webview proof and cross-platform requirements?
- **Options:** real homes/paid agent; isolated temporary homes with native fixture protocol
- **Chose:** all spawned daemons/providers get temporary HOME/QUIRKY_HOME/provider homes and owned teardown. API/CLI acceptance plus visible web dogfood; no paid model or real profile. Required affected suite/scripts/typecheck and build; land owns full suite. macOS only; Linux/Windows responsive/runtime/menu acceptance needs later platform verification.
- **Why:** hard no-real-state and platform rules. Tests alone do not prove visible controls. No new native-only surface beyond existing shell tab area, so no fabricated native pass.
- **Evidence:** LOOP hard rules and Verify; roadmap.md282-287; using-apps-like-a-user --surface web --owner yours --unattended
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native-only behavior is introduced
- **Source:** deferred: platform
## D12: Host-computed opt-in close context closes the spec-review blocker
- **Question:** P2 spec finding: identical guard invocation for single and bulk removal cannot both protect individual closes and permit bulk detach.
- **Options:** untrusted caller-supplied bypass; block all closes; host-computed opt-in reason.
- **Chose:** optional hosted ViewTab/openViewTab closeContext flag. Opted-in guards receive single/bulk/replacement computed by actual daemon entry point, threaded through removeTabs; existing guard schemas unchanged. One-shot single approval binds actual loopId+tabId. Bulk detach never stops child.
- **Why:** reviewer traced closeTab and closeTabs through identical removeTabs guard. Distinguishing trust at the owning host, not the plugin's UI assumption, satisfies both U11 cases without widening authority.
- **Evidence:** LoopSpecReview P2, tech.md Contracts; terminal/layout/service.ts317-322,798-824,1019.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** raw single-close or bulk regression bypasses the choice contract.
- **Source:** assumed — autonomous


## D13: Recover misplaced worker edits before resuming the same component
- **Question:** integration worker used relative edit headers for protocol/ui.ts and daemon/ui-kinds.ts; target files remained unchanged while parent files changed.
- **Options:** accept cross-worktree writes; discard unknown changes; attribute exact two-file delta and relocate it.
- **Chose:** worker stopped; parent read both source/target ranges and diff. Only intended plus-menu additions present. Moved exact protocol additions and corrected validator into target; restored parent hashes2840/71AE exactly. Reauthorized same component with absolute/tmp headers and revised baseline. Added layout/store.ts to its scope explicitly for durable closeContext validation.
- **Why:** unsandboxed tools do not enforce component boundaries. Original validator edit omitted the required initial if branch; correction in target preserves missing-menu validation. No source scope violation is committed and no user's source changes are discarded.
- **Evidence:** LoopUiIntegration STOP result; parent exact git diff; edit response target hashes1A2E/053A and parent original hashes2840/71AE; reviewer P2 trust contract.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another misplaced edit occurs; stop that writer before checks.
- **Source:** assumed — autonomous

## D14: Edit pacing is independent of the immutable creation preset
- **Question:** U08 names Edit Pacing choices but shared draft and dependency edit validation tied pacing to preset.
- **Options:** silently omit pacing switch; mutate preset; independent pacing draft and edit-only API policy.
- **Chose:** add pacingKind to shared draft, setup derives it from Run, edit derives actual config and offers on-idle/interval. Keep preset immutable. Lane5 notified to own edit-only runtime validation fix; create/CLI preset restrictions unchanged.
- **Why:** feature117 explicitly names both Pacing choices in Edit. UI cannot substitute a disabled Run field or silently narrow this flow. No locked architecture requires preset-bound pacing after creation.
- **Evidence:** fork-loops.md117; config-form.tsx178-227; main.ts edit310 and service.ts569; durable lane5 message05:05:50Z.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** dependency owner finds a locked contrary requirement.
- **Source:** assumed — autonomous

## Progress
Reviewed specs/contracts committed9c99a8f7; P2 close-context blocker resolved, prescribed Codex spec closure remaining blockers[] (reduced independence, not runtime proof). Three disjoint implementers active: LoopSetup in/tmp/quirky-loops-ui-setup, LoopRail in/tmp/quirky-loops-ui-rail, LoopUiIntegration in/tmp/quirky-loops-ui-integration, each baseline9c99a8f7 and no commits. Parent baseline launched daemon proved missing loop UI command (LOOP_UI_MISSING_SURFACE_REPRODUCED) and cleaned (LOOP_UI_BEFORE_CLEANUP_OK), exit0. Web dogfood doctor ready. Scratch/tmp/quirky-loops-ui.Xnoash has journal/wave/goals/before.ts/serve.ts; serve is prepared but not run. Dependency-ready command running; no ready claim yet. Next: wait for every writer, HEAD/scope audit and integrate, own runtime/API/visual proof and required gates, dependency latest tips/readiness, one roadmap catchup/read decisions, final cross-family review+blocking fixes and authoritative land. Do not end while workers/jobs run; no second item.
