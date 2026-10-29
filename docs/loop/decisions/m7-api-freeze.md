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

## Progress
Specs committed at c0a9b7bd; actual Codex bounded review found F1 (accepted, amended both specs). Shared public signatures and comparator being committed before dispatch. Next: disjoint runtime, distributed-fixture and executing-host/example slices, parent-only verification and final Gemini review. Scratch `/tmp/quirky-m7-api-freeze-lane12.AAiuFD`. Canonical queue deps retry running with3600s deadline. No human asks. Only this item may be completed this iteration.
