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

## D11: Treat the real remote API and mounted UI scenario as bounded evidence
- **Question:** What did the actual isolated runtime and browser exercise, and what remains unproved?
- **Options:** Infer acceptance from types; substitute mock data; run real private owners and distinguish hardware/native limits.
- **Chose:** Two real remote daemon kernels, actual Git worktrees and E2EE owner calls passed host issuance, pre-dispatch host/grant refusals, durable registration/generation restart fencing, remote-only projection, current/stale removal without another ask, actual Git diff, foreign-session refusal, exact-window isolation, recipe hash refusal with no provisioning record, and real remote-list/vm-doctor CLI commands. Mounted production RemoteWorkspace/sidebar/VM components showed the actual diff; live sidebar navigation worked; Create VM stayed disabled before full-lifecycle consent and enabled after it; the unsupported Linux host produced a visible durable failed record instead of a fake VM.
- **Why:** This proves actual changed interfaces, not only fixture copies. The unrelated PTY/session seam does not prove a real terminal, live Lima guest, native shell or full inventory/visual score. A temporary host-layout overlap was corrected only in the controlled embedding, and normal busy-state waits replaced premature clicks; production layout was not patched to force a pass.
- **Evidence:** final remote smoke exit0/276.33s, one file passed/flaky[]; actual readiness receipt artifact48; two saved screenshots and empty browser errors; canonical APIs and real Git source assertions in preserved executed smoke source.
- **Reversibility:** easy
- **Confidence:** high for exercised paths and explicit limits
- **Revisit if:** Native/full-shell/live-VM execution establishes a different owner or renderer lifetime.
- **Source:** assumed — autonomous

## D12: Preserve every incoming authority through the sole roadmap catch-up
- **Question:** Which concurrently landed decisions bind final integration and visible reachability?
- **Options:** Restore old shell assumptions; merge repeatedly; consume incoming decisions and preserve their owners.
- **Chose:** One clean merge after f27a1d09. Read all 18 pinned incoming logs at a47845a9 plus the two newer ui-restyle-editor/terminal logs in full, including long Progress footers. Preserve exact-window and active-view input identity, six-slot canonical tools, filtered one-use Ask snapshot, private saved-target storage, mobile grants, clipboard authority and explicit native/GPU/browser limitations. The generic remaining-contribution projection makes remote-workspaces a right-bottom stripe tool, unopened by default; no WorktreesSection insertion or old sidebar pile is needed.
- **Why:** Incoming triage owns the broader failure inventory and was not suite-green. It does not authorize credential widening or pretend native acceptance. Actual source projection retains all effective sidebar contributions, so duplicating this panel would violate the landed shell model.
- **Evidence:** all20 decision receipts; packages/daemon/src/plugins/ui-model.ts390–412 and tool-layout.ts101–139,176–183; ToolShell.tsx stripe/PluginSlot paths; clean merge output; caught-up full typecheck exit0/35.39s.
- **Reversibility:** medium
- **Confidence:** high for read source/log contracts
- **Revisit if:** Canonical land reports a concrete new conflict or registry failure.
- **Source:** locked by incoming decision logs

