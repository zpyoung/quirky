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

## D21: Integrate lane4's narrowed acceptance without shrinking design mode
- **Question:** Does the operator's pane scope cut establish Watch UI acceptance or remove this item's three design flows?
- **Options:** attribute all Watch behavior to lane4; silently drop design flows; retain this item's acceptance and separately prove its required Watch subset
- **Chose:** merge published f4489799 as5d1853f4, retain Native/public/profile seams, all design schemas/CLI/runtime/UI code, and the no-review/no-newqueue ruling. Lane4 D23 remains API/CLI lifecycle/navigation only; existing host-controls/events/preview owners retain their broader handoffs. This item's Watch design acceptance is separate and is not inherited as a pass.
- **Why:** the user explicitly narrowed the dependency, not Grab/Annotate/Draw. The scout read incoming locks and found no removed required method; boolean paneClose/tabId is the concrete changed contract.
- **Evidence:** priority user update; IncomingPaneScopeLocks; sa-browser-pane D23–D25; merge5d1853f4. Conflict resolution preserved our8design CLI entries and Mac runtime test route while taking canonical helper/menu/test-report and Fetch/Security teardown repairs.
- **Reversibility:** medium (acceptance ownership)
- **Confidence:** high for scope/merge, no broad Watch guarantee
- **Revisit if:** actual required design paths cannot pass on the retained source
- **Source:** locked by priority operator ruling and sa-browser-pane D23

## D22: Fix the actual frame-consumer transition and rerun only the original acceptance campaign
- **Question:** Why did Watch expire after one real successful Grab, and how can fixed code be exercised without bypassing the guarded tool?
- **Options:** extend the frame lease; ACK undecoded data; fix loaded-frame identity; mutate the old page outside the guard
- **Chose:** record the loaded frame identity in the shared validated acknowledgment path, sharing it with the ACK identity. Previously it was never recorded, so a following frame was deferred forever. Preserve failed run20261028T042907-dbf5; apply product fixes and use fresh guarded fix-then-rerun windows for the same original goals. Do not use private page actions or call an old report green.
- **Why:** the real report showed Copied then a missing-ACK lease failure. The existing browser had cached its imported module and the guarded tool has no application-navigation/reload action; LOOP Verify6 explicitly requires fixing product failures and rerunning. “Dogfood once” is one acceptance campaign, not permission to ship a known failure.
- **Evidence:** original obs41–43 and report; BrowserPaneWindow loadedFrameRef/acknowledgeFrame; successful new bundle deployment hash; UI rerun20261028T050642-b31f. The original end used keep_open:false but left its browser; parent closed only that named session successfully. No foreground/clipboard restoration claim is inferred from the tool's partial cleanup.
- **Reversibility:** easy (consumer state and verification procedure)
- **Confidence:** high for the source transition and failing-before observation; corrected full UI matrix still gates land
- **Revisit if:** the fresh campaign still exposes a frame stall
- **Source:** assumed — autonomous under LOOP Verify6

## D23: Crop full-viewport PNG pixels locally rather than changing the live compositor
- **Question:** Why did Grab turn the visible Watch pane into the selected element's crop?
- **Options:** viewport-reset or screencast retries; direct CDP clipping; full screenshot and local bitmap crop
- **Chose:** no CDP clip. Capture a full viewport, then crop pixels with pngjs7.0.0 (@types/pngjs6.0.5), scaling by bitmap width/window.innerWidth. Bound decode to32million pixels, clip offscreen rectangles, fail closed above2MiB, and never downscale. Keep overlay restoration and exact generation checks. Package the dependency's MIT license through the existing asset convention.
- **Why:** the guarded rerun visibly retained a cropped frame and pointer/lease failures after Grab; the source requirement captures a viewport bitmap then crops, avoiding compositor side effects. A small pure-JS codec is simpler and more portable than custom PNG encoding or native image dependencies.
- **Evidence:** rerun cropped-frame observations and original intermittent post-crop pointer error; BrowserPngCropRepair; installed registry versions; design/png.ts and pixel/budget regressions; pngjs LICENSE.
- **Reversibility:** medium (capture implementation)
- **Confidence:** high for the observed clip side effect; final real Watch capture regression required
- **Revisit if:** screenshot capture still changes the displayed Watch viewport
- **Source:** locked by browser.md Screenshot contract

