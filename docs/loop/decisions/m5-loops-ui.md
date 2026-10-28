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

## D15: Host identity removes the serialized close-guard read cycle
- **Question:** binding validation called workspace while terminal removal already held LayoutService's shared queue.
- **Options:** snapshot:true read bypass; trust static closeParams; pass actual host-computed binding context.
- **Chose:** opted-in host guards receive closeViewId/key/input overriding static params. Loop guard requires the terminal-plugin caller and actual binding before authorization. Explicit close reads workspace before removal, never inside the guard. No snapshot bypass API.
- **Why:** workspace and remove operations share one serialized queue; re-entering it deadlocks. The owning tab host already has the authoritative view identity at the exact removal boundary.
- **Evidence:** LoopUiIntegration source/ack; layout/service ensureViewsClosable; loops/main viewCloseGuard/closeView; native CLI window smoke exit0.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** guarded individual/bulk close regression violates ownership or fails its original deadline.
- **Source:** assumed — autonomous

## D16: Attribute DOM fixture failures instead of weakening product behavior
- **Question:** first integrated gate38pass/10fail: missing h.setLoop, controlled input edits ignored, and missing sidebar-extras setting.
- **Options:** bypass handlers or assertions; patch unrelated worktree production; correct the fixture's DOM initialization and relevant builtin set.
- **Chose:** React DOM imports follow Happy DOM registration, fixture exposes its intended setter, and the real-window fixture includes the builtin whose settings the worktree view uses. Delete wiring/mock-echo/incidental-wording tests rather than repin them. Rail repair also changes setup test import ordering only, explicitly authorized.
- **Why:** React initialized input feature detection before a document existed. The same typed DOM validation/draft/error tests now pass together31/0/161 expectations in the repair component. No production rail behavior was changed for these fixture failures.
- **Evidence:** actual initial integrated gate artifact100; LoopRailRepair source/result; existing headless-window lazy import pattern; WorktreesSection missing-setting stack.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual browser input differs from the corrected fixture.
- **Source:** assumed — autonomous

## D17: Prove native execution and focus with an isolated real CLI/window smoke
- **Question:** earlier native attempts hit fixture interpreter, geometry and terminal canvas limits rather than completing the changed path.
- **Options:** call a scripted runner echo; claim cap merely from paused; repair fixture prerequisites and require positive native evidence.
- **Chose:** existing native Codex JSONL fixture with fakebin/node pointing to Bun in the isolated minimal PATH, measured Happy DOM workspace geometry, and a real hosted settings-tab focus sentinel (no fake canvas/PTY output). Require cap-iterations with completed count1, then exact count2/history after steer+resume, native turn/start evidence, detail and explicit stopped result.
- **Why:** minimal PATH had no node (deterministic exit127), and unmeasured DOM deliberately mounts no groups. A terminal sentinel required an unavailable canvas; a hosted sentinel proves the same active-tab invariant without replacing any loop surface.
- **Evidence:** native-diagnostic.json; env -i isolated node --version exit127; corrected native-smoke.ts bg13 exit0 in9.48seconds, LOOP_UI_NATIVE_CLI_WINDOW_SMOKE_PASS and CLEANUP_OK. Two synchronous nested-root unmount warnings are recorded, not suppressed; window repair owns investigation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** browser dogfood or final merged runtime contradicts native evidence.
- **Source:** assumed — autonomous

## D18: Apply the operator's bounded landing scope
- **Question:** operator interjection requires committing exercised code, one follow-up for the rest, one affected/typecheck gate and queue landing within30minutes.
- **Options:** start another review/UI campaign; land the implemented and exercised surface with explicit remaining verification.
- **Chose:** stop unstarted campaigns. Ship all implemented UI/API behavior with its intact acceptance tests; defer only unfinished visible Stop/Close and tool-limited setup completion plus the unstarted bounded cross-family review to one dependent item.
- **Why:** explicit operator instruction supersedes the previous execution campaign. No API/CLI or native smoke result is relabelled as a complete visible UI pass.
- **Evidence:** operator interjection; window starts2026-10-28T08:06:49Z, target08:36:49Z; UI reports listed in BLOCKERS.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final affected tests or typecheck expose a blocking shipped-path failure.
- **Source:** assumed — operator directed

