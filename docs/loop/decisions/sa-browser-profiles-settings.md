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

## Progress
2026-10-28: claimed early item, merged lane4 contract commit2ab093ce; read source browser.md section2/Settings, roadmap/architecture and prior Browser decisions. Spec self-reviewed; shared preferences contracts ready. Next commit contracts, dispatch3 disjoint implementers; integrate lane4 latest before checks; exact missing-flow queue entries; UI smoke/review/remote checks; deps ready; roadmap catchup and land. No implementation is verified yet.
