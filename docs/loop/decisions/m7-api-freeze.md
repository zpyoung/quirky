# m7-api-freeze decisions

## D1: Use autonomous API/Integration/Docs design
- **Question:** Which workflow, research and approval steps apply unattended?
- **Options:** human prompts and external swarms; repository-first design with autonomous answers
- **Chose:** repository-first API/Integration/Docs design, standard gray areas, markdown logic and tech specs, no visual/adhd offers or human asks
- **Why:** LOOP.md supplies authoritative inputs and unattended defaults. The item has no feature-doc assignment and concerns public contracts/distribution rather than a visual redesign.
- **Evidence:** docs/roadmap.md:259-266; authoritative LOOP.md read with git show build/roadmap:docs/loop/LOOP.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a feature requirement not represented by the roadmap is discovered
- **Source:** locked by docs/loop/LOOP.md

## D2: Require canonical stable SemVer apiVersion declarations
- **Question:** Versioning gray area: field name, shape and meaning?
- **Options:** integer major; exact host version; stable three-component API floor; arbitrary SemVer range
- **Chose:** required `apiVersion: "1.0.0"`, minimum stable major.minor.patch release, nonnegative safe integer components without leading zeroes or suffixes
- **Why:** m0-registry D15 reserved apiVersion for M7 and a version-floor rationale. A single floor avoids range parsing and makes required capabilities explicit.
- **Evidence:** docs/loop/decisions/m0-registry.md:154-162; docs/roadmap.md:262
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a concrete plugin needs prerelease-target negotiation
- **Source:** supersedes m0-registry D15

## D3: Keep same-major older API floors compatible
- **Question:** Versioning gray area: compatible updates, newer targets and other majors?
- **Options:** exact equality forever; same-major minimum no newer than host; accept unknown future versions
- **Chose:** equal major, numeric target minor/patch no newer than host
- **Why:** compatible releases should not force manifest rewrites; future requirements and breaking majors must be rejected before execution.
- **Evidence:** docs/quirk/specs/2026-10-28-m7-api-freeze/logic.md#key-decisions--rationale
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** API 2 is designed to host multiple major contracts
- **Source:** assumed — autonomous

## D4: No implicit upgrade for missing declarations
- **Question:** Error-recovery gray area: old unstable installed/built-in manifests, missing field and author migration?
- **Options:** implicit 1.0.0; warning only; reject missing field and migrate repository manifests
- **Chose:** reject as invalid, explicit author migration, all distributed built-ins/examples/fixtures migrated
- **Why:** silently blessing unstable code would claim compatibility without evidence; clean cutover is safer.
- **Evidence:** packages/daemon/src/plugins/manifest.ts:238-282; docs/roadmap.md:29-30
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an explicitly supported pre-1.0 upgrade policy is required
- **Source:** assumed — autonomous

## D5: Preserve strict manifest fields and existing error transport
- **Question:** Error-responses gray area: malformed/future/missing versions, aggregated errors and unknown fields?
- **Options:** new error enum and transport; existing diagnostics/InvalidParams; lenient unknown fields
- **Chose:** field-specific errors in existing aggregate manifest diagnostics; InvalidParams for inspect/install, invalid registry entry for discovery, retain strict unknown fields
- **Why:** every existing path already uses the same parser; no parallel loader or new error vocabulary is needed. Unknown fields remain useful typo detection; future fields require a newer floor.
- **Evidence:** docs/loop/decisions/m0-registry.md D13-D14; packages/daemon/src/plugins/install.ts:46-66
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a future compatible manifest extension cannot be represented without unknown-field tolerance
- **Source:** locked by docs/loop/decisions/m0-registry.md

## D6: Validate bundled plugins before any distro mutation
- **Question:** Integration/conflict gray area: one incompatible plugin among a distro pack, activation side effects and rollback?
- **Options:** partially install compatible plugins; refuse the whole pack in existing preflight
- **Chose:** refuse before import/copy/distro changes; keep installed pack and user layers unchanged
- **Why:** distros already preflight every bundled plugin; partial application would break existing atomic semantics.
- **Evidence:** packages/daemon/src/plugins/distros.ts; docs/loop/decisions/m0-core.md D26-D28
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** partial distro installation becomes an explicit product requirement
- **Source:** locked by docs/loop/decisions/m0-core.md

