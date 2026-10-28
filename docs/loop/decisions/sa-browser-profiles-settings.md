# sa-browser-profiles-settings decisions

## D1: Follow unattended night-mode scope and approvals
- **Question:** Which workflow gates need a person, and which Browser flows belong here?
- **Options:** ask a person; skip design; work through all material gray areas and record defaults
- **Chose:** recorded autonomous design, one combined spec with technical decisions, no research swarm/companion/adhd/asks; section2 menus and Settings table only, import engine excluded.
- **Why:** current build/roadmap LOOP.md overrides ordinary skill user gates; queue wait lane8 returned this early item, dependency sa-browser-pane.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; external browser.md:72-85,110-130; item logic.md.
- **Reversibility:** medium (acceptance)
- **Confidence:** high
- **Revisit if:** locked feature scope changes
- **Source:** locked by docs/loop/LOOP.md

## D2: Reuse profiles and settings through public plugin contributions
- **Question:** Visual/API/CLI gray areas: layout, density, interactions, loading/error, state, auth, destructive behavior, empty state?
- **Options:** independent profile store; private shell integration; existing BrowserStore plus public methods/settings and compact React menus
- **Chose:** existing Default/profileCreate/list; same compact menu/settings patterns; loading/errors visible; API/CLI for every action; confirm clear/delete, refuse active profiles; Settings uses canonical terminal settings, no mirrored copies.
- **Why:** public API, scriptability and replaceability are locked. Empty means Default and explicit capability explanation, not fake sources or success.
- **Evidence:** docs/roadmap.md:19-53; profiles/store.ts; quirky.accounts settings-section pattern; browser.md section2/Settings.
- **Reversibility:** medium (API)
- **Confidence:** high
- **Revisit if:** existing public capability cannot execute an accepted flow
- **Source:** locked by docs/roadmap.md

## D3: Preserve source routing outcomes without changing file-link behavior
- **Question:** Integration gray areas: routing ownership, modifier precedence, failures and setting mapping?
- **Options:** external-only; consumer-specific copies; single Browser openLink method and consumer adapters
- **Chose:** routing off/system default, inversion off; Cmd/Ctrl opens, Shift+modifier forces external unless inversion enabled; routing failure stays visible, no silent fallback; plain/middle choices reuse terminal namespace; file copy/reveal unaffected.
- **Why:** exact source outcomes with one policy owner, ordinary authenticated API and no extra retry or protocol execution surface.
- **Evidence:** browser.md:123-127; terminal links.ts/current terminal settings; logic SC6.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual interaction proves an inaccessible/conflicting chord
- **Source:** locked by browser.md

## D4: Treat missing import/native identity/localhost mapping as prerequisites, not success
- **Question:** Integration/Data gray areas: protected-source access, identity engine differences, faithful label routing, scope boundary?
- **Options:** read installed browsers on mount; fabricated menu sources/no-op controls; explicit unavailable capability plus exact dependent follow-ups
- **Chose:** no automatic source discovery; imports clearly unavailable until extras method exists, Google exclusion visible, hideable hint. Chrome clean/native identity applied on next runtime only. Native UA change and reachable worktree-labelled localhost require real hooks/mapping; do not represent them effective without it. Record and queue these exact missing flows before land.
- **Why:** sa-browser-agent D37/D38 deliberately removed import/identity backend; native BrowserView public API inspected has partition but no UA override. Display-only hostname rewriting breaks reachability. Core profile/settings flows do not require those unavailable prerequisites.
- **Evidence:** sa-browser-agent D37/D38; installed BrowserView.ts:44-218; browser.md:82,122,127,406; logic SC4/SC7.
- **Reversibility:** medium (outside capability)
- **Confidence:** high for inspected APIs; no claim all SDK versions lack hook
- **Revisit if:** extras/native routing prerequisite lands
- **Source:** deferred: import engine integration, native identity and localhost mapping

## D5: Agree explicit native profile isolation and clear semantics with pane owner
- **Question:** How can profile switch/clear avoid mixing app shell or unrelated browser storage?
- **Options:** use app default partition; display-only profile; explicit pre-creation isolated partition and supported public Session clearing
- **Chose:** persist:quirky-browser-${profileId}; allowed default or profile_[0-9a-f]{32}, never shell partition; lane4 adds pane.profileId/partition, native option, clearPartition, service setPaneProfile seam. Lane8 owns profileSet method and clear/delete command. Reject plain-web/native-unavailable clear without metadata/data mutation, refuse active profiles, quiesce Chrome before directory deletion.
- **Why:** SDK partition cannot safely change after construction; public Session.fromPartition.clearStorageData exists. No native test may touch real Session; nightly validates actual isolation/clear.
- **Evidence:** lane4 coordination receipt/input d992a4a6 and3cc690e5 plus owner reply in session; SDK BrowserView.partition and native.ts:3346-3394.
- **Reversibility:** medium (persisted identity)
- **Confidence:** high
- **Revisit if:** SDK native partition semantics fail nightly scenario
- **Source:** assumed — autonomous

