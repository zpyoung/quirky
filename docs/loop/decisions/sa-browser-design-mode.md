# sa-browser-design-mode decisions

## D1: Build the three design flows together
- **Question:** Which scope and approval process applies?
- **Options:** grab alone; all three parts; ask a person
- **Chose:** grab, annotate/delivery and screenshot drawing together; autonomous recommendations, no human asks, no companion/adhd/research swarms, one self-reviewed logic spec with technical final section.
- **Why:** canonical lane3 wait returned the combined item; LOOP night mode overrides interactive skill gates.
- **Evidence:** canonical queue wait iteration4; read-only browser.md:87–108; logic.md.
- **Reversibility:** medium (acceptance scope)
- **Confidence:** high
- **Revisit if:** canonical queue scope changes
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve Native and exact-page Watch engine identity
- **Question:** Which approach implements inspection without breaking browser architecture?
- **Options:** iframe inspection; replace Native with Chrome; shared guest picker over Native and exact Watch
- **Chose:** shared guest program and bounded host sanitizer, Native sandbox execution plus owned Watch CDP binding; no URL matching or engine substitution.
- **Why:** cross-origin iframe cannot inspect arbitrary pages; Native/Chrome separation is locked.
- **Evidence:** docs/architecture.md:180–203; sa-browser-pane D2/D4; native-browser.ts sandbox host-message and tag executeJavascript.
- **Reversibility:** hard (engine/data boundary)
- **Confidence:** high
- **Revisit if:** supported host APIs change the binding model
- **Source:** locked by docs/architecture.md

## D3: Adopt source interaction and visual defaults
- **Question:** Visual gray areas: layout, density, empty/loading/error, interactions?
- **Options:** toolbar/tray source interaction; command-only tools; new separate inspector window
- **Chose:** accessible three-tool toolbar, white highlight/dark label, armed banner, repeated picking, coordinate-based selection without prior hover, right-click menu, editable/collapsible annotation tray, real original-resolution drawing canvas; visible errors preserve data.
- **Why:** these are documented flows, and coordinate-only selection is the source's unconfirmed defect path.
- **Evidence:** browser.md:91–108,275–306,460; logic G1/G3/A1/D1.
- **Reversibility:** easy (presentation)
- **Confidence:** high
- **Revisit if:** real UI exercises reveal inaccessible controls
- **Source:** locked by browser.md

## D4: Clamp before clipboard, format, display or delivery
- **Question:** API/Data gray areas: response/errors, validation, budgets, persistence?
- **Options:** trust guest; UI-only validation; shared validation at privileged boundary
- **Chose:** reject malformed root objects; finite rectangles; exact source budgets; allowlisted attributes and safe credential/query/fragment-free URLs; script/event/form secret removal;2MiB fail-closed PNG crop; annotations memory-only20/page,2000-character feedback, screenshot null.
- **Why:** guest is untrusted, output may be pasted into an agent; display and formatting cannot be a second trust bypass.
- **Evidence:** browser.md:279–306; logic G2/A1/A2.
- **Reversibility:** medium (export contract)
- **Confidence:** high
- **Revisit if:** regression shows an information leak or incorrect truncation
- **Source:** locked by browser.md

## D5: Bound picker lifetime and preserve ordinary copy
- **Question:** Integration gray areas: cancellation, conflict and shortcut precedence?
- **Options:** held RPC until click; nonblocking bounded operation; global copy interception
- **Chose:** one opaque operation/page120s, short reads, replacement/navigation/disposal invalidation, no long profile lock waiting for a person; Mod+C only without editable focus or selection; C/S only armed; Esc cancels.
- **Why:** prevents profile deadlock, stale cross-page output and ordinary copy regression.
- **Evidence:** browser.md:35–39,275–277,432–434; source coordinate-only observation460.
- **Reversibility:** medium (operation lifecycle)
- **Confidence:** high
- **Revisit if:** simultaneous-page/close tests expose stale results
- **Source:** locked by browser.md

