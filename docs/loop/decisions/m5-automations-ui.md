# m5-automations-ui decisions

## D1: Build the complete union of the three assigned UI and external-job slices
- **Question:** What scope did the claimed queue item assign?
- **Options:** editor only; editor plus local list; all three title parts
- **Chose:** creation/edit/delete, list/detail/dashboard/run details, and external OpenClaw discovery/control together
- **Why:** The item title explicitly unions three parts; another part's non-goals cannot narrow this union.
- **Evidence:** queue wait lane6, m5-automations-ui title; automations.md sections Create an automation in the UI through External automations jobs file
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the authoritative queue title changes
- **Source:** locked by docs/loop/LOOP.md

## D2: Use the existing plugin and public daemon-owned UI conventions
- **Question:** What should own UI state and feature mutations?
- **Options:** renderer-only local state and private imports; plugin API with daemon-owned navigation/draft/filter state
- **Chose:** extend quirky.automations, keep authoritative definitions/runs in its existing service and expose UI state/mutations as namespaced methods and CLI aliases
- **Why:** Every user-visible action must be scriptable and inspectable; no parallel automation store or scheduler.
- **Evidence:** docs/roadmap.md:19-38; docs/architecture.md:312-324
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public plugin API cannot support a required interaction
- **Source:** locked by docs/roadmap.md

## D3: Prefer feature-document layout, explicit status, and capability-aware controls
- **Question:** Gray areas: layout/density, loading/empty/error states, interactions, capability differences?
- **Options:** new card design and optimistic host assumptions; documented table/two-pane editor and truthful capability state
- **Chose:** documented dense table and two-pane editor (stack on narrow webview); explicit loading/error/unavailable versus empty; retained draft on validation/failure; owner-fenced mutations; presets plus custom cron; four templates; native browser inputs and accessible labels
- **Why:** Preserve recognizable flows, avoid treating failed reads as empty, and avoid silently moving or changing targets.
- **Evidence:** automations.md:36-104,417-447
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual public contracts require a different presentation to remain truthful
- **Source:** locked by automations.md

## D4: Honor structured sessions and existing scheduling fixes
- **Question:** Should UI reproduce Orca terminal/raw-argument/timezone defects?
- **Options:** raw terminal arguments and scheduler OS zone; structured Claude/Codex sessions and stored IANA zone
- **Chose:** structured provider catalogs, disable unsupported raw extra arguments with explanation, preserve explicit timezone and core schedule inspector; no manual-only cadence
- **Why:** Architecture locks background agents to structured sessions; core explicitly rejects raw arguments and fixed timezone/DST defects. Disabled unsupported controls are truthful rather than fake persistence.
- **Evidence:** docs/architecture.md:302-303; docs/loop/decisions/m5-automations-core.md D2,D3; plugins/quirky.automations/README.md:21-29
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a public structured-runner capability safely supports extra arguments
- **Source:** locked by docs/architecture.md

## D5: Use night-mode workflow and verified cross-family review fallback
- **Question:** Which workflow and reachable reviewer should this omp lane use?
- **Options:** full two-spec workflow with research swarms; combined spec and at most three implementers
- **Chose:** one combined logic spec with final technical contracts, no external research swarm, autonomous standard gray areas, task/OpenAI implementers and Gemini high reviewer via pi-watch
- **Why:** Current LOOP night mode applies. pi-watch --check resolved Gemini; Opus and Sonnet had no authed/shipping models. Existing unrelated .serena state preserved in path-only stash lane6-tooling-state-before-automations-ui.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Night mode; pi-watch --check output; xd://lsp status returned no configured language servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required tool or dependency cannot run
- **Source:** assumed — autonomous

## D6: Validate macOS only and preserve external-manager safety on other platforms
- **Question:** Which operating systems can this item claim verified?
- **Options:** infer Linux/Windows parity; macOS proof only
- **Chose:** portable Bun file/process APIs where cheap, macOS verification only; Linux/Windows PATH discovery and child termination need platform verification
- **Why:** Locked loop platform policy.
- **Evidence:** docs/loop/LOOP.md What is already decided
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux/Windows validation becomes available
- **Source:** deferred: platform