## D6: Select OpenAI implementers and reachable Gemini review
- **Question:** Execution pairing, partition and acceptance coverage?
- **Options:** omp+Opus; omp+Gemini; same-family; one broad worker
- **Chose:** omp OpenAI tasks, Google Gemini via pi-watch; three disjoint components (backend preferences/profile lifecycle/identity, React preferences, link consumers). Parent integrates manifest/service/CLI/native/window seams. Shared types/spec committed first, fresh isolated worktrees, no checks while peers active. One final review/fix batch, affected remote suite/scripts/typecheck and web dogfood once.
- **Why:** actual preflight Opus/Sonnet unavailable, Gemini reachable; disjoint scopes allow parallelism while dependencies remain explicit. No planned successor wave/checkpoint.
- **Evidence:** pi-watch --check output: gemini google/gemini-3.1-pro-preview:high, opus0/8; xd://lsp status no configured server; logic Technical decisions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a genuine shared-file requirement changes the partition
- **Source:** assumed — autonomous

## D7: Keep platform/native verification honest
- **Question:** Which UI facts can a web-only dogfood prove?
- **Options:** infer native from web; touch real native profiles; owned web smoke plus nightly native handoff
- **Chose:** fresh HOME/QUIRKY_HOME, owned daemons/process cleanup; web --owner yours --unattended; native profile/partition/deletion tests pending nightly. Linux/Windows native storage, click modifiers and external launch verification deferred.
- **Why:** LOOP.md prohibits native foreground use in lanes and requires isolated state.
- **Evidence:** docs/loop/LOOP.md Verify; docs/architecture.md Browser; item logic DF5.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** nightly identifies an actual failure
- **Source:** deferred: platform

## D8: Guard native clearing with one-use confirmation capabilities and admission control
- **Question:** Can a directly invoked window command bypass destructive confirmation, or can a late native clear erase data after a new pane enters the profile?
- **Options:** trust raw partition command args; release a profile gate on every UI timeout; one-use pending confirmed request and fail-closed admission
- **Chose:** profileClear/Delete mint opaque one-use requests after dispatcher confirmation; only a UI/desktop caller may claim one, yielding only the validated Browser partition. Check native availability before claiming. Gate profile admission before the first native await and reject createPage/paneOpen/profileSet during clear. Chrome/data/metadata mutation follows a claimed, acknowledged native completion. An already-claimed command with unknown completion keeps the profile unavailable until daemon restart; unclaimed failure releases it.
- **Why:** public ui.command.run is itself scriptable, and a timeout does not prove the native action stopped. A small explicit gate prevents both confirmation bypass and late-clear data loss without arbitrary cancellation/retry machinery.
- **Evidence:** packages/daemon/src/plugins/layout.ts:291-304,358-366; packages/daemon/src/plugins/dispatch.ts:102-135; src/preferences-lifecycle.ts; preferences-integration.test.ts one-use/concurrency scenarios.
- **Reversibility:** easy (internal capability lifetime)
- **Confidence:** high for policy; runtime verification pending
- **Revisit if:** the window-command protocol supplies provable cancellation or completion recovery
- **Source:** assumed — autonomous

## D9: Reject native clear before invocation until the SDK can acknowledge completion
- **Question:** Does Session.clearStorageData returning void establish that WKWebView data removal completed, and does QUIRKY_HOME isolate native storage?
- **Options:** equate await-void with completion; invoke and poll incomplete cookie visibility; reject before invocation and queue the exact unsupported flow
- **Chose:** clearPartitionAvailable=false for current native and web adapters; clearPartition rejects completion-unavailable before any real Session invocation. Window command checks capability before consuming the confirmed token. Profile clear/remove retain Chrome data and metadata and report unavailable. Queue sa-browser-native-profile-clear-completion, dependent on this item. Native nightly uses two fresh run-owned UUID partitions only; never clear/use Default without proven native storage-root isolation.
- **Why:** projected SDK native.ts:3347-3365 exposes invocation without acknowledgement/barrier, native websiteDataStore implementation and storage-root override are not projected or documented. Owner confirmed no real Session clear ran. Profile creation/switching/settings ship independently; claiming deletion parity would be false.
- **Evidence:** lane4 user evidence packet in this session; installed native.ts:3347-3365; authoritative queue add /tmp/quirky-l8-native-clear-followup.json exited0; logic SC3 amendment; native handoff file.
- **Reversibility:** medium (requires SDK capability)
- **Confidence:** high for inspected public API limitation; no claim private implementation never waits
- **Revisit if:** supported completion and native storage-root isolation are established
- **Source:** deferred: native profile clear completion; supersedes sa-browser-profiles-settings D5