## D7: Expose the host release in the existing API catalog
- **Question:** Response-format gray area: how does an author/client discover the running plugin API version, and does it require activation?
- **Options:** compile-time constant only; new RPC; additive pluginApiVersion on api.describe and CLI api --json
- **Chose:** exported PLUGIN_API_VERSION and additive catalog pluginApiVersion, no activation
- **Why:** the catalog is already the public introspection surface; a separate RPC adds no value.
- **Evidence:** packages/protocol/src/catalog.ts:51-59; docs/roadmap.md:70-75
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** version discovery is needed before the existing wire handshake
- **Source:** assumed — autonomous

## D8: Keep all version domains distinct
- **Question:** Versioning gray area: wire handshake, catalog schema, app release and plugin package version?
- **Options:** bump all to 1.0; bump wire/catalog on any addition; independent plugin API constant
- **Chose:** independent API 1.0.0; wire 2 and catalog schema 2 unchanged; app/plugin/package releases unchanged
- **Why:** only plugin manifest/API stability changes; the additive catalog field is not a breaking shape change. Plugin package release is not a host capability floor.
- **Evidence:** packages/protocol/src/rpc.ts PROTOCOL_VERSION; packages/protocol/src/catalog.ts CATALOG_SCHEMA_VERSION
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a breaking wire/catalog change is actually introduced
- **Source:** assumed — autonomous

## D9: Publish the existing sample in repository source
- **Question:** Documentation/distribution gray area: example identity, destination, install/revert workflow and update policy?
- **Options:** external registry/network release; a second demo pack; document and ship existing distros/sample
- **Chose:** retain sample.sidebar override and quirky.git disable, add author/readme instructions, migrate API declaration, exercise stock CLI installation and removal
- **Why:** m0-core D30 already chose repository publication and the exact exit scenario. No registry destination or remote push is authorized. Reusing it avoids competing examples.
- **Evidence:** docs/loop/decisions/m0-core.md:299-307; distros/sample/quirky-distro.json; packages/ui/test/exit.e2e.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the project introduces an explicit release registry or downloadable artifact channel
- **Source:** locked by docs/loop/decisions/m0-core.md

## D10: Freeze author-facing declarations, not kernel internals or renderer DOM
- **Question:** Docs/versioning gray area: what is stable, where is the reference, and what changes require a bump?
- **Options:** freeze all implementation details; new API package; document current exported author contracts and policies
- **Chose:** public reference for PluginManifest, daemon/UI/CLI module/context contracts, contribution/schema/lifecycle rules and transitive public types; additive API minor, behavior-preserving fix patch, removals/type/behavior incompatibilities major. Existing .ts declarations remain authoritative detail; deep kernel/renderer internals and DOM structure are not author API.
- **Why:** built-ins and third parties already share @quirky/protocol; a new package or re-export layer adds migration without capability.
- **Evidence:** packages/protocol/src/index.ts; packages/protocol/src/{plugins,ui,cli}.ts; docs/roadmap.md:67-69
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a real stable plugin needs an undeclared/private interface
- **Source:** locked by docs/roadmap.md

## D11: Preserve trust, confirmation, authentication and activation semantics
- **Question:** Authentication/integration gray area: does API stability add sandboxing, auto-update, retries, auth changes or eager activation?
- **Options:** redesign lifecycle/security; leave existing contracts intact
- **Chose:** no changes; full trust, existing caller authority and confirmations, safe mode, lazy loading and explicit reinstall remain binding
- **Why:** the item freezes the established surface rather than replacing its security/lifecycle model.
- **Evidence:** docs/architecture.md:312-324; docs/loop/decisions/m0-core.md D27-D29
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a separate roadmap item changes these locked choices
- **Source:** locked by docs/architecture.md

