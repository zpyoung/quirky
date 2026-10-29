# VM and owner-bound host/workspace technical contract

Status: approved autonomously; current source contract extracted for end-phase review. Complexity gate: protocol, kernel lifecycle, owner transport, persistence and renderer boundaries; more than three source files. Behavior and rationale: [logic.md](logic.md).

## Architecture

Implements [the conceptual model](logic.md#goal-consumers-and-conceptual-model) and [acceptance scenarios](logic.md#behavior-and-acceptance-scenarios).

The protocol defines public identities and activation cleanup. The kernel owns each returned cleanup closure on its exact activation attempt. The CLI plugin issues a durable host identity and forwards through the existing encrypted saved owner target. The worktree plugin owns separate registered-host, mirror and VM tables; remote paths never enter ordinary local worktree storage. Lima is an explicit external runtime, not a local terminal substitute. Renderer contributions use public methods and the canonical six-slot projection.

## Code references

These anchors implement the [observable acceptance scenarios](logic.md#behavior-and-acceptance-scenarios). All paths below are absolute under the implementation worktree; symbols are authoritative, not line numbers that drift during integration.

| Unit | Source anchors |
|---|---|
| Public identity/call types | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/packages/protocol/src/runtime-owner.ts`: `OwnerHostIdentity`, `OwnerRuntimePin`, `OwnerRuntimeCallParams`, `RegisteredOwnerHost` |
| Public cleanup contract | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/packages/protocol/src/plugins.ts`: `PluginActivationDisposer`, `PluginModule` |
| Activation ownership | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/packages/daemon/src/plugins/host.ts`: `Attempt.activationDisposer`, `loadAndActivate`, `disposeActivation`, `callActivationDisposer`, `revokeExtension` |
| Owner issuer/forwarder | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.cli/main.ts`: `registerHostIdentity`, `expectedHostParam`, `expectedRuntimeParam`, `callOwnerRuntime` |
| Owner-bound mirror service | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/src/daemon/remote.ts`: `migrateRemoteWorkspaces`, `registerRemoteWorkspaces`, `callHost`, `freshMirror`, `mirrorFingerprint` |
| VM owner | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/src/daemon/vm.ts`: `migrateVmEnvironments`, `registerVmEnvironments`, `environmentRecipeHash`, `runVmProcessBounded`, `refreshStoppedMirror`, `remoteRetire` |
| Canonical creation | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/src/daemon/create.ts`: `createWorkspace`, `createVmRecipeWorkspace`, `canonicalGuestCreateParams` |
| Canonical deletion | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/src/daemon/remove.ts`: `RemoveParams`, `removeWorktree`, `assertExpectedInstance`, `removeRegistered` |
| Cleanup selection | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/src/daemon/controls.ts`: `cleanupRemove`; sibling `src/control-types.ts`: `CleanupSelection` |
| Owned preparations | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/src/daemon/prepared.ts`: `cleanupPreparedCheckouts`, `cleanupActivationPreparedCheckouts`, `removePrepared` |
| Store and lifecycle integration | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/src/daemon/store.ts`: `openWorktreeStore`; `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/main.ts`: `activate` and its returned closure |
| Mobile lifetime only | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.mobile/main.ts`: `activate`; grant/admission implementations remain their existing owners |
| Renderer | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/src/ui.tsx`: contribution mounts; siblings `RemoteWorkspace.tsx`, `RemoteWorkspacesSection.tsx`, `VmEnvironments.tsx`, `VmRecipeSelector.tsx`, `actions.ts`, `CreateDialog.tsx` |
| CLI/schema surface | `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.worktree/quirky-plugin.json`, `cli.ts`; `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/plugins/quirky.cli/quirky-plugin.json`, `cli.ts` |

## Contracts and interfaces

Implements [locked observable boundaries](logic.md#decisions-locked--gray-areas).

### Kernel cleanup

`CONTRACT:`
```ts
type PluginActivationDisposer = () => void | Promise<void>
PluginModule.activate(context: PluginContext): void | PluginActivationDisposer | Promise<void | PluginActivationDisposer>
registerVmEnvironments(context: PluginContext, store: PluginStore): () => Promise<void>
```

The host retains returned cleanup on the activation attempt, consumes it once, and invokes it before normal extension revocation. A cleanup returned after revocation runs immediately; it must release owned resources without assuming a live context. Existing static `deactivate` hooks still execute when declared. Worktree and Mobile state is activation-local. A stopped host cannot dispose another host's listener, tabs, notifications, VM process group or preparations.

VM teardown sets stopping, terminates/awaits owned detached subprocess groups and drains operation promises before the store closes. Preparation teardown uses only this activation's private creation rows and existing exact Git/path/lock proofs; it does not ask a revoked context to enumerate repos. Active startup cleanup still resolves canonical repos.

### Authenticated forwarding

`SCHEMA:`
```text
OwnerHostIdentity = { hostId:string, generation:string }
OwnerRuntimePin = { id:string, endpoint:string, grantId:string }
runtimeCall = { runtime:string, method:string, params?:object, expectedHost?:OwnerHostIdentity, expectedRuntime?:OwnerRuntimePin }
```

`runtime` resolves an exact saved owner-cli target; phone targets refuse. Compare expected saved ID/endpoint/grant before connection. Parse and validate the stored offer/key/credential binding. On that same authenticated connection, verify expected host ID/generation before dispatch. Do not reconnect or replay a mutation after an ambiguous response. Public results contain safe runtime identity plus actual result, never offers/tokens.

### Registered hosts and mirrors

`SCHEMA:`
```text
RegisteredOwnerHost = { id, runtime:{id,name,endpoint,grantId}, identity:{hostId,generation}, connected:boolean, error:string|null, updatedAt:number }
RemoteWorkspaceMirror = { id, hostId, identity:{hostId,generation}, worktree:Worktree, connected:boolean, fingerprint:string }
```

`remoteHostRegister({runtime,replace?})` pins returned runtime and producer identity. Changed grant or generation requires explicit replacement. `remoteAttach({host,worktree})` accepts exact canonical worktree IDs; `remoteRefresh({host})` returns current owner projections. `remoteList` retains snapshots; `remoteShow` marks stale/offline evidence unavailable. Every bound action sends both runtime and host pins and rechecks workspace instance. Mirror ID/fingerprint bind host generation, saved grant and canonical workspace instance.

`remoteNavigate({workspace,window?})` opens only `view:quirky.worktree/remote` with its mirror ID in the exact selected live window. It never opens a guest path locally. `remoteCall` allows only declared changes/diff/session/terminal operations and validates operation-specific keys and bound sessions. Folder workspaces omit inapplicable Git reads in the renderer while retaining terminal/navigation behavior.

`remoteRemove` uses a current mirror fingerprint and canonical safe-only, non-forced removal with expected instance. Cleanup uses the owner's separate live cleanup fingerprint/eligibility. `remoteHostForget` deletes local registration/mirrors only; optional expected host/runtime pins are checked in the same synchronous transaction as deletion. VM retirement always supplies those pins. Confirmed cross-runtime deletion carries `yes:true` downstream; handler `confirmed:true` is distinct from kernel consent.

### Genuine VM lifecycle

Implements [VM behavior](logic.md#behavior-and-acceptance-scenarios) without claiming hardware verification from simulations.

`vmRecipes({repo})` returns parsed recipes, normalized checkout modes, diagnostics and exact complete lifecycle `trustHash`. `vmCreate({repo,recipe,trustHash,name?,createParams?})` returns the actual durable VM record. Public list is `{environments:VmEnvironment[]}`; `vmShow({vm})` returns one record. Lifecycle requests require `{vm,instanceId}` and configured scripts. In-flight create operations refuse competing lifecycle mutations.

The hash covers normalized ID/name/create/checkoutMode/description/suspend/resume/destroy/destroyDisabled. Save the approved immutable snapshot. Provisioning creates a durable record/operation before bounded subprocesses; failed/interrupted state is visible after caller timeout. No automatic create or uncertain canonical guest-create replay.

Resolve explicit `QUIRKY_LIMACTL` or `limactl`; require macOS and genuine Lima version/list behavior. Verify exact generated instance through `list --all-fields --json` and persisted directory device/inode/birth time. A same-name replacement refuses before lifecycle scripts. Child commands use typed detached Node process groups with bounded output and TERM/KILL ownership.

`CONFIG:` Scripts receive `QUIRKY_VM_NAME`, `QUIRKY_VM_OPERATION_ID`, `QUIRKY_VM_OUTPUT_PATH` and the recipe/repo/backend metadata. Output is a pre-created mode-0600 private file, at most16KiB.

`SCHEMA:`
```text
provisioned-root output = { pairingCode:string, workspaceSelector:exactGuestWorktreeId }
orca-worktree output = { pairingCode:string, repo:guestRepoSelector, name:guestWorktreeName }
```

Persist the offer only through the existing saved-target API. Compare `quirky api call quirky.cli/hostIdentity --json` inside Lima to the authenticated endpoint before attaching. Orca-worktree mode forwards supported canonical create options and retains its actual receipt; provisioned-root refuses choices it cannot honor. Activation of the result uses the remote-specific view only.

Suspend verifies a stopped/suspended backend, requires matching stored owner/runtime status disconnected, and reads the exact retained mirror from `remoteList`. It cannot require a live refresh from a powered-off guest. Resume verifies backend instance, authenticates the current guest generation, and reattaches the original workspace instance through the current registered host. Historical origin means registered-host ID, stable guest-host ID, worktree ID and worktree instance—not the historical generation or the continued existence/offline state of an old public mirror row. Persist the latest authenticated registration even if reattachment fails, so retry and retirement retain its authority fence. Accept a new mirror only after current-generation and original-instance validation; retain its actual new ID/fingerprint. A stopped backend is powered off, not evidence of preserved RAM.

Destroy proves backend absence before retiring anything. Local host-list absence is reconciled only when no replacement uses the recorded runtime. Existing host retirement is generation/grant-fenced atomically; credential retirement verifies the exact VM-created saved UUID and current safe summary. Other registrations/credentials remain. A partial retirement keeps enough flags/evidence for explicit reconciliation.

## Data models and schemas

Storage implements [durable authority](logic.md#goal-consumers-and-conceptual-model).

- CLI store: `owner_host_identity` owns one persistent host UUID; activation supplies a new generation.
- Worktree store migrations append `remote_hosts`, `remote_workspaces` and `vm_environments` through exported migration functions. SQL definitions in those migrations are authoritative; do not duplicate remote paths into `worktrees`.
- VM rows retain approved recipe JSON/hash, backend executable/identity, operation identity/state/times, saved runtime identity, host identity, exact mirror/worktree instance, canonical-create receipt/state and retirement flags. Public `VmEnvironment` omits secret pairing output and raw scripts/stdout.
- Public declarations use only the flat `Schema` vocabulary. Runtime parsers enforce length/nullability/key and ownership constraints that the schema subset cannot express. Both `remove` and its confirmation descriptor accept `safeOnly`/`expectedInstanceId`.

## DO-NOT-CHANGE fences

Preserves [scope/non-goals](logic.md#scope-and-non-goals).

- `plugins/quirky.mobile/src/daemon/authorization.ts` and service credential admission: phone grants are not owner grants; lifecycle isolation must not widen the method surface.
- Existing federation admission/transport: do not reuse a peer credential as full owner authority or add another transport.
- Canonical worktree removal's archive, dirty, locked-worktree, branch-preservation and real filesystem checks: instance fencing augments them, never bypasses them.
- `docs/loop/LOOP.md`, `scripts/build-loop/`, shared queue/index: protected; only the canonical queue command changes shared state.
- Real user/provider homes and feature research directory: never writable test/provisioning fixtures.
- Supported notification callbacks and authorized production signing: no private SDK patch, no fabricated delivery callback, no ad-hoc production identity.

## Always / Ask / Never

Preserves the [locked authority and lifecycle constraints](logic.md#decisions-locked--gray-areas).

- Always retain exact owner/instance evidence, conservative unknown/offline state, explicit destructive consent and durable ambiguous outcomes.
- Ask no person in this unattended loop. Record an autonomous choice; a genuine locked-decision conflict uses the prescribed block/defer path.
- Never mutate a local path based on a remote snapshot, broaden phone/federation credentials, run an ordinary tab as a VM, or turn a timeout into a destructive retry.

## Cross-cutting

Implements [defect prevention](logic.md#defect-prevention).

Secrets stay in the existing private target registry/output files and are excluded from errors, summaries, screenshots and archives. Migrations are append-only. Do not invent downgrade shims; preserve original data for explicit recovery. Callers distinguish snapshot visibility from fresh permission. Public VM history is unavailable when lifecycle state or authenticated epoch no longer verifies its attachment. Lifecycle command search must not introduce an implicit working-directory component when inherited PATH is absent or empty; existing nonempty host PATH policy is preserved. Per-activation closure ownership is required even when multiple kernels import one source module URL.

## Testing strategy

Acceptance maps to [scenarios](logic.md#behavior-and-acceptance-scenarios); exact executed receipts belong to the decision log.

- `plugins/quirky.cli/test/owner-host-fence.test.ts`: stable ID/new generation, pre-dispatch saved/host fences, malformed pins, phone refusal, state unchanged after denial.
- `plugins/quirky.worktree/test/remote-owner-workspaces.test.ts`: live owner registration/restart, actual mirrors/data/terminals, current and replaced instances, canonical cleanup, local-row preservation, explicit consent, atomic forget pins, public saved-name replacement and ordinary folders.
- `plugins/quirky.worktree/test/vm-environments.test.ts`: full recipe hash, bad private output, missing backend, busy lifecycle guard, real child-group termination and executable-search isolation, portable historical-origin relation, generation-rotating and same-generation reattachment, detached-history recovery, explicit offline projections, replaced/absent host retirement and same-name backend replacement. Mac-only boundary simulations skip off macOS and are never live-VM evidence.
- `packages/daemon/test/plugins/activation-disposer.test.ts`: independent real leases across two hosts sharing one module URL and late activation disposal. Existing host/extension/runtime tests retain their lifetime contracts.
- `plugins/quirky.worktree/test/prepared-create.test.ts`: exact owned preparation cleanup on deactivation, preserving unrelated user/Git state.

`COMMAND:` Run every selected file/dir with `bun scripts/suite.ts <file or dir>`; only the current `scripts/test-on-macos.txt` exceptions run locally. Use `bun run typecheck` and `bun run build` for static/shipped composition. No default local test fallback. Real runtime/browser smoke uses isolated homes and closes owned tabs/tunnels/daemons.

## Non-goals

See [the exact logical exclusions](logic.md#scope-and-non-goals) and [landing disposition](logic.md#landing-disposition). This file does not authorize a second feature owner, native capability simulation or a broader visual redesign.