## D7: Consume dispatch authority rather than inventing remote ownership
- **Question:** Which owning-host and launch contract is authoritative while dispatch builds concurrently?
- **Options:** local UI-specific target resolver; lane7 public target and expectedOwner contracts
- **Chose:** merge cb9e08b01a41d5e5d0bbe5a14c1804e944aa6786 contracts and consume target({id}) and expectedOwner on edit/remove/run; wait for executable runtime before proof
- **Why:** Captured local registry identity and structured session identity must have one owner. Remote contexts explicitly fail closed; absent SSH/runtime registration cannot become local execution. Lane7's follow-up owns blocked remote generation and raw-argument flows, not a second incompatible implementation.
- **Evidence:** dispatch-contract.ts; m5-automations-dispatch D1-D3,D6-D8; lane7 contract message
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** authoritative dispatch runtime changes these interfaces
- **Source:** locked by docs/loop/decisions/m5-automations-dispatch.md

## D8: Report actual surface data alongside daemon-owned navigation
- **Question:** Can local busy/error/fetched rows remain invisible to API clients?
- **Options:** navigation-only JSON; bounded actual rendered surface reports
- **Chose:** optional report callback on editor/page contracts, aggregated with navigation and draft in the root view report; include actual errors, loading, visible identities and dashboard counts, without duplicating full output snapshots
- **Why:** Agents must inspect what the window shows through JSON, not screenshots or an inferred selection.
- **Evidence:** docs/roadmap.md:31-38; public MountFunction props.report
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** UI report size bounds require narrower summaries
- **Source:** locked by docs/roadmap.md

## D9: Preserve explicit setup consent and background-only structured sessions
- **Question:** How does the editor follow the final dispatch and background contracts?
- **Options:** project-policy auto-run and terminal auto-adoption; explicit skip/run with immutable hook inspection and background sessions
- **Chose:** setup starts skipped; choosing run requires inspected trusted hooks at an immutable workspace head. Missing OID, unreadable hooks, or declined trust saves skip with a visible warning. Native runs use Session.background and explicit View run routes to view:quirky.session/worktree with worktree/session identity.
- **Why:** An unattended run cannot pause for trust or steal the active tab. The public branch picker exposes names, not arbitrary branch OIDs; guessing an immutable revision would authorize the wrong script.
- **Evidence:** editor methods setupDecisionForSave; m5-automations-dispatch D7,D15,D16,D18; authoritative lane7 source959f4eb8 and follow-up a8783ed2
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a public immutable branch resolution API permits safe inspection of every branch
- **Source:** locked by docs/loop/decisions/m5-automations-dispatch.md

## D10: Keep navigation inputs stable and invalidate data through native change events
- **Question:** Why would typing lose focus, newly saved data stay stale, and older history become unreachable?
- **Options:** force remount to refresh; keep the surface mounted and refresh its actual data
- **Chose:** uiNavigate updates daemon state and opens the view only when outside Automations, without changing its input. The page subscribes to native changed events with coalesced reloads and selection-safe fetches. History advances a bounded 100-row window with backward offsets.
- **Why:** PluginSlot remounts when input changes; using a revision in input destroys focus and transient state. UI state refresh alone does not reload definitions/evidence. Appending pages without advancing the render window hides rows beyond100.
- **Evidence:** AutomationPluginValidation findings1-3; packages/ui/src/plugins/PluginSlot.tsx:30-41; src/state.ts and src/list/AutomationsPage.tsx; rendered list-ui regressions
- **Reversibility:** easy
- **Confidence:** high for traced causes; final verification recorded below
- **Revisit if:** native events become granular enough to invalidate less data
- **Source:** assumed — autonomous

## D11: Separate actual native-process proof from incomplete test-gate results
- **Question:** Which results can be claimed after the first integrated gate?
- **Options:** infer all green from worker returns; record exact independent results and repair owning failures
- **Chose:** first affected run passed170remote files plus2macOS files, failed9remote files, no flaky reruns; scripts/typecheck/build did not execute because the gate stopped. Repair missing test dependency closure, explicit valid-prompt setup, incorrect test result-shape consumption, rendered paging tests, and session wire assertions at their boundaries.
- **Why:** The separate actual daemon/CLI smoke exited0 in4.81seconds and proved editor create, captured local owner, name-only edit anchor, paused manual native Codex completion/output/session, OpenClaw pause/readback, unsafe-ID refusal, CLI navigation, and deletion retaining the workspace. That is positive runtime evidence, not clearance of failed tests.
- **Evidence:** bg2 affected gate, artifact38; bg3 JSON ok:true, native run dd4f9875-63fd-409d-a9c1-28f8e58db283, session s_108bba1be648; temporary process scope cleaned its owned home
- **Reversibility:** easy
- **Confidence:** high for those exercised paths only
- **Revisit if:** owning reruns or visible UI dogfood contradict the smoke
- **Source:** assumed — autonomous