## D12: Verify end-phase code and use a reachable cross-family reviewer
- **Question:** Execution preflight: implementer/reviewer pairing, checks and inherited untracked state?
- **Options:** unreachable Opus; same-family reviewer; reachable Gemini fallback; remove unrelated .serena
- **Chose:** omp task implementers (OpenAI); final reviewer gemini (Google) after Opus/Sonnet unavailable. Specs use requested Codex (same-family, disclosed). Preserve unrelated untracked .serena/. Run end-phase targeted tests, scripts, whole suite/typecheck, CLI runtime smoke and existing sample UI coverage; no native changes.
- **Why:** pi-watch --check reported Opus 0/8, Sonnet 0/6, Gemini google/gemini-3.1-pro-preview:high reachable. LOOP mandates end-phase verification and no human prompts.
- **Evidence:** preflight output this run; packages/ui/test/exit.e2e.test.ts; authoritative LOOP.md end phase and step 6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reviewer dispatch fails or a public contract requires another verification path
- **Source:** assumed — autonomous

## D13: Claim only macOS evidence
- **Question:** Platform readiness and documentation examples?
- **Options:** claim portable verification; run macOS and record other native platforms unverified
- **Chose:** macOS build/runtime checks only; Linux/Windows install/native lifecycle validation remains required before claiming platform support
- **Why:** locked platform policy limits this build environment; this item adds no new platform-specific implementation.
- **Evidence:** authoritative LOOP.md Platforms; docs/architecture.md:294-297
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux or Windows support is validated on those platforms
- **Source:** deferred: platform

## D14: Gate each executing host before module import
- **Question:** Spec review F1: a newer daemon could accept a floor the connected local CLI/UI does not implement.
- **Options:** require every client release to match the daemon; gate each module using its declaring plugin's floor
- **Chose:** propagate apiVersion through PluginInfo, CLI command entries and UI module metadata; shared compatibility helper checks the local host release before dynamic import; reject missing metadata, isolate failure
- **Why:** independent CLI/UI contexts execute code locally, so the daemon parser cannot attest their compatibility. Per-module floors preserve compatible code across skew without unnecessarily blocking generic RPC clients.
- **Evidence:** actual Codex spec review STATUS NEEDS_FIXES; packages/cli/src/plugin-commands.ts:74-89; packages/ui/src/plugins/host.ts:ensure/importAndActivate
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** module execution moves to another host or version domain
- **Source:** assumed — autonomous

## D15: Build the early freeze item against the pending owner's shared contract
- **Question:** queue deps reports m7-session-extras-owner-host-flows pending while this early item is already claimed.
- **Options:** end the turn; build without its branch; merge its available shared contracts and wait for ready before landing
- **Chose:** read its D1-D4 and merge build/m7-session-extras-owner-host-flows (944d7da5) into this branch; it adds specs and public runtime-owner reference types. Repeat canonical deps in this same turn until ready.
- **Why:** authoritative LOOP's early-item rule forbids ending while a dependency is merely still building. Owner-host decisions preserve the existing API and don't conflict with versioning; its future fixture declarations will be reconciled at final catch-up.
- **Evidence:** actual canonical deps ready:false pending:[m7-session-extras-owner-host-flows]; git merge output4files189insertions; incoming decision log D1-D4
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the pending dependency becomes blocked or changes a frozen public contract
- **Source:** locked by docs/loop/LOOP.md

## D16: Preserve orphaned-load teardown while revalidating present metadata
- **Question:** The composed gate found three existing UI lifecycle tests timing out after the new post-import declaration check.
- **Options:** weaken lifecycle tests/timeouts; reject every disappeared declaration after import; retain pre-import gate and recheck present metadata while allowing the existing orphan cleanup transition
- **Chose:** the last option. An import begun under valid metadata may finish when its contribution departs, then follows the existing activate/deactivate cleanup and teardown-wait path; changed or incompatible present metadata still rejects.
- **Why:** treating departure as an import error revoked the pending session before a disposer could run, breaking re-enable and command serialization. Canonical focused rerun passed both daemon API-version and all UI host-unit tests after the fix.
- **Evidence:** initial canonical60-file result58passed2failed; UI lifecycle failures at test lines1110/1146/1192; focused2-file suite ok:true flaky:[] in12.83s including UI rebuild
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an in-flight code replacement bypasses the present-metadata floor check
- **Source:** assumed — autonomous