## D10: Follow overdue night mode without inventing review or UI-campaign evidence
- **Question:** Should an unstarted final review or full dogfood campaign begin after the item exceeds its two-hour bound?
- **Options:** start another campaign; call an unrun campaign passing; apply the explicit night rule and retain real-path smoke/gates
- **Chose:** skip the unstarted final review and formal full UI dogfood campaign; neither is reported passing. Finish actual acceptance/type repairs, exercise the changed UI surface in a focused owned smoke, run affected remote/scripts/type gates, reconcile dependency/roadmap and land. No additional queue items after the operator freeze.
- **Why:** branch creation was 2026-10-28T00:50:16Z after claiming, and the actual clock reached02:52:22Z. Current LOOP.md explicitly requires an overdue item to land once its own checks pass and skip unstarted review/dogfood. This is not permission to hide actual failures or skip runtime proof.
- **Evidence:** git reflog branch creation; actual date output02:52:22Z; current build/roadmap LOOP.md night mode; incoming sa-browser-pane D18/D22.
- **Reversibility:** easy (later review/native run can identify findings)
- **Confidence:** high
- **Revisit if:** actual acceptance, runtime smoke or typecheck finds a defect; fix it before land
- **Source:** locked by docs/loop/LOOP.md

## D11: Hold complete profile admissions and preserve existing editor gestures
- **Question:** Can a clear race an opening pane before metadata exists, and should routing change plain rich-editor clicks?
- **Options:** check maintenance once; count pending admissions across awaits; make every rich-editor click navigate
- **Chose:** pending profile admission count covers complete paneOpen/tabCreate/profileSet operations; clear refuses pending use before native dispatch. Profile menu pending state survives same-profile telemetry updates. Rich editor retains modifier-only navigation; ordinary link clicks remain editing. Removed raw path-alias pinning from the Chrome ownership test in favor of two distinct canonical owned directories.
- **Why:** paneOpen awaits public worktree resolution before saving metadata, so a pre-await check alone cannot protect clear. Actual UI regression reproduced pending radios re-enabled by a new telemetry object; actual Markdown regression navigated on ordinary edit click. Raw /var versus /private/var was not a distinct profile identity.
- **Evidence:** preferences-lifecycle.test.ts red missing admission method then1pass6asserts; preferences-window.test.ts telemetry case red then16pass101asserts; editor browser-link-routing.test.ts ordinary-click red then1pass3asserts; automation C1 raw-alias red then1pass16asserts. Actual owned Chrome identity smoke returned Chrome/156 for clean and HeadlessChrome/156 for native,2owned processes each, both cleanupcompleted.
- **Reversibility:** medium (lifetime invariants)
- **Confidence:** high for exercised boundaries; native storage isolation/removal remains unproved
- **Revisit if:** dependency repair changes pane identity or admission paths
- **Source:** assumed — autonomous

## D12: Reveal routed panes and use the terminal's canonical boolean close contract
- **Question:** Does an API-created hosted tab become visible, and what must a hosted-tab close method return?
- **Options:** return a hidden pane as success; widen Terminal to accept arbitrary objects; add another close alias; reveal the resolved worktree and return one boolean close shape
- **Chose:** openLink calls public ui.view.open for view:quirky.session/worktree using paneOpen's resolved worktreeId, not the caller selector. paneClose returns boolean true for both external API and terminal pre-close; fromTab/tabId are validated against the terminal plugin and actual pane tab. No object/boolean shim or weaker Terminal contract.
- **Why:** the first actual web smoke remained in an empty global view; the CLI regression observed ui.state.layout.view=null despite route=app. After reveal, real UI displayed the pane. Terminal.ensureViewsClosable requires result===true, so an object result refused a real tab close even after the tabId schema was repaired.
- **Evidence:** initial partial report .quirk/using-apps-like-a-user/runs/20261028T025907-2aed/report.md; route regression red then pass using name:BrowserLinks resolved ID; actual profile/hosted-close API5pass43asserts; terminal layout/service.ts:317-321; canonical method schema and README; repository refs enumerated before cutover.
- **Reversibility:** medium (unstable public API before first pane land)
- **Confidence:** high for exercised API/CLI/hosted-close behavior
- **Revisit if:** a new caller needs a richer close result; add a separate explicit state read, not an ambiguous success union
- **Source:** assumed — autonomous