## D6: Use guarded public agent APIs and snapshot sends
- **Question:** Integration gray areas: target scope, readiness, new-agent prompt and send failures?
- **Options:** import git internals; direct unguarded PTY writes; public terminal/agents/session APIs
- **Chose:** public APIs, same-worktree validation and readiness at delivery, explicit target choice, new hosted agent launch with prompt-after-ready; hold snapshot IDs until settlement; keep edits/failure/uncertain sends; remove only actual delivered unchanged notes; never blind retry.
- **Why:** preserves replacement boundary and avoids duplicate prompts/data loss.
- **Evidence:** browser.md:383–389; quirky.git/src/daemon/targets.ts existing public call patterns; quirky.agents delivery API.
- **Reversibility:** medium (cross-plugin contract)
- **Confidence:** high
- **Revisit if:** public readiness/initial prompt outcome cannot establish actual delivery
- **Source:** locked by docs/roadmap.md

## D7: Defer only Native screenshot capture behind supported SDK capability
- **Question:** Can the system-webview provide actual cropped/frozen screenshots using the pinned public SDK?
- **Options:** private FFI; OS screen capture; DOM approximation; honest unavailable Native capture while implementing Watch capture
- **Chose:** Native text picker/annotations through sandboxed guest evaluation; Watch PNG crop/draw through real CDP. Native screenshot and Draw explicitly unavailable pending supported snapshot API; record one combined dependent follow-up just before land.
- **Why:** inspected BrowserView and full SDK screenshot/capture search expose no public page snapshot; executeJavascript has no completion, but existing guest host-message supports bounded untrusted evaluation results. No unsupported capture success API is advertised.
- **Evidence:** apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts:269–274; SDK-wide snapshot/capture grep (only unrelated atlas dirty snapshots); packages/ui/src/native-browser.ts:86–100,371–438.
- **Reversibility:** medium (SDK prerequisite)
- **Confidence:** high for inspected public boundary, no private capability claim
- **Revisit if:** supported native snapshot/crop API is available
- **Source:** deferred: Native image capture

## D8: Use three disjoint implementers and Gemini review
- **Question:** Which execution pair and decomposition is reachable?
- **Options:** omp+Opus; omp+Gemini; same-family review; one broad task
- **Chose:** IMPLEMENTER omp-task/OpenAI, REVIEWER_ALIAS gemini/google/gemini-3.1-pro-preview:high; Runtime extraction/API, UI picker/annotations/contributions and Native+Markup in isolated worktrees; cap3, one wave, parent integrates.
- **Why:** actual probes: Opus/Sonnet unavailable; Gemini/Codex/Terra/Flash reachable. Shared contracts committed before workers; no overlapping source files or mid-flight checks. xd LSP reports no configured servers.
- **Evidence:** iteration4 actual pi-watch --check outputs; logic technical partition; shared native/design types.
- **Reversibility:** easy (next run)
- **Confidence:** high
- **Revisit if:** scope audit or API feasibility requires explicit replan
- **Source:** assumed — autonomous

## D9: Verify native-only facts through isolated nightly handoff
- **Question:** Platform/verification gray areas: how to verify Native without foreground or real storage?
- **Options:** infer Native from web; foreground desktop run; real Watch web smoke plus pending Native scenarios
- **Chose:** one fresh-home actual daemon/Chrome/API/CLI and web UI dogfood, pending Native picker/clipboard/shortcut scenarios using fresh UUID partitions; never real Default storage. Linux/Windows integration remains deferred.
- **Why:** unattended loop permits only web UI here, and native storage isolation is not proven by QUIRKY_HOME.
- **Evidence:** LOOP Verify; sa-browser-pane D7/D15; docs/loop/NATIVE.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** nightly supplies actual failures
- **Source:** deferred: platform

## D10: Consume pending browser-pane source and preserve integration dependencies
- **Question:** Early dependency is not landed; which baseline can implementers consume?
- **Options:** idle/end turn; duplicate pane code; merge dependency branch and merge repairs before final gates
- **Chose:** merged build/sa-browser-pane into item branch at572a61a5, resolving lock as dependency browser workspace plus preserved integration/mobile packages; bun install reported no changes. Initial canonical deps command was interrupted at60s, not a readiness verdict; repeat with an appropriate waiting deadline once reachable implementation is done.
- **Why:** LOOP early-item contract explicitly requires development against pending dependency branches and same-turn wait until ready.
- **Evidence:** actual git merge conflict tool resolutions and commit572a61a5; bun install589checked; canonical deps timed-out evidence.
- **Reversibility:** medium (branch ancestry)
- **Confidence:** high
- **Revisit if:** dependency blocks or changes a binding contract
- **Source:** locked by docs/loop/LOOP.md