## D17: Keep compatibility refusal distinct from a different-distro conflict
- **Question:** The new atomicity test installed stable then attempted a differently named future distro and received Conflict before parsing.
- **Options:** change production precedence; weaken expected error; exercise an upgrade of the same installed pack/plugin with an incompatible floor
- **Chose:** replace stable/acme.stable with a candidate of the same identities targeting1.1.0; preserve InvalidParams and all before/after state assertions
- **Why:** the existing one-distro rule is correct. The test must reach API preflight rather than assert a new precedence not requested.
- **Evidence:** initial failure expected-32602 got-32009 at api-version.test.ts239; DistroService.prepare; focused2-file rerun passed
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** distro replacement semantics are explicitly changed
- **Source:** locked by docs/loop/decisions/m0-core.md

## D18: Disable all independent Source Control launch affordances in the sample
- **Question:** Actual web use showed the Git panel and CLI group absent but the sidebar-extras activity button, then the editor-owned palette command, still present.
- **Options:** renderer special cases; disable all sidebar extras/editor; disable just the stable activity/command/keybinding IDs in the pack
- **Chose:** add activity-item:quirky.sidebar-extras/source-control, command:quirky.editor/source-control and keybinding:quirky.editor/source-control alongside quirky.git; removal restores them
- **Why:** later plugins own these affordances independently. The distro's stable-ID mechanism turns Source Control off without disabling unrelated editor/filter capabilities.
- **Evidence:** failed web runs20261029T042251-1b31 and20261029T042517-8509; both added CLI/UI transition assertions failed before their pack edits. Canonical final60-file acceptance set passed60/60 flaky:[] in48.04s. Final web run20261029T042933-ea2d:2/2pass, findings[]/overrides[]/kept_open[]; stock-restoration run20261029T043308-37f7:1/1pass, same clean report fields. Report paths are .quirk/using-apps-like-a-user/runs/<run-id>/report.json and screenshots alongside.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** one of these stable owner/IDs changes in a major API release
- **Source:** assumed — autonomous

## D19: Restore worker contamination before the integration barrier
- **Question:** A worker accidentally applied relative file edits to the parent worktree.
- **Options:** accept unattributed edits; restore only its attributable test changes and reapply them under absolute owned paths
- **Chose:** the latter; all later tools used absolute worker paths. Parent barrier verified only its own decision-log edit and inherited .serena remained dirty; three component HEADs stayed a961bb62 and write scopes passed.
- **Why:** branch isolation is an integrity boundary; reports alone do not substitute for the source audit.
- **Evidence:** worker correction messages; actual parent/worker status at barrier; JS scope audit24/78/18files; semantic audit63JSONs only apiVersion added
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a worker tool again resolves a relative path outside its assigned worktree
- **Source:** assumed — autonomous

## D20: Close fixture dependency sets over the real Worktree requirements
- **Question:** Full-suite Checks owner and automation provenance tests saw invalid dependent plugins or a missing Worktree setting.
- **Options:** relax production manifest/dependency validation; add the missing real prerequisite to the fixture
- **Chose:** link quirky.cli in the two Checks owner stacks and automation provenance stack
- **Why:** quirky.worktree declares quirky.repo and quirky.cli; an incomplete test stack invalidated Worktree, then Checks and owner plugins. These source manifests already target API1.0.0, so an API fallback would hide the actual problem.
- **Evidence:** full suite17macOSpassed plus remote869/874passed, five failing files; real Worktree manifest dependencies13–15; corrected focused five-file suite5/5passed flaky:[]
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** fixture stacks omit another declared runtime prerequisite
- **Source:** assumed — autonomous