## D13: Fix real lifetime/retirement defects without weakening admission
- **Question:** What did the caught-up regressions and genuine stopped-guest semantics require?
- **Options:** Relax confirmation/permissions; fabricate offline refresh; repair ownership and realistic fixtures.
- **Chose:** Mobile listener/tabs/notifications now return their own activation disposer instead of sharing module globals. Restart fixtures preserve the paired listener port and use loopback offers; destructive tests supply kernel consent while preserving handler confirmed checks. Real editor/sidebar evidence producers replace missing cleanup context; public remove/re-add of the saved name replaces encrypted-file editing; non-destructive session close does not accept yes. The confirmation descriptor accepts canonical remove's instance/safe-only fields. Folder views do not request inapplicable Git status. Stopped VM attachment reads HostStatus plus retained remoteList, never a live remoteRefresh. Host retirement compares generation/grant pins atomically with deletion and reconciles verified local absence without detaching replacements.
- **Why:** The initial seven-file run had five passing files and two failing owner files. Those failures exposed Mobile's same module-global teardown issue and stale fixture contracts; broader package execution later exposed only a misplaced yes on the new folder fixture plus four independently owned Mobile files. A powered-off guest cannot answer a live refresh, and deleting a re-registered host by ID alone could remove another generation's mirrors.
- **Evidence:** remote artifacts65/68; Mobile main activation globals; vm.ts stopped mirror/remoteRetire; remoteHostForget transaction; final canonical remote19/19 files pass, zero failures/flaky[], exit0/29.67s. Final UIlint/root/mobile/prepared-desktop typecheck passed44.74s; packaged build passed18.44s with30plugins.
- **Reversibility:** medium
- **Confidence:** high for executed owner/kernel/process/script paths; real VM lifecycle remains unexercised
- **Revisit if:** Genuine Lima or full/native surface acceptance identifies a remaining boundary mismatch.
- **Source:** assumed — autonomous; locked by incoming CLI/admission contracts

## D14: Register one exact native capability implementation successor
- **Question:** Which inherited source flows remain unavailable after the core owner/VM implementation?
- **Options:** Invent callbacks/ad-hoc production identity; duplicate VM/Browser/automation work; retain exact prerequisites in one successor.
- **Chose:** Canonical queue add registered m7-native-notification-and-signed-terminal-host, todo, depending on this item. Its only flows are native notification permission/click/dismiss after supported public SDK callbacks, and production terminal-host signing/launchd/TCC/admission/upgrade after authorized signing/packaging identity. No VM/host implementation successor or test/review/debug follow-up was added. Four broader Mobile test files remain with existing fix-test-mobile-1028 and are appended as concrete evidence in BLOCKERS.
- **Why:** Native delivery/signing cannot be fabricated from an unacknowledged SDK call or ad-hoc identity. The reachable source is complete independently; outside capability gaps and separately owned regression inventory must remain explicit.
- **Evidence:** absolute canonical queue add exit0; canonical JSON readback confirms exact ID/title/docs/dependency/todo. Predecessor D6/D15 retains the real SDK/signing observations. BLOCKERS additional Mobile inventory and final feature/kernel/script receipts.
- **Reversibility:** easy
- **Confidence:** high for registered ownership and inherited prerequisite limits
- **Revisit if:** Supported callbacks or authorized production identity is provided.
- **Source:** deferred: native notification callbacks and signed terminal-host packaging

## D15: Apply the now-active end-phase technical and independent review gates
- **Question:** Can the early combined-spec/review skip remain the final assurance after incoming triage confirms the end phase?
- **Options:** Keep the initial skip as final; silently claim review; separate the current technical map and execute the bounded final round.
- **Chose:** Author sibling tech.md from the live contracts and move detailed technical ownership there. One fixed-scope C/S/X final discovery round uses independent promote/refute contexts, followed by one accepted fix batch and fresh checks as LOOP prescribes. Opus/sonnet are not authenticated/shipping in the actual alias probe; Gemini3.1Pro is the available cross-family fallback for OpenAI-authored implementation. Review tools exclude shell and all writes; reproduction limitations must remain explicit.
- **Why:** The pinned incoming triage log establishes that end-phase verification is active. Earlier decisions correctly record what ran then, but do not establish an independent final review. The incoming Mobile review incident also demonstrates why an unsandboxed reviewer must not receive mutation tools or real-home access.
- **Evidence:** all-alias pi-watch preflight exit5 lists Opus/sonnet unavailable and google/gemini-3.1-pro-preview:high ready; sibling tech.md; m7-test-triage D1–D6 and incoming fix-test-apps-mobile review boundary.
- **Reversibility:** easy
- **Confidence:** high for gate/model availability; review outcome not yet claimed
- **Revisit if:** A review dispatch fails or its schema/evidence cannot be resolved.
- **Source:** locked by docs/loop/LOOP.md end-phase/final-round rules