## D11: Honor the inherited browser follow-up freeze
- **Question:** Should the Native snapshot boundary create another queued follow-up under the older loop rule?
- **Options:** add another item; hide the gap; preserve the gap in decisions/BLOCKERS without growing the queue
- **Chose:** no browser queue addition; keep Native cropped screenshots and Draw explicitly unavailable and record both flows together in BLOCKERS. This supersedes only D7's planned queue-add sentence, not its capture safety boundary.
- **Why:** dependency D18 and inherited BLOCKERS contain the latest operator browser-follow-up freeze; earlier item decisions bind dependent work.
- **Evidence:** sa-browser-pane D18; docs/loop/BLOCKERS.md:274–279; current LOOP What is already decided.
- **Reversibility:** easy (operator can requeue the prerequisite)
- **Confidence:** high for the recorded freeze
- **Revisit if:** operator changes the freeze or supported SDK snapshot becomes available
- **Source:** supersedes sa-browser-design-mode D7 (queue-add portion), locked by sa-browser-pane D18

## D12: Close source integration defects before claiming acceptance
- **Question:** Which source-inspection findings block assembled verification?
- **Options:** trust worker completion; defer introduced defects; fix exact consumer-facing seams
- **Chose:** retain annotations/held snapshots across tab remount in window memory; install a bounded Native guest chord listener; let markup own Escape/clipboard commit and enable its pointer hit testing; guard current session permission/readiness at delivery; correct scrolled DPR crop offsets; preserve authored feedback. No claim that these source fixes pass until exercised.
- **Why:** source inspection identified note loss, dead canvas input, clipboard-cancel bypass, permission transitions and viewport/page coordinate mismatch. They affect the named feature flows.
- **Evidence:** parent source findings to BrowserDesignUi/Runtime/NativeMarkup; actual protocol model.ts:207–243,256–282; component source reports; regression files.
- **Reversibility:** medium (lifecycle and safety)
- **Confidence:** source-backed, runtime proof pending at recording
- **Revisit if:** actual tests/smoke expose remaining failure
- **Source:** assumed — autonomous

## D13: Assemble audited source checkpoints, then accept the combined contract
- **Question:** Can component acceptance run before the runtime, UI manifest and Native capability are assembled?
- **Options:** test each against missing peer implementation; copy source through a fourth tree; audited unverified source checkpoints plus combined acceptance
- **Chose:** authoritative barrier required unchanged HEADs, disjoint declared scopes and zero parent diff; passed. Committed source checkpoints69ea95bd/946e99c1/28d0deaf, merged them, removed owned component worktrees. These commits were explicitly unverified; no passing worker checks invented.
- **Why:** actual runtime API tests require the UI-owned schemas and UI tests require runtime/markup outputs. Combined acceptance is meaningful; component success reports were not evidence.
- **Evidence:** /tmp/quirky-browser-design.hjsqFr/wave-audit.json; component commits and actual merge tool output.
- **Reversibility:** easy (acceptance still gates land)
- **Confidence:** high for attribution, no behavioral claim
- **Revisit if:** combined gate fails
- **Source:** assumed — autonomous

## D14: Repair actual parse and registry failures without weakening validators
- **Question:** The first assembled compiler/validator gate rejected source; what is the root fix?
- **Options:** suppress validation; extend deadlines; correct payload syntax and required manifest fields
- **Chose:** restore the omitted annotation revision declaration/return brace; add meaningful CLI flag descriptions. The actual parser reported45missing descriptions:12new design flags plus33inherited pane flags in the unverified dependency checkpoint. These prerequisite metadata fixes stay in this item's manifest; shared validator remains unchanged.
- **Why:** malformed source cannot compile and invalid manifest disables the entire Browser plugin. The validator agent's source finding was reproduced through actual parseManifest.
- **Evidence:** bg6 TS1005 at payload.ts382; BrowserPluginValidation; actual parseManifest errors through JS Eval. Focused bg5 was canceled after evidenced native evaluation failures/known parse error, not declared passing.
- **Reversibility:** easy
- **Confidence:** high for observed failures; corrected behavior awaits gate
- **Revisit if:** parser/compiler finds another contract error
- **Source:** assumed — autonomous

