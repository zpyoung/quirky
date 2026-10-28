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

## Progress
Scope/spec and shared contracts established. Commit contracts, create3isolated components, snapshot/audit before and after; workers implement without checks/commits, then parent runs owned checks, real UI/API/CLI and affected suite. Dependency source is still in progress; merge repairs and wait canonical deps before catch-up/land. No completion, acceptance or review pass claimed yet.