## D12: Fix evidence boundaries rather than accepting repeat failures as flaky
- **Question:** What caused the remaining OpenClaw and rendered paging failures?
- **Options:** loosen the tests or retry until green; trace executable lookup and cursor adoption
- **Chose:** explicitly pass process.env.PATH as Bun.which's PATH option; adopt AutomationRunsPage.nextCursor into HistoryState.cursor on initial and older-page reads. Preserve the125-row/back-navigation/stale-response regressions. Remove the native list's unsupported100-row truncation instead of requiring users to search for hidden records.
- **Why:** A fresh isolated Bun probe returned null from default lookup after PATH changed and found the executable with explicit PATH. The rendered diagnostic showed25 loaded runs with no older control because nextCursor had been spread under the wrong state key. A new native-list boundary test failed with125 expected/100 rendered before removing the clamp.
- **Evidence:** minimal which probe default:null/explicit:fixturepath; rendered PAGING_DIAGNOSTIC and original failure; list-ui native-list red125/100, then bg6 28pass/0fail/107assertions across3owning files
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** process environment or public paging contracts change
- **Source:** assumed — autonomous

## D13: Verify typed source and packaged output before visible UI verification
- **Question:** Which final verification is observed rather than inferred from isolated worker code?
- **Options:** accept unit results only; owning reruns, scripts, complete typecheck, packaged build, actual runtime and visible UI
- **Chose:** all nine initially failed files passed in owning reruns; paging/OpenClaw2remote files passed with no flaky reruns; scripts68pass/0fail/562assertions; final editor/model/renderedUI28pass/0fail/107assertions; complete typecheck and packaged macOS build exited0. Lane7 supplied semantic session repair bcdaea1b, which was merged without changing production behavior.
- **Why:** Seven actual TypeScript diagnostics exposed missing narrowings/component return types and fixture optional values. Each was corrected directly, without casts, aliases, hidden fallbacks, or skipped files. The packaged UI built20plugin modules and desktop bundled26plugins.
- **Evidence:** bg5 owning files/scripts; bg6 typecheck/build; source af88e69b. Build reported missing icon.iconset and no release.baseUrl as non-fatal packaging warnings; no icon or release publishing behavior is claimed.
- **Reversibility:** easy
- **Confidence:** high for exercised source/package paths; UI and native-menu proof are separate
- **Revisit if:** visible UI verification finds a behavior those gates missed
- **Source:** assumed — autonomous

## D14: Preserve canonical pointer migration9 and append background as migration10
- **Question:** The one final roadmap catch-up conflicted in session records and structured creation; which contract owns each migration index and launch field?
- **Options:** put background first; preserve the already-landed pointer migration before the unlanded background column
- **Chose:** keep badges8 and session_pointer_operations9 unchanged, append background ALTER as10, and accept background, title and deferStart together in structured/create. Preserve all other auto-merged orchestration runtime identity, lease and idempotent-send contracts.
- **Why:** Existing canonical profiles already mark migration9 applied. Repurposing it as background would leave the column absent and attempt the pointer table twice. Both feature contracts are additive; neither may erase the other's inputs.
- **Evidence:** catch-up conflict blocks in records.ts/main.ts; incoming m6-orchestration-core D39, all D1-D42 read; authoritative lane7 recovery instruction; merge2191c8fc
- **Reversibility:** hard for deployed migration order
- **Confidence:** high
- **Revisit if:** a later migration changes schema without an append-only step
- **Source:** locked by docs/loop/decisions/m6-orchestration-core.md