## D15: Preserve framework close, event and Watch interception contracts
- **Question:** Actual Browser activation, Watch navigation and pane closure exposed dependency checkpoint defects; which contracts govern?
- **Options:** weaken registry/terminal contracts; hide failures; adopt the dependency owner's canonical repairs
- **Chose:** correct fileURLToPath to node:url; wire events omit the contribution-only `event:` prefix; continue owned Fetch.requestPaused outside the page queue and disable interception on Watch stop; paneClose accepts terminal-only tabId, validates provenance and returns true as the public hosted-tab contract requires.
- **Why:** actual activation failed on the invalid import; active/stopped Watch navigation hung before the request continuation/cleanup; close failed params.tabId. Terminal invokes close hooks with tabId and requires boolean true. Read the owner's repaired candidate and adopted its exact close contract instead of inventing another shape.
- **Evidence:** actual smoke failures and subsequent Watch/API pass; packages/daemon/src/plugins/events.ts:28–40; terminal layout/service.ts:318–321; read-only dependency candidate pane-service.ts:843–860; Orca lane4 coordination receipts.
- **Reversibility:** medium (public lifecycle contract)
- **Confidence:** high for observed roots; full dependency gate still pending
- **Revisit if:** incoming dependency checkpoint changes the canonical contract
- **Source:** locked by sa-browser-pane canonical hosted-tab contract

## D16: Separate test-driver defects from actual product results
- **Question:** Which failed probes establish product defects rather than an invalid harness?
- **Options:** call every failure a product bug; silently retry; record setup/driver failures with corrected independent observations
- **Chose:** preserve interrupted/failed runs. Native matcher creation was before its trigger, so reorder assertions; unsupported fake timer declarations replaced with real5s product deadlines and8s test harness caps, without changing product timers. Controlled React inputs use the repository's native setter/focus/input/keyup pattern. Mobile crop fixture declares a real responsive viewport; no arbitrary850px assumption on a scaled980px layout. Run API Chrome tests in their own process, as the suite already does.
- **Why:** actual diagnostics identified test-only deadlocks/type errors and unrecognized text input; a responsive fixture then passed real DPR2 dimensions and selected-element pixels. Combined multi-file focused run timed out; isolated actual picker passed, so the combined run is not passed off as green.
- **Evidence:** NativeEvalRepair trace; compiler artifact60; bg10 33pass/3fail; corrected bg15 compiler exit0 and36pass/0fail/189assertions; bg16 actual coordinate picker1pass/7assertions; bg20 scrolled DPR crop1pass/10assertions; existing terminal features-support.ts:465–472.
- **Reversibility:** easy (fixtures)
- **Confidence:** high for exercised fixes
- **Revisit if:** standard per-file affected suite exposes another failure
- **Source:** assumed — autonomous

## D17: Prove text, pixels and delivery through real isolated processes
- **Question:** What counts as the feature smoke rather than a mocked forwarding test?
- **Options:** trust worker unit reports; use real homes/accounts; owned real daemon/PTY/Chrome plus a local recording agent
- **Chose:** fresh isolated runtime and mock-keychain Chrome, actual CLI/API coordinate selections, rearm, page-click suppression, crop/full PNG and navigation cancellation; actual new-agent argv and existing-agent stdin observation. Preserve authored “password” feedback. The recording OMP is local-only, with isolated HOME/search path; no external model/account is used.
- **Why:** unit tests alone do not show runtime delivery or captured pixels. New-agent API returned command-line before the recorder file appeared; inspected the actual live session and argv, then tested existing delivery without blindly relaunching it.
- **Evidence:** actual API/CLI smoke pass (crop544x67/full756x469); visually read PNGs; /tmp/quirky-browser-design.hjsqFr/api-smoke-evidence.json and delivery-evidence.json; real recorder argv/stdin. Failed smoke-only event-filter/rearm/Markdown-escape assertions remain disclosed as harness corrections.
- **Reversibility:** easy (verification approach)
- **Confidence:** high for observed API/PTY paths; native surface remains pending nightly
- **Revisit if:** final synchronized source changes these paths
- **Source:** assumed — autonomous