## D24: Preserve armed keyboard and Native overlay semantics
- **Question:** Why did toolbar-focused C/Escape have no visible effect, and how does S remain useful after text copy?
- **Options:** require an undocumented focus click; globally intercept editable input; honor armed noneditable shortcuts before toolbar exclusions
- **Chose:** armed C/S run before toolbar exclusions; editable inputs and ordinary copy retain precedence. Escape invalidates an in-flight arm as well as an active picker. Retain only the last copied selection for the documented immediate-S handoff, tied to the same pane/page/lease/viewport identity; explicit rearm, cancel or navigation clears it. C still requires an actual hover. Native does not advertise unavailable screenshot output. Mark Native annotation pins/tray with the existing public native-mask attribute.
- **Why:** the fresh report showed missing no-hover feedback and Escape during rearm. Source inspection also showed automatic rearm discarded the image associated with the just-copied text. Native layers cannot be covered with z-index alone.
- **Evidence:** rerun F1/F2; DesignWindow shortcut ordering/copy state; native-browser default mask contract; pending native N-COPY/N-LIFETIME scenarios.
- **Reversibility:** easy (window-only state)
- **Confidence:** source-backed; actual shortcut rerun and Native nightly remain required
- **Revisit if:** real interaction steals ordinary editing or exposes stale selection data
- **Source:** locked by browser.md design interaction and sa-browser-pane Native mask contract

## D25: Consume the authoritative lifecycle dependency
- **Question:** Which pane source and acceptance may this item rely on?
- **Options:** retain published checkpoint; consume the now-landed authoritative source.
- **Chose:** consume the authoritative source.
- **Why:** dependency lifecycle repairs are landed and must not be reimplemented here.
- **Decision:** Merge build/roadmap after the operator's authoritative land verdict for sa-browser-pane and m6-orchestration-workers (pane1b6153b7, helper538881c2). Preserve the pre-creation target-ID snapshot, exact new-target/session challenge and fail-closed binding. Preserve headless Page.bringToFront immediately before helper tab selection; this is not OS focus.
- **Evidence:** Operator reports643 remote and5Mac files,5configured isolated retries, scripts68/0/570 and merged types passing. Those are dependency-owner results, not this item's final merged-tree verification.
- **Scope:** Lifecycle/navigation API+CLI only; no inherited Native/full-UI, screencast or profile-composition claim. No new queue items or unstarted review.
- **Confidence:** authoritative land plus source-backed merge; changed-source gates remain required.
- **Reversibility:** hard (dependency identity/security contract)
- **Revisit if:** the exact owned target cannot be proved.
- **Source:** locked by operator land verdict and sa-browser-pane D23–D34

## D26: Keep privacy and fixture costs explicit
- **Question:** What did the final invariant checks expose?
- **Options:** weaken limits/extend timeouts; repair privacy order and fixture cost.
- **Chose:** repair privacy order and fixture cost.
- **Why:** privacy precedes truncation and real image boundaries must remain unchanged.
- **Decision:** Scan guest strings for secret markers before truncation, both guest- and host-side. Preserve authored feedback separately. The new long-prefix secret regression failed before that repair. Remove the positive mock-formatter/clipboard echo assertion; keep the observable right-click/no-auto-copy boundary and actual runtime/UI clipboard evidence.
- **Decision:** Isolate every mounted UI fixture with afterEach cleanup. Restore required cancellation fixture behavior so failed assertions cannot leak roots or poison later cases.
- **Decision:** Keep the PNG test's5s limit. A valid noisy-image boundary fixture exceeded it only under concurrent compilation; cheaper uncompressed fixture generation preserves the same production rejection path and passed4tests/13assertions in179ms. Do not raise timeouts or lower image fidelity.
- **Confidence:** observed failure and focused passing fixture; final combined gate remains required.
- **Evidence:** failing-before artifact294; focused PNG run4pass/13assertions/179ms; design-payload.test.ts and design-ui.test.ts.
- **Reversibility:** easy (validation and isolated fixtures)
- **Revisit if:** final source gates reject the same boundaries.
- **Source:** assumed — autonomous