## D19: Preserve saved output without changing destructive session cleanup
- **Question:** a normal fresh-session cap pause removed its native journal, making the primary Output region fail.
- **Options:** retain live children or deleted journals; hide NotFound; use labelled durable iteration evidence for settled output.
- **Chose:** settled fresh/ended views read the matching finished iteration's real output tail; live/needs-you/continued-paused views keep structured journal reads and their errors. Report the output source in UI state. No core cleanup or native ownership guard changes.
- **Why:** structured session removal intentionally calls journal.remove, while loop evidence remains durable. The renderer was selecting a resource beyond its lifetime.
- **Evidence:** visible run20261028T060845-277a obs30/F1; API regression red bg31 at output wait, then combined UI gate38pass/0fail/311assertions bg35; buildbg34 and typecheckbg33 exit0. Logic/tech amended before implementation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** saved output masks an error for a live session or selects another loop/session's evidence.
- **Source:** locked by docs/loop/decisions/m5-loops-core.md

## D20: Honor an explicit Stop choice after the loop pauses
- **Question:** a close dialog can be opened while running and its Stop choice arrive after a cap pause.
- **Options:** treat paused as detach-only; stop every non-ended loop selected by the explicit choice.
- **Chose:** re-read loop state after binding validation and stop it unless already completed/stopped; keep ordinary paused-tab closure non-stopping.
- **Why:** the old live-only predicate closed the tab while leaving the loop resumable, contrary to the explicit Stop choice.
- **Evidence:** real daemon/window regression bg36 expected stopped but received paused; after main.ts correction bg37 passed1test/37assertions in6.34seconds.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a close races another binding or fails to preserve the tab on a genuine backend refusal.
- **Source:** assumed — autonomous

## D21: Repair fixture lifetimes and readiness rather than weaken tests
- **Question:** later gates exposed native scheduler lifetime, a missing FormEvent import, short outer watchdogs and premature menu readiness.
- **Options:** skip assertions or extend production deadlines; correct test environment/types and wait on actual seeded agents.
- **Chose:** preserve native scheduler globals across disposable DOM windows; keep both QueueItem and FormEvent types; use30second outer UI fixture budgets around existing8second conditions; wait for actual Claude/Codex rows instead of an incidental menu length. Delete obsolete menu wording/last-row pins without repinning them.
- **Why:** adding Loop made the fallback menu exceed the old numeric threshold before agent detection. A5second fixture watchdog could not enclose its8second condition. No consumer assertion or production deadline was relaxed.
- **Evidence:** initial affected290/292 then291/292; scripts68pass/0fail/570assertions; post-repair UI38/0/311, typecheckbg33 exit0; SC22 failed predicates preserved in gates-final/0.stdout.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the final affected runner fails a condition rather than its outer fixture.
- **Source:** assumed — autonomous

## D22: Keep native conversation ownership strict during UI verification
- **Question:** visible Stop/Close attempts crashed while a continued queue loop remained connected.
- **Options:** weaken native ownership; use a realistic unique new-thread identity in the isolated fixture.
- **Chose:** preserve the production owner guard. The throwaway native fixture now returns a UUID for each new thread, while resume retains the requested identity.
- **Why:** the fixture returned scripted-thread for every process; the queue still owned codex:scripted-thread. persistProviderSession correctly rejected the second owner.
- **Evidence:** run20261028T071503-520f F5/F6; fixture request log, live queue providerSession.id, structured/main.ts365-367. Corrected preflight admitted two distinct native conversations concurrently and removed all owned preflight sessions; both PASS/CLEANUP markers printed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the two remaining visible scenarios fail with distinct fixture conversation identities.
- **Source:** assumed — autonomous

## D23: Preserve explicit component attribution and current public API documentation
- **Question:** two bounded repair workers again used relative edit headers and wrote seven parent paths instead of their isolated targets.
- **Options:** commit unattributed writes; recover exact payloads and restore the parent first.
- **Chose:** read raw transcripts and both versions; relocate all seven exact deltas via anchored edits, restore original parent hashes, then audit/commit/merge the correctly scoped components. Document plus target contexts and reserved close-context keys in the affected API specs.
- **Why:** prompts are not filesystem isolation. No unknown user change was discarded, and no out-of-scope source delta was silently committed.
- **Evidence:** root/target hash restoration and commits9e7ebccd/6354c77d; subsequent parent FormEvent correction; LoopApiDocs read-only coherence report.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** any future worker cannot retain its explicit target prefix.
- **Source:** assumed — autonomous