## D21: Preserve real origin/upstream hydration while removing duplicate request-shape checks
- **Question:** The Tasks navigation test exceeded its default5-second bound while repeatedly refreshing the same upstream detail and inspecting provider query shapes.
- **Options:** drop hydration and assert forwarded tuples only; keep duplicate provider internals; retain one real hydration per distinct source with a bounded integration deadline
- **Chose:** seed distinct origin/upstream PRs sharing a number, verify both sources across all three tabs, hydrate each source once and assert actual review URL/prRepo. Remove provider query-shape/count assertions; use the existing20-second review integration bound.
- **Why:** correct forwarded state with data fetched from the wrong repo is a real consumer bug, so hydration cannot be discarded. Repeating the same full refresh per tab and pinning transport queries adds no separate invariant.
- **Evidence:** initial full-suite timeout/cleanup ConnectionLost; parent rejected the narrower worker draft; focused five-file suite5/5passed with actual two-source hydration retained
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a tab has its own distinct source-selection contract not covered by the shared detail hydration
- **Source:** assumed — autonomous

## D22: Synchronize independent activity and panel snapshots before the Git commit transition
- **Question:** Git layout tests depended on the old badge DOM, then committed before GitPanel had left its initial clean snapshot.
- **Options:** repin obsolete tooltip/DOM assumptions or increase timeouts; observe semantic activity count and establish positive panel readiness
- **Chose:** assert the accessible Source Control activity's visible count4, capped1000+, and clean status; wait for the initial unstaged math.ts row before staging, invoke the actual primary Commit action, verify HEAD changed and Git status is clean, then observe count removal. Delete obsolete world.badge.
- **Why:** the independent activity could show4 before GitPanel rendered any dirty row, so a negative absence wait passed vacuously. The observed disabled primary title Nothing to commit proved the missing readiness edge; no timeout or production Git change was needed.
- **Evidence:** full-suite badge failures; two focused attempts exposed the unperformed commit and disabled clean snapshot; final focused five-file suite5/5passed flaky:[]; LSP unavailable and literal references showed no badge-helper callers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another asynchronous producer is mistaken for readiness of the control under test
- **Source:** assumed — autonomous

## D23: Keep the original standalone Automations predecessor across a settings detour
- **Question:** open/settings/open/close restored the settings page instead of the view preceding Automations.
- **Options:** weaken the expected predecessor; select Automations above Settings; close Settings to reuse the existing Automations tab
- **Chose:** close the settings detour when the standalone Automations tab already exists; preserve the tool-visible path and retained navigation mutation
- **Why:** inserting/selecting a new center target left Settings underneath it. The existing-tab return restores the original predecessor on the next Close, without replacing filters/drafts.
- **Evidence:** full-suite ui-state failure; corrected ui-state assertions and focused five-file pass; fresh-home actual daemon/CLI open/uiNavigate/settings/open/close smoke2.83s, before:null/after:null plus retained query/page/status/runStatus assertions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** standalone and tool navigation acquire a different explicit history policy
- **Source:** locked by plugins/quirky.automations/README.md

## Progress
All feature slices and sample fixes are committed through5bea0e52. Comparator36pass; original focused acceptance60/60passed. First full suite failed:17/17macOSpassed, remote869/874passed; five actual failures repaired as D20–D23. Final focused five-file gate5/5passed flaky:[], full typecheck passed, scripts126tests/12filespassed/0fail (132.04s combined; nested negative-fixture output is expected, root verdict green). Fresh-home actual automation CLI smoke2.83s also passed. Earlier real API/CLI/PTY/sample web proof remains valid as D18 records; all owned runtime/browser resources stopped. Commit this repaired batch, then await pending early dependency (current canonical deps retrybg_32), perform the sole roadmap catch-up and consume incoming decisions, run final deterministic build/fullsuite/scripts/typecheck prepass and actual bounded Gemini review, remediate accepted findings once and land. Final-prepass.ts is prepared outside repo in `/tmp/quirky-m7-api-freeze-lane12.AAiuFD`; it has not run. Do not end while dependency merely pending; no human asks.