## D27: Bound images without destructive editing or invented chat
- **Question:** Do Grab and full Draw need the same transport limit, and what agent surface is supported?
- **Options:** reuse Grab's2MiB ceiling for full Draw; use the existing transport ceiling with decoded-pixel bounds.
- **Chose:** separate Grab and full-image limits, reject destructive overflow, and retain the locked terminal delivery surface.
- **Why:** a full viewport is larger than one element; neither earlier marks nor engine/session separation may be silently discarded.
- **Decision:** Grab remains2MiB encoded; full Draw uses the existing50MiB encoded transport allowance, with the32M decoded-pixel ceiling. PNG crops are actual pixels, never downscaled approximations. At the shape limit reject a new mark visibly rather than evicting earlier work.
- **Decision:** New/existing interactive delivery is terminal-based. Native chat is explicitly dropped in docs/architecture.md; structured background sessions do not gain interactive chat or automatic foregrounding.
- **Evidence:** Run20261028T050642-b31f passed Annotate, all7Markup tools and lifetime goals. Send success passed but refusal was not safely reachable in that run; Grab repairs required a bounded rerun. Its end reported frontmost-restore cleanup failure with no kept-open browser; no restoration claim is made.
- **Next:** Fresh current-daemon/current-PTY runtime, bounded original Grab/refusal regressions, affected gates and canonical land. Preserve both earlier reports rather than relabeling partial outcomes.
- **Reversibility:** medium (image boundaries); hard (locked agent architecture)
- **Confidence:** source-backed; Native-only behavior remains pending nightly.
- **Revisit if:** the public SDK adds snapshot support or actual bounded image delivery fails.
- **Source:** locked by docs/architecture.md and browser.md; assumed — autonomous image budget

## D28: Distinguish clipboard-only success from a changed screenshot
- **Question:** Did the second coordinate pick lose input?
- **Options:** change rearm behavior from guard NO_EFFECT alone; inspect the missing clipboard outcome through visible UI.
- **Chose:** inspect the clipboard outcome before changing code.
- **Why:** successful auto-rearm clears hover and may display the identical Copied message.
- **Evidence:** Run20261028T070420-ee9d obs33 visibly pasted `<p id="question">Why is this panel so wide?</p>` after the second pick. Its clipboard changed correctly; the guard's NO_EFFECT classification remains recorded. RepeatedGrabRepair returned no changes.
- **Reversibility:** easy
- **Confidence:** high, actual visible paste
- **Revisit if:** a later visible paste retains the earlier target.
- **Source:** assumed — autonomous

## D29: Repair the actual merged Chrome gate failures
- **Question:** Why did the affected gate fail its pane file while144remote and the other4Mac files passed?
- **Options:** loosen Watch/timeout semantics; repair the fixture's controller usage and duplicate request continuation.
- **Chose:** keep an acknowledged Watch lease and use paneInput throughout reload input; remove only the duplicate Fetch.requestPaused handler introduced by the merge.
- **Why:** the unacknowledged fixture mixed general automation click with its Watch controller. Duplicate listeners also tried to continue the same request; a duplicate-resume rejection could end Watch and discard its auth handler.
- **Evidence:** Initial and configured isolated retry each had2pane failures. After the fixes, pane.test.ts passed4tests/78expectations; no processes matched its four fresh homes. Against canonical1b6153b7, Fetch handling now matches; the remaining driver delta is the required new-loader/load-completion reload repair, still bounded30s.
- **Reversibility:** medium
- **Confidence:** high, named-failure recovery
- **Revisit if:** exact Watch input or auth navigation fails on the final integration tree.
- **Source:** assumed — autonomous; canonical sa-browser-pane lifecycle contract retained