## D24: Adapt to the landed generic tab-menu contract during the operator merge
- **Question:** current roadmap independently landed Browser's generic plus-menu interface and structured/worker ownership extensions.
- **Options:** maintain two public menu slots; rename landed consumers to our unlanded slot; adapt Loop to the landed contract.
- **Chose:** use only `TERMINAL_TAB_MENU = 'quirky.terminal/tab'`; preserve generic worktree/workspace/group context and Browser's allowed anchor metadata. Keep Browser before Loop by stable contribution ID, with Loop the last contributed action before the typed management footer. Accept and validate the optional worktree context in Loop's window command, while workspace/group remain placement authority.
- **Why:** one published menu API and the existing typed footer avoid parallel conventions and preserve the landed Browser behavior. This supersedes D3's unlanded literal-plus slot and physical placement after Agent settings, not the New Loop action or blank-menu/search behavior.
- **Incoming bindings read in full:** m4-editor-drop-open-in-place D1–D6; m5-automations-dispatch D1–D34; m5-automations-ui D1–D29; m5-structured-runner D1–D53; m6-heimdall-core D1–D37; m6-orchestration-workers D1–D31; sa-browser-pane D1–D34; sa-browser-profiles-settings D1–D25.
- **Preserved:** background/title/deferStart composition; no automatic background-session tab adoption; actual provider snapshots; exact owner/incarnation stop fencing; synchronous human custody; Native/Watch resource and profile ownership; no unsupported native fallback.
- **Evidence:** merge fa9e3ada, eight conflict resolutions, incoming-binding scout, and the concrete newCommand unknown-key rejection corrected without removing any other unknown-key check.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the required post-merge gate identifies a concrete integration failure.
- **Source:** assumed — autonomous, within operator-directed merge

## D25: Declare canonical context at both command-validation boundaries
- **Question:** the required post-merge gate rejected every actual setup invocation with `args.worktree is not allowed`, before the corrected window handler ran.
- **Options:** remove strict validation or drop canonical context from the test; declare the legitimate optional key in the command manifest.
- **Chose:** add optional string worktree to the New command's args properties while retaining additionalProperties:false, the window handler's exact allowlist, and workspace/group placement authority. Keep all six setup tests and their full behavior assertions using canonical context.
- **Why:** the manifest and window handler are separate input boundaries; both must represent the published tab-menu contract. Removing the supplied context or loosening unknown-key validation would hide the real consumer-visible failure.
- **Evidence:** required affected gate bg41:306/307 remote files passed, both macOS-only files passed; sole failing file ui-form-api.test.ts rejected the same legitimate key in all six cases. The manifest omitted worktree despite the handler accepting it.
- **Verification:** post-merge typecheck passed (49.79s, frozen lock unchanged). After the declaration fix, targeted actual daemon/window setup verification passed6/0 with115 assertions in19.82s. No test or assertion was removed or weakened, and no second broad affected/typecheck campaign was run; authoritative land owns the full merge-result gates.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** targeted setup verification or authoritative land identifies a remaining concrete blocker.
- **Source:** assumed — autonomous

## Progress
Ready for authoritative land. Implemented source/evidence is committed through80d05f35; final command declaration correction closes the only required affected-gate failure. Required post-merge typecheck passed;306/307 remote affected files and both macOS-only files passed, then the sole failing setup file passed6/0 with115 assertions after the strict manifest fix. Earlier native CLI/window smoke covers cap/focus/steer/edit/resume/history and Cancel/Keep/Stop close semantics. Visible run20261028T071503-520f passed observe/adjust/queue; remaining visible Stop/Close, tool-partial setup finalization and unstarted final review belong solely to queued m5-loops-ui-visible-stop-close-review and BLOCKERS. Runtime and owned browser cleanup completed. Next: commit this final declaration/evidence, detach, and canonical queue.ts land m5-loops-ui. No complete visible-UI or code-review PASS is asserted.