## D16: Release exact owned preparations without a revoked context call
- **Question:** Why did successful regression teardown still log could-not-clean/no-longer-active, and could a prepared checkout actually be released?
- **Options:** Suppress the warning; keep asking a revoked context; use this activation's durable creation record plus existing Git proof.
- **Chose:** Add cleanupActivationPreparedCheckouts over only matching owner_id rows and absolute repo paths, calling existing removePrepared after narrowing its repo input to the ID/path it really consumes. Preserve root/realpath/head/detached/lock-reason/dirty safeguards. Startup cleanup still enumerates canonical repos while active; deactivation uses the owner-only helper on the same queue. A real plugin.disable regression checks the exact owned checkout disappears while the foreign locked registration and HEAD remain.
- **Why:** The returned disposer runs after its context is revoked for new calls, though saved-store teardown remains available. Re-querying quirky.repo/list cannot establish cleanup authority then. The private creation row and exact live Git lock proof already carry the needed ownership; no synthetic Repo, broad fallback or hidden exception is needed.
- **Evidence:** observed warning in remote artifacts65/68; worktree main's old releasePrepared listRepos call; prepared.ts removePrepared guards and new owner-only helper; prepared-create.test.ts disable/resource regression.
- **Reversibility:** medium
- **Confidence:** high for source cause; fresh pre-pass includes the added regression
- **Revisit if:** Resource teardown can target a foreign or changed registration, or the new live regression fails.
- **Source:** assumed — autonomous

## D17: Repair the pre-pass fixtures and the accepted resume binding defect before model discovery
- **Question:** What stopped the first deterministic pre-pass, and what did the independent-from-implementation spec inspection establish?
- **Options:** Ignore red checks, repin old envelopes, or keep an old-generation mirror selector; fix the actual resource/attachment contracts.
- **Chose:** The preparation CLI regression now proves real directory device/inode/birth-time reuse and moved Git registration rather than pinning a legacy ok/result envelope or echoed repo/base fields. The shared fixture writer creates parent directories for nested files. Accept the spec review's resume defect: after a guest generation rotates, the VM reattaches its original worktree ID/instance through the verified current host and retains the actual new mirror ID/fingerprint. Its boundary fixture rotates generation/mirror identity. Add the two missing technical logic backlinks.
- **Why:** Actual prepass returned fail with two preparation-file cases, while typecheck/build passed and the new disable/foreign-resource regression passed. No independent code model was dispatched over that red snapshot. The spec reviewer showed that the old resume lookup required the previous ID even though remote mirror IDs include generation, making ordinary cold resume unreachable.
- **Evidence:** preserved review/prepass.json for run4a129bc8383c995a; prepared-create failure outputs; same-family spec reviewer finding vm.ts966–967 and remote.ts generation hashing; source fix uses remoteAttach plus original-instance validation. No live-VM reproduction is claimed.
- **Reversibility:** easy
- **Confidence:** high for the observed fixture errors and source-level resume contradiction; refreshed checks and final independent round follow
- **Revisit if:** The generation-rotating boundary or resource reuse regression fails.
- **Source:** assumed — autonomous