## D13: Report focused UI proof and native limits separately
- **Question:** What did the overdue focused smoke actually prove?
- **Options:** equate it with full parity/native proof; omit the first partial setup; retain both receipts and name the exercised surface
- **Chose:** first run remained partial with no preference action; after real route/reveal repair, focused run20261028T030719-ce44 passed10guarded UI actions. Created/selected a fresh profile with retained tab/address, saw import/Google disclosure, hid hint, opened settings, saved Native identity with restart-required/Cleaned-active text, and visibly inspected active-profile removal/native-clear/localhost limits. Native Session operations were never run.
- **Why:** source UI and daemon behavior must agree, but web screenshots cannot establish native storage deletion/isolation. Formal full parity campaign and final review remain skipped under D10, not called green.
- **Evidence:** focused report .quirk/using-apps-like-a-user/runs/20261028T030719-ce44/report.md, screenshots2–11 personally read; report shows no test overrides, no gates, kept-open nothing and no cleanup errors. F1 is the explicit allowlist fixture's missing quirky.git Explorer status, not exercised Source Control. Owned runtime supervisor exited0 after scope cleanup; the first completed supervisor's stdin latch was separately reaped.
- **Reversibility:** easy (further verification can add evidence)
- **Confidence:** high for exercised controls, no native deletion assurance
- **Revisit if:** actual surface or native nightly contradicts the recorded outcomes
- **Source:** assumed — autonomous

## D14: Cut URL gestures over from the temporary copy mapping
- **Question:** Which URL gesture contract wins over the earlier terminal-only implementation?
- **Decision:** Supersede m1-term-ui D21's temporary Shift+modifier URL-copy mapping with Browser.md's alternate-destination routing. Keep explicit Copy Link and existing file editor/reveal behavior. Use the application's CHORD_PLATFORM for modifier interpretation.
- **Why:** terminal and rich-editor URL gestures must agree with the Browser contract and the existing application chord engine; navigator.platform disagreed with the remote Mac fixture.
- **Evidence:** actual terminal link feature tests4pass30asserts after platform/routing repair; Markdown ordinary-click edit-preservation negative regression1pass3asserts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the owning source specification changes
- **Source:** assumed — autonomous

## D15: Read click policy from the current model, not a stale render
- **Question:** Can a setting update precede its React render and affect the next URL click?
- **Decision:** Read and validate the two canonical terminal click settings at event time, retaining one small cached object. Resolve disabled settings to the owning pane's defaults. Update FakeContext's model before its listeners, and unmount the headless React root inside act before unregistering its DOM.
- **Why:** the real model changes before deferred plugin events/render; an event handler captured stale policy. A guessed teardown delay did not guarantee that React stopped before window disappeared.
- **Evidence:** deterministic model-before-event regression6pass20asserts; actual link features4pass30asserts with no window-undefined teardown error. React nested-root warnings observed in other affected runs are not hidden or called a clean bill of health.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public UI model ordering contract changes
- **Source:** assumed — autonomous

## D16: Count actual Find occurrences without replacing page content
- **Question:** How should Watch Find handle three matches in one text node?
- **Decision:** Keep a self-contained Range/escaped-RegExp page function and return the actual current/total pair. Preserve the original text node, support directional wrap/query reset/clear, and serialize the literal query. Do not import private UI helpers or synthesize an ordinal in the service.
- **Why:** DOM.performSearch counted matching nodes, not occurrences. Changing the fixture to three nodes concealed the defect.
- **Evidence:** source Watch case1pass27asserts after73d57ae3; packaged real Chrome smoke reports first1/3, next2/3, textNodePreserved=true. Eligibility follows text nodes; cross-node phrases, shadow roots and frames are not claimed.
- **Reversibility:** easy
- **Confidence:** high for exercised scope
- **Revisit if:** the owning Find eligibility contract expands
- **Source:** assumed — autonomous

