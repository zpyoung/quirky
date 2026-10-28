# fix-test-packages-daemon-1028 decisions

## D1: Preserve focused-window state; test owner isolation explicitly
- **Question:** Should the daemon's focused auxiliary state revert to the global layout to satisfy the baseline equality assertion?
- **Options:** Change runtime projection; delete the stale equality and exercise exact owner and auxiliary window state through the public API.
- **Chose:** Preserve runtime projection and test the actual window-isolation contract.
- **Why:** The reported test focuses the auxiliary renderer and updates its route, then compares the focused state to the earlier main-window layout. The public state implementation intentionally projects the focused window. Fresh focused reproduction fails at desktop-shell.test.ts:113 with auxiliary view/input replacing the prior null view. This is a stale test contract, not evidence of global layout mutation.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.packages/daemon; packages/daemon/src/plugins/layout.ts:217–259,814–829; focused run artifact://6 (0 pass,1 fail,1.63 seconds).
- **Reversibility:** easy (test-only correction)
- **Confidence:** high
- **Revisit if:** Exact main-window state changes when only the auxiliary route changes.
- **Source:** assumed — autonomous

## D2: Register the auxiliary native capability and listen before triggering activation
- **Question:** How should the regression drive the owner-command activation phase?
- **Options:** Weaken native capability enforcement; provide the native renderer capability and pre-register its event listener.
- **Chose:** Correct the fixture, retaining production owner and capability checks.
- **Why:** Once the stale layout assertion was removed, the next run rejected with “no capable native desktop window supports auxiliary windows”. The attached auxiliary connection had never advertised its supported activation bridge. The listener also must exist before replying to the owner command, since that reply triggers activation.
- **Evidence:** packages/daemon/src/plugins/layout.ts:546–565,692–714,736–746; focused failure artifact://8 (1.94 seconds); repaired focused run bg_8 (1 pass,0 fail,19 assertions,1.58 seconds).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The actual auxiliary renderer no longer supports native owner activation.
- **Source:** locked by docs/quirk/specs/2026-10-28-m7-terminal-runtime-native-and-worktree-parity/logic.md B3

## D3: Await the deferred same-connection response before applying the matcher
- **Question:** Should the owner-command assertion use Bun's promise matcher or native async settlement?
- **Options:** Increase the timeout; change production response scheduling; await the response normally and match its exact value.
- **Chose:** Use `expect(await ownerCommand).toEqual(...)`, preserving the exact expected result and existing timeout.
- **Why:** After adding capabilities and pre-registering activation, `.resolves.toEqual` hung at the owner response until both 5-second and diagnostic 20-second test deadlines. Replacing only the promise matcher with native await passed in 1.58 seconds. The independent daemon smoke also received/replied activation and resolved the exact owner command, proving no runtime concurrency change was needed.
- **Evidence:** artifact://10; artifact://12; bg_8; bg_7 SMOKE_LAYOUT_ISOLATED, SMOKE_ACTIVATION_RECEIVED, SMOKE_ACTIVATION_REPLIED, SMOKE_OWNER_COMMAND_RESOLVED, DAEMON_AUXILIARY_ROUTE_SMOKE_OK and CLEANED (exit0,2.07 seconds).
- **Reversibility:** easy
- **Confidence:** high for the demonstrated matcher/await difference; no claim about Bun internals
- **Revisit if:** Native await also fails with the same owner activation path.
- **Source:** assumed — autonomous

## D4: Keep this repair test-only and retain native acceptance boundaries
- **Question:** Does this reported failure require runtime, plugin API, UI, or native-handoff changes?
- **Options:** Modify production state/bridge behavior; repair only the invalid fixture assumptions.
- **Chose:** Test-only correction plus this decision record; no new feature spec or native status changes.
- **Why:** The stale expectation contradicted existing focused projection; the missing capability and deferred-promise assertion prevented reaching already-built owner-close behavior. The standalone smoke uses a real disposable daemon and public API, not an OS window. Native folder/focus/window-frame acceptance remains unchanged. Its first attempt correctly refused ambiguous unfocused capable shells; the owned smoke fixture then explicitly focused the main shell.
- **Evidence:** canonical before suite bg_1 (77 files:76 pass,1 fail; isolated retry reproduced); focused red/green D1–D3; B3 native-only boundary in the existing logic spec.
- **Reversibility:** easy
- **Confidence:** high for the exercised API path
- **Revisit if:** Actual native UI acceptance identifies a product failure.
- **Source:** assumed — autonomous

## Progress
Bounded regression repair implemented; focused test passes and isolated public-API smoke exits0 with cleanup marker. Canonical before suite reproduced exactly one failing file (76/77 pass). Static review is running. Next: commit, single roadmap catch-up/read incoming decisions, run scripts/typecheck/canonical daemon suite, record results, detach and land the one claimed item.