## D30: Preserve toolbar focus and own non-passive wheel input
- **Question:** What remained after the final bounded UI campaign?
- **Options:** suppress console warnings/force asynchronous focus; preserve focused arming controls and install the correct native wheel listener.
- **Chose:** retain focusable Grab/Annotate controls while arming, with pending aria semantics and authoritative pending-click guards. Use one lifecycle-cleaned native non-passive Watch wheel listener instead of React's passive route.
- **Why:** disabling the initiating focused control risks losing the pane's shortcut owner; forcing focus after await could steal a user's newer focus. A passive listener cannot honor preventDefault.
- **Evidence:** Run20261028T070420-ee9d passed stale-target refusal, second-copy visible paste, immediate S, context-menu PNG and Escape. Fresh toolbar S lacked feedback; C feedback followed an intervening Dismiss click. Its one-pixel scroll emitted the passive-listener error at obs71. Ordinary selected-text copy stopped at the50-action goal cap (67/120run actions), a tool limit rather than a proved app defect.
- **Reversibility:** easy
- **Confidence:** source-backed; repaired wheel/toolbar paths require the final bounded UI rerun.
- **Revisit if:** pending cancellation steals focus, wheel leaks to the host, or toolbar S remains silent.
- **Source:** assumed — autonomous

## D31: Translate macOS editing commands, not just DOM key events
- **Question:** Was ordinary Watch copy merely a headless clipboard limitation?
- **Options:** label it a tool limitation; inspect actual selection and repair keyboard translation.
- **Chose:** repair standard macOS Meta editing through CDP commands, preserving the existing input API and exact-target guard.
- **Why:** after the guarded cmd+a/c sequence, public read-only eval reported MacIntel, active INPUT and selection8:8 in “Normal copy text”. A WindowsVK-only probe then delivered keyCode65/metaKey=true/defaultPrevented=false but still left selection10:10. Delivering a DOM keydown did not invoke macOS editing defaults.
- **Evidence:** Official CDP Input schema exposes editing commands. Standard Meta selectAll/copy/cut/paste/undo/redo bindings on keyDown made a fresh-home public probe select0:10 and paste correctly between two owned inputs. The permanent public Watch regression passed1test/2expectations in isolation. No clipboard permission grant, DOM fixture special case, API expansion or host clipboard bridge was added.
- **Reversibility:** medium
- **Confidence:** actual selection and same-guest paste proved; final host UI copy rerun remains required.
- **Revisit if:** ordinary copy arms the picker or platform editing diverges.
- **Source:** assumed — autonomous; CDP Input.dispatchKeyEvent commands contract

## D32: Keep the final verification boundary honest
- **Question:** What passed, and what still needs integration verification?
- **Options:** hide a timeout behind an isolated pass; retain both outcomes and run the required merge-result gate.
- **Chose:** retain the full-file timeout, the isolated new regression pass and the earlier complete pane/browser passes separately. Canonical land must verify the actual merge result; no all-green claim precedes it.
- **Why:** the final keyboard worker's full pane.test.ts invocation emitted one daemon line and hit its3600s tool deadline (reported3884.51s), without a test result. Its later isolated regression passed, and no matching fresh-home processes remained. The timed-out invocation is not passing evidence.
- **Evidence:** Before the keyboard repair, the clean8db98e52 gate passed9remote+3Mac Browser files, scripts68/0/570, typecheck and full28-plugin/20-UI-module build; broader unchanged importers had144remote and other Mac passes from the initial affected run. Gate tree941becc9615c861c78802ee9396111b99a66544d is archived separately.
- **Reversibility:** easy
- **Confidence:** exact observed outcomes; final integration result pending.
- **Revisit if:** canonical land reproduces the timeout or any named failure.
- **Source:** assumed — autonomous; locked by LOOP.md verification/land contract