## D17: Reconcile incoming public UI contracts
- **Question:** Do the incoming Hosting, sidebar, worktree, automation, orchestration and mobile decisions change preference ownership?
- **Decision:** Preserve their public API, flat-schema, confirmation/private-home conventions. Mark Browser Settings as a settings view and await ui.view.open so public Settings links and navigation failures work. Keep pane lifecycle contracts from the dependency; do not merge22d17dfd wholesale because it removes our main exports.
- **Why:** the incoming public view.settings link is distinct from SettingDeclaration.menu; another routing alias is unnecessary.
- **Evidence:** reconciliation read the complete incoming decision logs (Hosting reviews D1–25/tasks D1–24, sidebar D1–12, worktree creation D1–23, automation D1–13, orchestration D1–42, mobile D1–23), plus pane D13–25. Packaged UI exercised Browser Settings from both the Browser menu and public Settings link.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the final roadmap catchup adds a binding conflict
- **Source:** assumed — autonomous

## D18: Separate passing evidence from the remaining source-runtime failure
- **Question:** What is currently verified, and what still prevents landing?
- **Decision:** Record root types/build and required script gates as passing, the non-Browser affected suite as passing with its configured Search readiness retry, and the Browser source runtime suite as failing. Retain consumer-visible acceptance; delete only C5's copied API-inventory assertion rather than re-pin it to today's method list. Do not call the failed suite green or use the pane scope cut as a waiver.
- **Why:** nine remote Browser files pass, but macOS automation/Watch tests timed out and reported lost CDP/helper mapping. Their configured retry also failed. A dedicated runtime repair owns the actual cause.
- **Evidence:** scripts68pass532asserts; root typecheck EXIT0; final build27plugins/20UI modules EXIT0 (missing icon/release URL warnings retained). Non-Browser220remote files passed after one configured features-search SC73 readiness retry, plus3macOS files. Packaged runtime Find and profile/menu/Settings navigation passed; initial fixture launch omitted packaged PTY paths, corrected launch did not. Allowlist UI still reports omitted quirky.git status and a missing quirky.sidebar-extras setting; these are not whole-app approval.
- **Reversibility:** evidence can be extended
- **Confidence:** high for the receipts, source runtime unresolved
- **Revisit if:** the runtime repair and final integrated gates finish
- **Source:** assumed — autonomous

## D19: Challenge only targets created by the requested new tab
- **Question:** Why did source Browser acceptance spend most of its deadline binding a fresh page?
- **Decision:** Snapshot CDP target IDs immediately before explicit helper tab_new. Fresh binding considers only new page targets, retaining exact helper tab_switch validation and the unpredictable Debugger.scriptParsed challenge. No new target means fail safe; no timeout increase, blind target matching or identity fallback.
- **Why:** the old binder debug-enabled every preexisting page, including the unused Chrome startup tab. A traced first probe took66,005ms; same-process before/after IDs showed startup-target enable2,185ms versus new-target enable1ms. Probing unrelated pages is unnecessary work and expands the binding deadline with each page.
- **Evidence:** private source Chrome/CDP, long-root isolated multi-page and exact nested suite-sandbox smokes passed. A throwaway Bun-test probe reproduced the slow debugger phase; after filtering, full C1-shaped profile/concurrent-page/default-page/cleanup smoke passed18.6s, new-target enables1–14ms. An earlier post-patch generic helper-map failure remains unexplained; integrated directory gate is pending, not called green. All probes and owned processes cleaned.
- **Reversibility:** easy
- **Confidence:** high for candidate exclusion, residual helper variability not attributed
- **Revisit if:** native tab_new no longer guarantees a newly created target or integrated acceptance fails
- **Source:** assumed — autonomous

## Progress
2026-10-28: preferences, Find73d57ae3 and dependency f4489799 integrated; verified receipts/spec/C5 inventory cleanup committed33494cfa. Fresh-target binding repair D19 applied, runtime investigator completed/cleaned; no timeout changes or weakened challenge. Integrated Browser directory suite bg_34 running; updated root types bg_35 EXIT0. Earlier final build27plugins/20UI modules/scripts pass, non-Browser affected suite passes with one configured readiness retry. Packaged real Chrome Find and actual compiled profile/menu/Settings navigation exercised; all owned UI runtimes/browser closed. Dependency deps wait bg_33 returned pending pane; continue waiting in this turn. Next: collect integrated Browser gate/fix real findings, rebuild changed artifact, dependency ready, one final roadmap catchup/read decisions, controller land and notes. No native clear/isolation, full parity campaign or final-review pass claimed.
