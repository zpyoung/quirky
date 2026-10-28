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

## Progress
2026-10-28: spec/contracts419df709; lane4 type checkpoint023a7a90 merged, production still pending. Three original implementers returned with no commits/checks, HEAD419df709 verified. Backend12 API/store tests71 assertions and2 identity tests passed; accepted componente022ef6e merged86b51635, worktree removed. A concurrent blank line in parent store was preserved inb865c015 before additive conflict resolution; no user code discarded. Generated .serena/project.local.yml excluded from component commits. Link unit19/41 passed; two new consumer tests incorrectly used plain Actions click while expecting direct Open, fixed to Cmd-click after observed red. UI test did not reach assertions because Browser package lacked React; parent declared existing repo React19.2/types/DOM test deps and installed. UI corrective worker fixes inspected zoom100-versus-level0 mismatch, home-page explicit Save, and overlapping profile switch; no new checks while it runs. Four exact outside-prerequisite flows queued with BLOCKERS/native handoff. Next: UI fix barrier, acceptance and component merges, integrate real lane4 production/service/UI/manifest, full affected remote/scripts/types and owned smoke, one cross-family review/fix, deps ready, roadmap catchup and land. No UI/native/deletion parity pass is claimed.