## D33: Keep residual Watch host-clipboard acceptance with its approved owner
- **Question:** Does corrected guest editing prove clipboard transfer into the host UI?
- **Options:** claim a tool-only failure; build an additional clipboard relay here; retain the exact residual base-pane input acceptance under the existing operator-approved owner.
- **Chose:** retain the residual host-transfer acceptance with sa-browser-pane-native-host-controls, as sa-browser-pane D23 explicitly assigns remaining Watch input/base-pane UI there. No queue addition or title change.
- **Why:** the final web run visibly selected all “Normal copy text” and left Grab disarmed after cmd+c, so the design shortcut did not hijack normal editing. Public tests proved same-guest copy/paste. Host address paste remained empty; its cause is unresolved and is not labeled a tool failure or a Native result.
- **Evidence:** Run20261028T094623-7210 obs4 shows selection, obs8 empty host paste, obs9 restored URL without navigation. Report remains partial. Earlier run20261028T080620-50e2 proved fresh-toolbar S feedback and cancellation; wheel had no console errors/host-layout scroll, with guard NO_EFFECT recorded. Both runs ended with no kept-open browser or cleanup error; clipboard restoration is unconfirmed.
- **Reversibility:** medium
- **Confidence:** high for observed selection/guard behavior and approved ownership; cross-context clipboard transfer not accepted.
- **Revisit if:** the existing host-controls owner proves transfer or identifies a supported relay preserving copy semantics.
- **Source:** locked by latest operator ruling and sa-browser-pane D23; deferred: residual Watch host clipboard transfer

## D34: Preserve local tooling metadata without shipping it
- **Question:** How can a clean source gate proceed with an unrelated untracked .serena directory?
- **Options:** stage/delete it; preserve it intact outside the gate and restore it after landing.
- **Chose:** preserve the directory under the owned scratch root, without staging or deleting its contents; restore the original path before scratch cleanup.
- **Why:** diagnostic metadata is not feature source and its ownership need not be guessed.
- **Evidence:** the first gate stopped before tests on its clean-tree prerequisite; subsequent recorded gates used clean committed source. The preserved path is /tmp/quirky-browser-design.hjsqFr/preserved-serena.
- **Reversibility:** easy
- **Confidence:** exact filesystem preservation; restoration required in final cleanup.
- **Revisit if:** the original destination reappears; preserve both rather than overwrite.
- **Source:** assumed — autonomous

## D35: Recover the advanced roadmap without losing profiles or design
- **Question:** How is the controller's merge-conflict rejection recovered?
- **Options:** choose one feature's files wholesale; compose both current public contracts on the item branch.
- **Chose:** merge current build/roadmap on the item branch, compose profile admission with design cancellation, retain both registration groups and all complete independent regression scenarios, then rerun changed-source checks before resubmitting.
- **Why:** incoming profiles/settings own complete asynchronous admission, isolated profile switching and canonical close-hook validation. Design mode must use those seams, not overwrite them. Incoming Watch Find counts literal eligible text occurrences.
- **Evidence:** IncomingRoadmapLocks read all6changed decision logs: sa-browser-profiles-settings, m4-editor-drop-open-in-place, m5-automations-dispatch, m5-automations-ui, m6-heimdall-core and m6-orchestration-ui. No incoming source supplies clipboard transfer, Native capture, dropped-source paths or acknowledged native storage deletion.
- **Constraints:** preserve reject-before-Session clear/remove behavior and fresh UUID Native testing; one public openLink routing owner and current-model click settings; background structured sessions do not adopt hidden terminals or auto-focus. Preserve exact new-target/session challenge and headless bringToFront.
- **Reversibility:** medium
- **Confidence:** incoming locks inspected; composed-source checks and canonical result remain required.
- **Revisit if:** the merged source violates admission/target ownership or loses either feature's tests.
- **Source:** locked by incoming decision logs and LOOP.md land-conflict recovery

## Progress
Source submission is complete. Dependency readiness is true; authoritative roadmap and incoming locks are merged. The clean8db98e52 gate passed Browser9remote+3Mac files, scripts68/0/570, types and full build; finalebad5509 keyboard source passed types/build and its new public regression. D32 retains the anomalous full-file timeout for the required canonical merge-result gate. Actual reports prove all3design flows, delivery success/refusal, repeated copy, immediateS/menu PNG, toolbar feedback/cancellation and no passive-wheel console error. Residual Watch-to-host ordinary clipboard transfer is explicit under existing D23 ownership; Native-only acceptance remains pending. All owned UI runtimes and source workers have stopped. Next: commit these evidence-only docs, detach and run canonical land; do not claim integration acceptance before that result. Afterward archive raw reports/gates, restore preserved .serena and remove owned temporary homes.