## D15: Keep unavailable remote UI flows in one dependent follow-up
- **Question:** Can the UI safely offer remote Host selection/moves or remote OpenClaw management before public authority registration and execution exist?
- **Options:** invent SSH paths or redirect to local; show explicit local-only capability and defer remote UI wiring
- **Chose:** local Host and native/external actions ship; unsupported remote authorities remain unavailable with no local fallback. One UI follow-up depends on this item and m5-automations-dispatch-remote-and-args, covering remote Host selection, owner-preserving moves/read errors and remote external-manager controls once those public APIs exist.
- **Why:** Lane7's registered follow-up owns the missing registration-generation/execution and raw-argument policy prerequisites, not this feature's future UI integration. The current kernel has no such public host authority; direct SSH/private imports would violate plugin ownership and host fencing.
- **Evidence:** dispatch D2-D3; canonical queue item m5-automations-dispatch-remote-and-args; editorData local authority projection and externalList remote refusal
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the prerequisite follow-up supplies the public host/capability/owner API
- **Source:** deferred: remote automation UI authorities

## D16: Apply the two-hour rule without inventing independent review
- **Question:** Should an unstarted cross-family review begin after the item's explicit two-hour window?
- **Options:** start another review phase; finish the already-started web campaign and use the mandated expired-item landing path
- **Chose:** no model-review dispatch. Finish the started visible campaign, required integration checks and cleanup, then normal queue land. Gemini availability and staged criteria are not review clearance.
- **Why:** Canonical claim commit1b815f655fb92a8a89dccb05aeef0155e8a654d7 records2026-10-27T22:06:31-05:00, so the window expired05:06:31Z; the observed clock was05:14:28Z. LOOP explicitly skips unstarted review/dogfood on expired items, but never allows ending while a started agent/service is running.
- **Evidence:** canonical claim timestamp; observed date command; no promote/refute/findings/gate artifact exists and review journal reviewStarted remainsfalse
- **Reversibility:** easy
- **Confidence:** high for process compliance; no independent-review assurance
- **Revisit if:** the operator requests a later independent review or a concrete defect appears
- **Source:** locked by docs/loop/LOOP.md

## D17: Verify the composed runtime with real clients, not only merge text
- **Question:** Does the final orchestration/background/check-owner composition still execute the UI's actual API path?
- **Options:** trust conflict resolution alone; focused merged regressions, complete typecheck, actual daemon/CLI and packaged build
- **Chose:** merge c49562d9 without dropping UI methods or canonical migrations. Four migration/background/ownership/native-CLI files passed on the merged tree, no flaky acceptance; full typecheck passed; a fresh actual daemon/CLI smoke passed with native run47407208-8e70-456f-be5b-567249e9c260 and session s_54bb10675d8c; packaged macOS build passed with27plugins and20UI modules.
- **Why:** Activating plugins are live startup-check owners; disabled/failed owners still cancel. The merged native smoke again exercised editor save, schedule-anchor preservation, paused manual completion/output, OpenClaw readback/ID refusal, CLI navigation and workspace-preserving delete through public clients.
- **Evidence:** bg17 exit0/160.38seconds; four-file suite-result ok:true,flaky:[]; frozen-install/typecheck0; actual smoke ok:true; desktop packaged app build0
- **Reversibility:** easy
- **Confidence:** high for exercised client and integration paths; visible UI outcome remains separately recorded
- **Revisit if:** a later integration merge changes the runtime contract
- **Source:** assumed — autonomous

## D18: Honor explicit structured-session navigation without creating a replacement shell
- **Question:** Why did View run open Terminal1 rather than the recorded automation session?
- **Options:** terminal-only openSession; honor the public worktree view's explicit session input
- **Chose:** validate the requested session's workspace, explicitly adopt/select it, and skip default-shell creation. Missing or mismatched identities produce an alert, not a fallback session. Queue nested structured-root disposal rather than unmounting during a parent render.
- **Why:** Background sessions deliberately have no automatic terminal binding. Selecting the recorded session is distinct from automatic adoption and must preserve its identity.
- **Evidence:** source4d5109d6; workspace-view8pass/0fail/84assertions and complete typecheck/build0; actual UI20261028T061353-1ab4 obs5-6 selected the Codex transcript with AUTOMATION_WEB_OK and no replacement shell. Existing nested-root test warnings were not claimed eliminated.
- **Reversibility:** medium
- **Confidence:** high for exercised explicit selection
- **Revisit if:** session identity or public worktree input contracts change
- **Source:** locked by docs/loop/decisions/m5-loops-core.md D19