## D18: Keep failed UI asset deployment evidence in the same guarded run
- **Question:** The first actual Browser pane was blank with a404; was the feature bundle missing from the build?
- **Options:** call it passing; bypass the resource root guard; correct the owned fixture deployment
- **Chose:** retain the404/blank-pane observations, replace only the run-owned wrapper's external dist symlink with an in-root copy of the actual built bundle, confirm HTTP200 JavaScript128227bytes, and resume the same guarded UI run. Future smoke setup copies assets rather than symlinking out of the plugin root.
- **Why:** the daemon correctly refused an out-of-root symlink; this was fixture packaging, not established product behavior. No source/public-resource policy was relaxed.
- **Evidence:** UI run20261028T042907-dbf5 obs3/obs4 and findings; owned wrapper path under /tmp/qdesign-m1JtEi; actual HTTP200 response after copy; passed packaged build23plugins.
- **Reversibility:** easy (fixture only)
- **Confidence:** high for the404 root and corrected asset delivery; UI goals still in progress at recording
- **Revisit if:** the same blank pane persists with the real bundle loaded
- **Source:** assumed — autonomous

## D19: Finish the original Grab payload image contract without holding a user-waiting lock
- **Question:** The source attaches a cropped image to Grab payloads; can Watch selection return only text context when capture is supported?
- **Options:** leave every selection image null; capture every hover; capture the consumed Grab selection outside its page lock
- **Chose:** attach one bounded real crop after selected Grab read, outside the profile lock; recheck the operation and exact generation before returning. Oversized/unavailable PNG remains null, stale selection does not return success, other capture errors propagate. Force annotation screenshots null again at the host boundary.
- **Why:** completes the initially named Screenshot/payload contract without lock recursion or continuous hover screenshots.
- **Evidence:** browser.md:304–306; GrabPayloadImageRepair scoped diff; design runtime PNG-signature/budget/annotation regressions. Runtime verification still gates acceptance.
- **Reversibility:** medium (payload latency)
- **Confidence:** source-backed; final runtime test required
- **Revisit if:** real regression exposes a capture/stale-response race
- **Source:** locked by browser.md

## D20: Skip the unstarted final review after the actual two-hour point
- **Question:** Should an unstarted final cross-family campaign begin after the item's night-mode limit?
- **Options:** start another campaign; call an unrun review green; obey the night rule and keep mandatory behavioral gates
- **Chose:** skip the unstarted C/S/X final review; preserve that it supplied no assurance. Continue the already-started UI campaign and fix its blocking product findings, exercise the actual source paths, run affected/scripts/type/build gates and land once the dependency permits.
- **Why:** authoritative claim commitcc75544c is02:45:09Z; observed clock04:47:22Z is past04:45:09Z. LOOP says overdue items skip any unstarted review/dogfood. UI was already started; its errors must not be erased.
- **Evidence:** integration claim log and actual date command; current LOOP night mode; existing guarded UI run20261028T042907-dbf5.
- **Reversibility:** easy (later independent review can identify real findings)
- **Confidence:** high for the timing/rule, no correctness claim
- **Revisit if:** actual gates or the ongoing UI run find a blocking defect
- **Source:** locked by docs/loop/LOOP.md

## Progress
Compiler and36isolated invariants passed; real Watch/CLI/PNG/new+existing PTY smoke passed on the owned runtime. Original screenshot payload attachment added; subsequent runtime file had3pass/1cold identity timeout, not a green file. Actual UI run recovered asset404 but exposed Reload's void-CDP-response navigation bug; BrowserWatchReloadRepair patched driver/tracker and added a real regression, now running as bg30. Visible Watch address action also now commits its draft before conversion; operator's cached older UI uses Enter as its honest route. At04:47:22Z the item is overdue; D20 skips the unstarted final review, not mandatory tests or observed bugs. Dependency still pending, no land/overall completion claim.