## D18: Separate historical attachment origin from current resume authority
- **Question:** Did the first resume repair actually close the accepted generation-rotation defect, and what stopped the second pre-pass?
- **Options:** Equate old mirror generation with the new saved identity; require an old offline registry row; validate retained origin independently and require a fresh current attachment.
- **Chose:** Preserve the latest authenticated registration for retry/retirement, compare historical registered-host ID, stable guest-host ID and exact worktree ID/instance only as origin evidence, then validate a fresh remoteAttach against the current generation. Old public mirror existence or offline status is not a resume prerequisite. Keep suspend's separate physical-stop and offline-owner proof. Add a portable origin-relation regression and bounded macOS lifecycle recovery cases. Delete the repository hook test that merely pinned the incidental no-file default object instead of repinning extra fields.
- **Why:** Bounded spec closure showed that the first repair still compared old-generation history against the overwritten current identity. Source inspection also showed that requiring old connected:false history would reject healthy same-generation reconciliation or detached public mirrors. Historical metadata is not current action authority; the independently authenticated owner and fresh attachment supply that authority.
- **Evidence:** spec review closure at vm.ts1233–1237; subsequent resume history precondition at vm.ts1259–1262; ready-v2/prepass.json records 26pass/1fail in hooks.test.ts while typecheck/build passed. Neither red pre-pass dispatched an independent code model. Hardware lifecycle execution remains unobserved.
- **Reversibility:** medium
- **Confidence:** high for the source contradiction; fresh portable and final checks follow
- **Revisit if:** Current attachment can bypass original-instance validation, or retained origin rejects a legitimate authenticated generation rotation.
- **Source:** assumed — autonomous

## D19: Preserve the original review claim and close its actual process-boundary defect
- **Question:** Did three machine PASS gates justify discarding a malformed X response or claiming complete review coverage?
- **Options:** Accept the schema retry's empty result; silently normalize a claim; preserve the original, use format-only model conversion and fresh refutation, then adjudicate the actual source.
- **Chose:** Preserve every raw attempt. Gemini format-converted the original X1 claim without changing claim/evidence, and a fresh refuter kept it standing at LOW rather than CRITICAL. The deterministic gate suppressed it as falsified; the original quote/reference spans disagree, but direct source inspection confirms the PATH concatenation and repository cwd. Accept the bounded defect anyway: absent/empty inherited PATH must not acquire an implicit cwd entry. Keep nonempty host PATH policy unchanged. A real remote child-process regression fails before the guarded concatenation and passes after; its positive trusted-directory case also passes.
- **Why:** A format retry returning [] does not refute an existing substantive claim. PATH absence is a legitimate host-environment boundary, even though a repository attacker cannot generally create that precondition and critical exploitability is unproved. The minimal correction avoids unintended command selection without inventing a general sandbox or environment policy.
- **Evidence:** ready-v3/promote-X.retry1.raw.txt; merged-X.final.json keeps X1 standing/LOW; gate-X.final.json suppresses it as falsified; frozen vm.ts729 and752–754 show the actual string and cwd. security-red.json records exit1, expected127/received0 on both runner attempts; security-green.json/stdout records exit0, one remote file passed/flaky[], 15.824s. The three review gates are machine PASS, not a claim that C/S traversed every source line: C logs one staged-prompt read and S limited reads/grep. No complete traversal or live-VM assurance is established.
- **Reversibility:** easy
- **Confidence:** high for the reproduced executable-search defect and its narrow closure; bounded for review coverage
- **Revisit if:** A lifecycle command can still gain an implicit cwd entry from this concatenation, or a claimed review result omits the preserved X1/audit limitations.
- **Source:** locked by docs/loop/LOOP.md one-final-round/one-fix-batch rule

## D20: Land the exercised source with explicit hardware, suite and review limits
- **Question:** What does the final evidence establish, and which claims remain unsupported?
- **Options:** Call every platform/suite/review complete; block source on unavailable optional hardware; land the implemented source with exact exercised receipts and retained obligations.
- **Chose:** The final post-fix remote command passes all27 selected files on the first run, zero failed/flaky[], exit0 in40.896s. Full typecheck passes37.981s; shipped UI/desktop build passes18.035s. Preserve the earlier actual two-daemon/API/CLI/production-component smoke, the red/green real executable-search boundary and all review artifacts in the lane evidence archive. No second discovery round. No accepted code finding remains unclosed.
- **Why:** Actual remote owner data, mutation fences, navigation and lifecycle error surfaces ran. A genuine optional Lima adapter is implemented, but no Lima installation/live guest was available and eight macOS boundary simulations skipped remotely; this is not live-VM acceptance. The broader Mobile failures already have a canonical repair owner. C/S logs do not prove full artifact traversal, and the earlier pre-pass load-only failure remains unexplained despite the clean final gate.
- **Evidence:** review/final-verification.json and full stdout/stderr: remote27/27, typecheck0, build0. review/security-{before.diff,red.json,green.json}; ready-v3 raw prompts/results/manifests; executed-owner-runtime.smoke.test.mjs and owner-workspace.png/vm-lifecycle-refusal.png. One successor, m7-native-notification-and-signed-terminal-host, is already registered for the exact unavailable callbacks/authorized packaging, not for tests/review.
- **Reversibility:** medium
- **Confidence:** high for the exercised source boundaries; no hardware/native/full-suite or comprehensive-review claim
- **Revisit if:** Actual Lima/guest acceptance fails, a fresh owner check permits a stale action, or the unexplained remote-owner-workspaces test failure recurs.
- **Source:** locked by docs/loop/LOOP.md end-phase evidence and native-successor rules