## D19: Preserve native startup diagnostics and isolate a broken external Node installation
- **Question:** Why did the real UI run fail before the protocol fixture started?
- **Options:** change production launch/PATH behavior; preserve stderr and diagnose the actual child failure
- **Chose:** await existing connection close, then attach bounded stderr to the startup error while preserving cause. Only the disposable scripted Codex fixture uses the existing absolute Bun interpreter; production resolver, environment, argv and ownership policy remain unchanged.
- **Why:** UI20261028T060737-232c obs4 exposed dyld's missing llhttp9.3.dylib from the installed Node25.9.0_1. The fixture never reached its body. This is not evidence against native model/effort validation and does not justify a production fallback or modifying Homebrew.
- **Evidence:** source4d5109d6; real-child diagnostic regression14pass/0fail/59assertions, typecheck0; independent Bun-pinned actual daemon/CLI smoke completed run8f94283d-2973-4955-bdfb-b11d1abbd0be, session s_7335b3cb1b1b in5.47seconds. Protocol stand-in evidence is not a live-provider or billing claim.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the external interpreter is repaired or a native startup failure lacks usable stderr
- **Source:** assumed — autonomous

## D20: Close the started visible campaign with specific continuation evidence
- **Question:** Which UI flows actually passed after the first child campaign stopped early?
- **Options:** count prepared goals as passes; retain original partial results and cite exercised continuations
- **Chose:** original20261028T044328-79db passed create-validation and edit-list-detail; its external pause/resume/run/delete actions succeeded but its sequence prerequisite was partial. Continuation20261028T052940-2f1b passed delete-confirm, all four honest-empty template cards, and settings/navigation. Fresh20261028T061353-1ab4 passed paused manual completion despite scheduled precheck exit77, saved output/history, explicit View run and dashboard counts/filter.
- **Why:** The original100-action wrap-up did not complete the campaign. Continuations exercise the missing visible paths without relabeling old failures or using APIs during UI workflows.
- **Evidence:** corresponding .quirk/using-apps-like-a-user/runs/<id>/report.json and screenshots. All runs were web/yours/unattended, with no foreground/native override. The manual closure's end returned a frontmost-restoration tool error, but kept_open was empty; its goal passed. Browser reload hotkeys did not establish reload. Original row-menu Escape dismissal remains a LOW open finding.
- **Reversibility:** easy
- **Confidence:** high for the named observations only
- **Revisit if:** an actual provider or native-only surface contradicts this controlled fixture
- **Source:** assumed — autonomous

## D21: Correct saved-output parsing, canonical launch evidence and clipped navigation controls
- **Question:** Why were intraword underscores consumed, model/effort missing, the filter panel clipped, and the root breadcrumb indirect?
- **Options:** accept the rendered differences; repair their actual source boundaries
- **Chose:** emphasis delimiters exclude Unicode intraword underscores; launch display consumes the recorded canonical summary rather than invented flat aliases; filters anchor to the right viewport edge; the root run breadcrumb navigates directly to the list.
- **Why:** The previous actual run exposed AUTOMATION<em>WEB</em>OK, an offscreen filter selector and a detail detour. The saved launch snapshot already carries the authoritative model/effort summary.
- **Evidence:** rendered identifier regression failed before the parser fix, then14pass/0fail/49assertions with typecheck/build0. Final fresh-browser render closure20261028T065201-fe17 passed: obs2 panel fully visible; obs3 Failed gives an honest filtered empty state; obs4 Successful restores Done; obs5 preserves AUTOMATION_WEB_OK and displays Codex/gpt-5-codex/reasoning effort medium; obs6 root goes directly to list. End returned0, no overrides, no kept-open windows or cleanup errors. Owned daemon stopped and its temporary home no longer exists.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** canonical launch metadata or Markdown delimiter rules change
- **Source:** assumed — autonomous

## D22: Reconcile final dispatch landing without weakening canonical session contracts
- **Question:** Which late runtime/loop/worker/browser decisions bind the final UI source?
- **Options:** keep the earlier temporary composition; consume canonical e4ec3492 and reconcile every incoming log
- **Chose:** preserve terminal-only automatic adoption for all background values and explicit bindings; active OR activating owner liveness; Codex per-turn usage plus raw rate-limit/reset evidence; session-launch token redaction; canonical badge dedup/name/client-role fields; pointer migration9 then background10. Browser pane modes do not change SessionKind.
- **Why:** These are published contracts, not optional UI preferences. Explicit View run remains compatible and no remote authority or private runtime fallback is introduced.
- **Evidence:** e4ec34921082b57d166806975470e978983e90ed merged without conflict; incoming loops-core D1-D27, presets D1-D19, workers D1-D31, browser-pane D1-D34, dispatch D30-D34 and structured-runner changes read/reconciled by AutomationCatchupDecisions with no actual conflict. Lane7 reports canonical dispatch DONE after649remote+5mac pass and scripts/typecheck0; that report is not this item's final gate.
- **Reversibility:** hard for migration order; medium otherwise
- **Confidence:** high for contract reconciliation
- **Revisit if:** later canonical integration changes these contracts
- **Source:** locked by docs/loop/decisions/m5-automations-dispatch.md D31-D34

