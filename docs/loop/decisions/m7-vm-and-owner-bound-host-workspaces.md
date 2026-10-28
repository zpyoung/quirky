# m7-vm-and-owner-bound-host-workspaces decisions

## D1: Preserve genuine VM and owner boundaries
- **Question:** Which inherited purpose, consumers, success criteria and exclusions govern autonomous brainstorming?
- **Options:** Treat remote results as mirrors; use local shell tabs as VMs; build actual lifecycle and authenticated owner bindings.
- **Chose:** Combined spec scenarios 1–7, real Lima backend, separate registered remote mirrors, same-connection authenticated host-generation and workspace-instance fencing.
- **Why:** Predecessor D4/D15 expressly retains these unbuilt flows; missing installed executables alone is not source infeasibility. Remote source paths and UI UUIDs are not host identity.
- **Evidence:** predecessor decisions D2,D4,D6,D7,D15; worktrees.md hooks/host duplicates; cli.md Hosts and servers; scout MapVmOwnerContracts.
- **Reversibility:** medium
- **Confidence:** high for required boundary
- **Revisit if:** Source integration cannot preserve exact guest/owner execution authority.
- **Source:** locked by docs/roadmap.md and predecessor decisions

## D2: Select API, identity, trust and lifecycle gray-area defaults autonomously
- **Question:** How do API/authentication, CLI/output, identity mapping, sync/conflict, errors and VM attachment gray areas resolve?
- **Options:** Duplicate crypto/transport; infer labels/local paths; reuse existing owner transport with explicit identity and conservative failure.
- **Chose:** Existing owner-cli saved grants; remotely generated durable host UUID plus fresh activation generation; owner-qualified mirror records; fresh instance/fingerprint evidence for mutations; explicit confirmations; no destructive replay. Full recipe hash trust, verified Lima backend and guest owner attachment, durable failed/interrupted operations, no fallback to local worktree execution. Existing generated plugin CLI and structured errors.
- **Why:** These defaults preserve actual observable owner authority and make unknown/offline distinct from safe/inactive. Recipe source is trusted executable provisioning configuration, not a terminal template.
- **Evidence:** combined logic spec Decisions locked and scenarios 1–6; protocol runtime-owner.ts; CLI main.ts55–108; worktree create.ts265–287.
- **Reversibility:** hard
- **Confidence:** medium pending implementation and bounded smoke
- **Revisit if:** Real backend output or existing public API cannot express a required attachment safely.
- **Source:** assumed — autonomous

## D3: Apply autonomous contract-first build-first execution
- **Question:** Which skill gates, implementation pairing and review/testing policy apply unattended?
- **Options:** Human prompts/swarms/reviews/suites; skip source evidence; contract-first isolated omp components with narrow parent verification.
- **Chose:** Combined self-reviewed markdown spec and shared protocol committed first. Three isolated omp task implementers at most, AUTHOR_FAMILY=openai; Opus is eventual review preference but no formal review or availability claim under build-first. Parent owns integration hubs and migrations; no overlapping component scope. Workers skip all builds/tests/lint/formatters. Parent runs required changed-path smoke and root typecheck, catches up once before landing. No separate tech.md, asks, research swarm, dogfood campaign or suite.
- **Why:** Canonical LOOP overrides skill human/test/review gates. Developer requires significant changed-path runtime evidence. LSP reports no configured servers.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; xd://lsp status; combined spec Technical decisions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** End phase begins or authoritative LOOP changes.
- **Source:** locked by docs/loop/LOOP.md

## D4: Keep platform and native prerequisites separate from reachable source
- **Question:** Do absent VM binaries, notification callbacks or production signing justify claiming success or blocking all source work?
- **Options:** Fabricate lifecycle/delivery; block all source; implement core while preserving exact external prerequisites.
- **Chose:** Lima is an explicit external dependency with doctor/preflight; source implementation proceeds. No native notification permission/click/dismiss or signed terminal-host launchd/TCC/admission/upgrade claim without supported SDK and authorized packaging identity. Linux/Windows host work unclaimed. Existing automation/browser owners remain canonical.
- **Why:** Prior actual inventory reports absent callbacks and zero valid signing identities; these are independent of reachable VM/host source engineering. No new credential was supplied and those observations are not rerun.
- **Evidence:** predecessor D6,D15; m7-terminal-provider-host-and-worktree-remainder D6,D8; packages/protocol/src/desktop-capabilities.ts.
- **Reversibility:** medium
- **Confidence:** high for inherited prerequisites
- **Revisit if:** Supported callbacks, authorized signing identity or platform scope changes.
- **Source:** deferred: platform