## D21: Compose the rejected-land catch-up with the real VM entry and canonical UI policy
- **Question:** How should the canonical conflict rejection and newer binding decisions change the candidate?
- **Options:** Keep the stale refusal, discard the incoming dialog restyle or lint rules, or compose the actual VM owner with the current shared UI contracts.
- **Chose:** After canonical land rejected 2f8459d1, merge the actual roadmap parent bc52520e9f03247570d4d01a6c6ccb9f1eaa88d1 as 9e15e1ad. Consume all24 newly incoming logs, preserving current owner/session/credential boundaries, canonical Git source inventory, shared dialog/menu/focus behavior and host placement. Resolve the only CreateDialog conflict with the real VM-manager action, using existing Button. Replace RemoteWorkspace raw pixel dimensions with existing canonical UI tokens; do not exempt files or weaken lint.
- **Why:** The old no-runtime-owner paragraph is obsolete now that the owner is implemented. Incoming Worktrees restyle and Accounts source-inventory policy are binding. Incoming Mobile repair reports its later55remote/2macOS passing gate; the four earlier Mobile failures recorded here are historical, not current conclusions. Existing broader Git/Worktree repair ownership remains unchanged.
- **Evidence:** rejected land exit1/25.35s; merge9e15e1ad parent2; full24log coverage in incoming-after-rejection.json. The post-merge27file gate passed, then UI lint identified raw pixel dimensions; the final land-ready27file gate passes47.970s/flaky[], full typecheck32.007s and packaged build18.817s. A fresh actual two-daemon/API/CLI/production-component smoke passes1/1 in393.67s: real diff, composed New workspace→Advanced→VM manager navigation, consent disabled-before/enabled-after and truthful unsupported-Linux durable failure. Browser errors entries[], observed owner/dialog/VM screenshots; one full-page screenshot attempt timed out but viewport capture succeeded. Browser/tunnel/FIFO/private homes and product-tree fixtures are closed/removed; no stop HTTP acknowledgment is claimed.
- **Reversibility:** easy
- **Confidence:** high for the exercised integration; unchanged live-Lima/native/full-suite and C/S traversal limits
- **Revisit if:** Canonical land names another conflict/gate failure, or the existing broader repair owners report a contract conflict.
- **Source:** locked by docs/loop/LOOP.md failed-land recovery; incoming ui-restyle-worktrees and ui-restyle-accounts

## Progress
Implementation, sibling specs, bounded final review and accepted fix are complete. The required failed-land catch-up consumed24 more logs (44total) and preserved incoming UI/authority contracts. Latest remote27file/typecheck/packaged-build gates pass; the fresh actual API/CLI/production-component plus composed-dialog smoke passes1/1/393.67s. All live-Lima/native/full-suite/review-coverage limits remain explicit. Browser/tunnel/FIFO/private homes and temporary product-tree fixtures are removed; one native successor is registered. Next: refresh the final archive, commit, detach and canonical re-land; end only after its actual verdict and owned scratch/worker-branch cleanup.