## D23: Use the final composed candidate's observed gates
- **Question:** Did the final UI fixes still pass after consuming the canonical dispatch landing?
- **Options:** rely on earlier isolated results; verify the composed candidate
- **Chose:** final affected suite over Automations plus workspace-view, Codex runner and session-record regressions passed17remote files,0failed,flaky:[]; frozen install and complete typecheck passed; packaged macOS build passed with28plugins and21UI modules.
- **Why:** This checks the exact source composition after the renderer fixes and incoming runtime contracts. The earlier170/179 result is retained as historical failure evidence, not relabeled all-green.
- **Evidence:** bg31 exit0/211.38seconds, suite-result ok:true;595installs/609packages unchanged; Quirky.app packaged successfully. Missing icon.iconset and absent release.baseUrl remain non-fatal packaging warnings; neither icon nor release-publishing proof is claimed. Earlier scripts68pass/0fail/562assertions remain the item's observed script gate; normal queue land reruns the whole merged gate.
- **Reversibility:** easy
- **Confidence:** high for the exercised gates
- **Revisit if:** the authoritative land reports a concrete conflict or failure
- **Source:** assumed — autonomous

## D24: Repair the normal merged gate's owning failures rather than waive them
- **Question:** Did the first normal queue landing pass?
- **Options:** accept the earlier focused gate; repair the concrete full-gate failures
- **Chose:** landing remains rejected. Merge current roadmap, preserve its new editor-drop capability decision, and investigate three independent owning boundaries: worker crash/restart fixture/runtime discovery; foreground/background Git fetch ownership; Dock send acceptance/consumer ordering.
- **Why:** Full gate passed651/655remote files and all5macOS files. Shell-path's isolated retry passed20/0, but worker restart failed again and stopped remaining retries. No script/typecheck-after-suite clearance occurred and no retry policy or assertion is waived.
- **Evidence:** bg32 exit1/331.65seconds, remote1793171027850-29800. Worker first failed JSON EOF in acceptance-support callAs, then restarted private daemon exited0; Worktree failed a real origin/main ref-lock conflict during immutable-setup-revision creation; Dock found second body at44 before first at94. Three scoped repair agents received those observed failures without rerunning baseline merely to confirm them. Incoming m4-editor-drop-open-in-place D1-D6 read: no supported Finder source-path API, no native patch or substitute flow authorized; no conflict with Automations.
- **Reversibility:** easy
- **Confidence:** high for observed gate failure; causes remain under investigation
- **Revisit if:** owning repair evidence identifies a different producer boundary
- **Source:** locked by docs/loop/LOOP.md step7.3

## D25: Publish fixture replies atomically and observe the CLI's real recovery daemon
- **Question:** Why did worker acceptance see JSON EOF and then a restarted process exit0?
- **Options:** ignore parse/exit failures; repair fixture publication and duplicate daemon ownership
- **Chose:** acceptance-control writes each reply to a same-directory temporary file and renames it into place. Crash acceptance keeps SIGKILL, then observes the pending CLI's normal autostarted replacement rather than launching a competing daemon; require a distinct healthy PID and register it with the fixture process scope.
- **Why:** The reply path previously existed before writeFileSync completed. Separately, the actual CLI reconnects/autostarts after ConnectionLost; the fixture's additional spawn legitimately exited0 when another healthy daemon already owned that home. Production runtime publication already uses atomic rename and needed no change.
- **Evidence:** acceptance-control.ts reply writer; acceptance-support.ts polling reader; acceptance-restart.ts lifecycle; protocol/node connectDaemon default autostart and CLI link reconnection. Persisted start_unknown, pending dispatch, untouched input and exact-replay refusal assertions remain.
- **Reversibility:** easy
- **Confidence:** high for traced causes; owning gate result recorded separately
- **Revisit if:** an actual CLI recovery publishes no healthy replacement or a malformed atomic reply appears
- **Source:** assumed — autonomous