## D5: Integrate actual visible owners and the canonical instance fence
- **Question:** Which parent-owned consumer changes are necessary once the disjoint contracts exist?
- **Options:** Leave UI refusal text/local navigation; make remote paths local; expose separate owner-qualified navigation and recipe lifecycle controls.
- **Chose:** Remote sidebar plus remote-specific workspace view; dedicated VM lifecycle view linked from CreateDialog rather than silently ignoring its ordinary name/base/agent fields for provisioned-root. VM receipts navigate through remoteNavigate, never local navigate. Canonical cleanup propagates an optional caller instance fence, or its fresh snapshot instance, into canonical removal. Existing callers remain consistent with the additive field.
- **Why:** A CLI-only mirror and stale owner-unavailable text would leave the visible flow unbuilt. A fresh cleanup fingerprint must not lose the exact instance before filesystem deletion. Copy-only CLI forwarding tests and obsolete owner-unavailable wording assertions are deleted rather than re-pinned.
- **Evidence:** CreateDialog.tsx902–906; actions.ts196–215; controls.ts694–738; control-types.ts96; creation-parity.test.ts; grep inventory of all CleanupSelection consumers.
- **Reversibility:** medium
- **Confidence:** high for integration contract, runtime smoke pending
- **Revisit if:** Actual API/UI execution identifies a producer/consumer mismatch.
- **Source:** assumed — autonomous

## D6: Keep backend lifecycle and schema evidence literal
- **Question:** How should Lima suspend semantics, long provisioning and declaration constraints be represented?
- **Options:** Invent unsupported commands/schema keywords; report stopped as RAM-preserving pause; expose literal backend state and supported contracts.
- **Chose:** Configurable recipe suspend/resume commands with actual Lima state; no RAM-preserving suspension claim. Synchronous provisioning persists a discoverable creating record/operation before work; caller timeout is ambiguous and must be inspected with vm-list, never replayed as a new create. Lifecycle verifies backend-instance evidence beyond a name. Inline public schemas use only schema.ts's supported subset; runtime guards enforce nullable/length/recipe constraints it cannot express. remoteCall is not kernel-destructive merely because its whitelist includes ordinary terminal input; actual source removal/destroy/forget retain explicit confirmation.
- **Why:** Lima's public command reference offers start/stop/delete/snapshot, not a suspend command. Existing JSON Schema subset has no refs, unions, const or maxLength. Credential-bearing script output must remain private and cannot be copied into public errors.
- **Evidence:** https://lima-vm.io/docs/reference/limactl/ and /docs/reference/limactl_list/; packages/protocol/src/schema.ts4–31; worker contract messages and outside-repo integration schemas.
- **Reversibility:** medium
- **Confidence:** high for observed docs/contracts; real VM lifecycle not yet exercised
- **Revisit if:** Installed backend supports an additional literal state or canonical API supports a stronger declaration.
- **Source:** assumed — autonomous

## D7: Fence saved grants before dispatch and forward already-given consent
- **Question:** Can checking the returned runtime pin after an operation prevent same-host saved-grant rebinding or duplicate remote confirmation?
- **Options:** Compare only response metadata; broaden owner credentials; enforce an exact saved pin before connection and carry explicit prior consent downstream.
- **Chose:** Add expectedRuntime `{id,endpoint,grantId}` to runtimeCall, compare against resolved saved owner target before any network operation, and pass it on every registered-host call. Keep expectedHost verification on the same authenticated RPC. Confirmed remote remove/cleanup forward `yes:true` only after outer confirmation and confirmed:true validation.
- **Why:** A changed grant on the same host generation could execute before the old post-result comparison. A second cross-runtime destructive call otherwise opens a hidden ask after the consumer already confirmed. Neither risk is solved by broader phone/federation grants or a local fallback.
- **Evidence:** returned remote.ts271–310 and844–905 integration audit; CLI pre-dispatch contract; protocol runtime-owner.ts. Authored regressions remain unexecuted under build-first.
- **Reversibility:** medium
- **Confidence:** high for the observed ordering/confirmation defects; runtime proof pending
- **Revisit if:** Real owner API smoke identifies another unfenced credential transition.
- **Source:** assumed — autonomous

