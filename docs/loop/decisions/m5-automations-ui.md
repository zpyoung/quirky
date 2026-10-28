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

## Progress
Step3 design selected; current branch build/m5-automations-ui. Core already landed. Read-only contract survey running. Next: finalize combined logic spec and committed shared UI/external contracts, then dispatch three isolated implementers. No implementation or verification claimed yet.