## D26: Serialize repository base fetches without changing the immutable setup revision
- **Question:** Why could a later create race an earlier background Git refresh?
- **Options:** suppress ref-lock errors; serialize all owned base fetches per repository
- **Chose:** reuse Worktree's existing KeyedQueue for background and required foreground base fetches; retain the existing30second required-fetch default and all error/fallback semantics. The setup-revision regression defers a real fetch until after hook inspection, avoiding its own independent conflicting raw fetch; a separate held-refresh regression verifies a later create cannot start another fetch early.
- **Why:** Background refresh can outlive the create queue slot. A create mutex alone therefore does not own the lifetime of its Git ref update. The checked hooks OID must remain the eventual workspace HEAD even when the remote-tracking ref changes.
- **Evidence:** worktree/src/daemon/base.ts; create.test.ts immutable HEAD assertion and real-fetch gate. Fixture cleanup releases gates and settles accepted fetches before restoring the Git adapter.
- **Reversibility:** medium
- **Confidence:** high for the ownership boundary; owning gate result recorded separately
- **Revisit if:** another owner bypasses base-fetch serialization
- **Source:** assumed — autonomous

## D27: Preserve send arrival order before asynchronous preflight can reorder it
- **Question:** Why did Dock's second body reach the real PTY before the first?
- **Options:** loosen substring ordering; reserve admission before binding and preflight
- **Chose:** same-pane admission orders binding resolution; accepted-session admission orders preflight through enqueue. Release both at enqueue, leaving the existing operation queue in charge of execution/cancel/disable/exact-session safety. No public API or retry/timeout policy change.
- **Why:** The previous queue only ordered operations after independently asynchronous preflights completed. It could therefore faithfully execute an already-reversed enqueue order; this was not a marker collision.
- **Evidence:** terminal-dock/src/service.ts send/admission; send.test.ts waits for both full bodies and submits, then asserts first submit before second body and second submit at or after the exclusive body end. send requires an explicit nonempty pane; missing selectors are rejected rather than pretending to have ordered aliases.
- **Reversibility:** medium
- **Confidence:** high for the traced acceptance race; owning gate result recorded separately
- **Revisit if:** public send accepts a new selector alias or preflight ownership changes
- **Source:** assumed — autonomous

## D28: Require actual recovery, PTY consumption and remote-base creation proof
- **Question:** Did the rejected-gate repairs pass their real client paths?
- **Options:** accept agent claims; run owning regressions, typed checks and isolated actual programs
- **Chose:** worker-restart and Dock files passed their owning run; the added Worktree regression initially exposed an undeclared fixture counter, which was restored, then its entire owning file passed with no retries. Complete typecheck passed before that final file run.
- **Why:** The separate actual CLI smoke SIGKILLed its owned daemon, observed a distinct healthy CLI-recovered PID, retained start_unknown/pending/outcome_unknown, refused exact replay and submitted no preamble. The actual PTY smoke consumed two complete sends in arrival order and drained the queue. A fresh actual daemon/CLI created two distinct remote-base workspaces at the expected OID, then completed the native automation/UI API smoke.
- **Evidence:** bg33 two files passed/one failed, then bg34 exit0/94.20seconds, Worktree suite-result ok:true,flaky:[]; workerRecovery/dockFifo JSON true; workspaces wt_bc0759add19d and wt_51109ff6fc8a at8f2628b5dff456571c45f0f9da398dfc449312d0; native run a04a647b-c488-4c02-879c-5c7b67a4d665, session s_b1f28de68db3. Captured owner acceptance is not stale-owner negative proof. Packaged build passed28plugins/21UI modules with the same icon/release warnings.
- **Reversibility:** easy
- **Confidence:** high for exercised paths; authoritative normal land remains the final gate
- **Revisit if:** the next merged gate reports a concrete failure
- **Source:** assumed — autonomous

## Progress
Step7 retry ready: D25-D27 repairs passed owning regressions, complete typecheck, actual CLI/PTY/remote-base/native smokes and packaged build as D28 records. All repair agents and finite verification jobs returned. Commit the seven owning source/test files and this log, detach and retry canonical queue land. Keep the one registered remote follow-up and prior UI evidence; no independent-review clearance, second follow-up or second item.