## D8: Repair compiler and declaration defects at their actual boundaries
- **Question:** Which integration failures did the fresh compiler and structural parser establish?
- **Options:** Cast away object errors or relax declarations; repair conversion semantics and real registrations.
- **Chose:** Shared nullable recordOf conversion uses the existing object guard; direct service/UI response initializers no longer store boolean guard results. Remove impossible setup:run branches after preflight already rejects run; make the VM catch's never-return explicit. Remove the actual CLI JSON trailing comma and register the existing ownedIds function. Worker-local runtime pin types and the duplicate VM object guard are removed in favor of shared contracts. Keep existing worktree README as the product documentation rather than add another CLI README.
- **Why:** Initial typecheck reported 95 diagnostics in four files, mainly real boolean/object confusion, not missing-setting symptoms. Actual parseManifest rejected CLI JSON and computeRegistry disabled its dependent worktree plugin. Structural source matching found ownedIds declared but not registered.
- **Evidence:** first typecheck exit2/25.14s and artifact32; parser report; corrected UIlint/root/mobile/prepared-desktop typecheck exit0/32.89s. Actual parseManifest and computeRegistry then enabled CLI/worktree/repo with zero diagnostics and all15/67 method registrations matched.
- **Reversibility:** easy
- **Confidence:** high for observed compiler/declaration evidence; runtime scenario continues separately
- **Revisit if:** Fresh runtime/API evidence identifies another contract mismatch.
- **Source:** assumed — autonomous

## D9: Move all executable test verification to the remote runner
- **Question:** How does the operator's overloaded-Mac instruction change verification placement?
- **Options:** Keep local daemon/test smoke; skip runtime evidence; run the actual API scenario remotely and tunnel its production component surface.
- **Chose:** Every test, including the throwaway real-daemon scenario, runs through bun scripts/suite.ts on the configured 16-slot Linux test host. A temporary bun wrapper refuses any local-test fallback; no macOS exception is added. Browser inspection will use an owned SSH tunnel to the remote scenario and close afterward. Product Lima platform support remains macOS-only; Linux doctor refusal is not VM acceptance.
- **Why:** Operator explicitly forbids local tests except the existing allowlist and packaged native checks. Static typecheck/build remains local. The first remote scenario failed at ownerPair before any feature mutation because it pinned the listener to loopback but omitted its advertised address, which selected a network interface and triggered the real widening refusal. Supply the intended explicit loopback address in the private fixture; do not weaken product exposure policy.
- **Evidence:** operator interjection; scripts/suite.ts8–19,299–372; remote config16 slots; first remote file failed twice with listener widening refusal and both cleanup receipts; service.ts195–219 proves the default-address/exposure path.
- **Reversibility:** easy
- **Confidence:** high for routing and diagnosed fixture mismatch
- **Revisit if:** Operator changes runner placement or the configured remote host becomes unavailable.
- **Source:** locked by operator instruction; assumed — autonomous for isolated surface transport

## D10: Give activation cleanup an actual per-instance owner
- **Question:** Why did restarting the remote daemon make the still-running local VM service report deactivating?
- **Options:** Avoid the failure by changing the fixture topology; share another cleanup map; give every plugin activation its own returned cleanup closure.
- **Chose:** Public PluginModule.activate may return PluginActivationDisposer. PluginHost owns it on that exact attempt and invokes it once before extension revocation, including late activation disposal. Worktree variables and cleanup move into activate's closure; obsolete module-global worktree deactivate is removed. Existing plugins' static deactivate hooks remain their normal supported lifecycle.
- **Why:** Both daemon fixtures import the same built-in module URL in one Bun process. A single releaseVm global was overwritten by the other activation, so remote shutdown stopped the local VM service. The actual API smoke reproduced it twice after all owner/removal/diff/window assertions, rather than merely exposing a compiler issue. Changing the fixture would hide source ownership.
- **Evidence:** remote smoke bg8: VM service is deactivating from trackServiceOperation after remote restart; worktree/main.ts102–129 globals; PluginHost loadAndActivate494 and callDeactivate723 ignored activation return values.
- **Reversibility:** medium
- **Confidence:** high for observed root cause; scoped-disposal regression and rerun pending
- **Revisit if:** Real multi-host teardown still crosses an activation boundary.
- **Source:** assumed — autonomous

## Progress
Claimed lane6 on build/m7-vm-and-owner-bound-host-workspaces from build/roadmap. Requirements, locked roadmap/architecture and predecessor decisions read; source scout returned. Combined logic/technical spec self-reviewed, shared OwnerHostIdentity/RegisteredOwnerHost and expectedHost forwarding contract prepared. Next: commit contracts/spec and dispatch disjoint CLI-owner, remote-workspace and VM components, integrate their hubs, then narrow isolated runtime smoke/typecheck, single roadmap catch-up, record disposition and canonical land.
