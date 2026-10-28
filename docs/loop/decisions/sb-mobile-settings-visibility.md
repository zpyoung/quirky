# sb-mobile-settings-visibility decisions

## D1: Diagnose the narrow desktop Settings observation
- **Question:** what scope and success criteria should brainstorming use?
- **Options:** desktop Settings reachability only; redo the whole Mobile feature; treat the working standalone page as sufficient.
- **Chose:** desktop Settings at 1280×720, before/after QR expansion, scrolling, keyboard access and actual revoke.
- **Why:** this queue item exists because the alternate page did not resolve Settings reachability.
- **Evidence:** sb-mobile-daemon D22; external feature doc mobile.md flows 2 and 10; roadmap.md Side track B.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** evidence identifies another owner as essential to the same flow.
- **Source:** locked by docs/loop/decisions/sb-mobile-daemon.md

## D2: Preserve layout, density, loading, empty and error behavior unless clipping reproduces
- **Question:** which Visual gray areas need a behavior change?
- **Options:** preserve and measure; add a nested Mobile scrollbar; reorder devices before pairing.
- **Chose:** preserve and measure, then fix only the demonstrated owner if necessary. Existing empty/error/loading outcomes remain.
- **Why:** the host already declares overflow; previous evidence does not establish an app CSS defect.
- **Evidence:** packages/ui/src/styles.css:1149-1160; plugins/quirky.mobile/src/window/MobileSettings.tsx:142-207.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** correct wheel targeting still cannot reach the device action.
- **Source:** assumed — autonomous

## D3: Separate wheel and keyboard focus from guarded-driver outcomes
- **Question:** what interaction evidence distinguishes clipping from targeting?
- **Options:** trust tree presence or automatic scrollIntoView; measure and exercise real inputs; infer a bug from PageDown alone.
- **Chose:** real wheel over visible Settings content and ordinary keyboard focus/navigation, with screenshots and read-only geometry. Guarded-driver outcomes reported separately.
- **Why:** keys sent to inputs and wheel events sent outside the scroller have different recipients; none alone proves unreachable content.
- **Evidence:** sb-mobile-daemon D22; using-apps-like-a-user see-first contract.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** guarded evidence and independent browser interaction disagree.
- **Source:** assumed — autonomous

## D4: Use only a real run-owned encrypted peer and isolated runtime
- **Question:** what fixture and permissions can make revoke safe and representative?
- **Options:** mutate the registry; revoke a real phone; create one encrypted peer against a fresh daemon.
- **Chose:** fresh HOME/QUIRKY_HOME, real production daemon, real encrypted pairing, and owned cleanup; only setup may call APIs outside the UI.
- **Why:** no real user/provider state may be touched, and fake rows cannot prove the actual revoke flow.
- **Evidence:** docs/loop/LOOP.md test-isolation rule; plugins/quirky.mobile/test/support/client.ts; packages/daemon/src/daemon.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** startup cannot isolate native/provider state.
- **Source:** locked by docs/loop/LOOP.md

## D5: Record cross-family fallback and investigation-first execution
- **Question:** which execution/review pairing and decomposition fit this item?
- **Options:** omp tasks plus opus; omp tasks plus available cross-family Gemini; speculative implementation before diagnosis.
- **Chose:** OpenAI omp task workers; Gemini cross-family reviewer after opus probe failed. One diagnostic slice, then at most one bounded fix slice if evidence requires it. Parent owns all checks; workers skip build/lint/test.
- **Why:** opus --check returned no authed/shipping model; gemini --check returned google/gemini-3.1-pro-preview:high. Small investigation does not need parallel source writers.
- **Evidence:** observed pi-watch preflight outputs in this iteration; source mapping scout returned without mutations.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch fails.
- **Source:** assumed — autonomous

## D6: End-phase verification and two markdown specs apply
- **Question:** which loop mode applies after the lane's prolonged busy wait?
- **Options:** earlier build-first restrictions; normal end-phase workflow.
- **Chose:** normal verification: m7-test-triage was observed claimed on lane 8 before this item was assigned. Write logic.md and tech.md, self-review, cross-family spec review, actual UI exercise and required checks. No human prompts or external research swarm for this narrow diagnostic.
- **Why:** authoritative LOOP.md restores the normal workflow once triage is claimed. A no-defect investigation should not manufacture implementation or permanent tests.
- **Evidence:** canonical wait bg_52 reported m7-test-triage in-progress lane 8; bg_53 assigned this item.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authoritative loop policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D7: Retain the spec review findings and their adjudication
- **Question:** which findings from the cross-family spec review are actionable?
- **Options:** treat an empty model findings list as a pass; retain the deterministic gate and adjudicate its failures.
- **Chose:** Gemini promote/refute each returned an empty array; the actual standard spec-design gate was NEEDS_FIXES with three prepass findings. F1 accepted: add Purpose headings. F2 corrected the scanner-hostile comma-range reference into a single-range reference plus cleanup prose; the referenced source was already observed. F3 dismissed: the quoted command `bun scripts/suite.ts` is a command, not a filename, and scripts/suite.ts exists and documents the same invocation at lines 19–21.
- **Why:** deterministic parser limitations must not be misreported as model findings or an overall PASS.
- **Evidence:** /tmp/quirky-settings-spec-review-lane2/gate.json and manifest.json; packages/daemon/src/daemon.ts:117-129; scripts/suite.ts:19-21.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an actual referenced source path fails to resolve.
- **Source:** assumed — autonomous

## D8: Account for the unsandboxed review constraint breach
- **Question:** did the reviewer obey the no-tests/read-only review contract?
- **Options:** omit the breach; treat worker test activity as acceptance; preserve and bound the evidence.
- **Chose:** preserve raw promote.stderr: Gemini ran `bun test scripts` twice despite explicit prohibition. Those runs are not acceptance. Parent independently observed its own scripts check pass (81 tests, 0 failures) and root/mobile/desktop typecheck pass. Reviewer post-status showed no tracked mutations; attribution of ignored/untracked artifacts is unavailable because parent and reviewer checks overlapped.
- **Why:** read-only prose prompts are not a sandbox; the breach cannot establish either clean acceptance or provenance of all artifacts.
- **Evidence:** /tmp/quirky-settings-spec-review-lane2/promote.stderr and repository-status.txt; parent bg_54 output artifact://79.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** evidence identifies a reviewer-authored tracked mutation.
- **Source:** assumed — autonomous

## D9: Expand the reproduction to include the real status-bar owner
- **Question:** does the first successful run cover the original below-status-bar observation?
- **Options:** claim complete from the minimal Mobile-only runtime; add the genuine Accounts status-bar contribution and repeat.
- **Chose:** first run 20261028T210043-f8d5 passed scroll, keyboard and revoke with no app edits, but it lacked the plugin status bar. Treat it as bounded initial evidence, not proof of the original host topology. Prepare a second isolated runtime with real quirky.accounts after checking credential isolation.
- **Why:** App renders the footer only when statusBars is nonempty, and quirky.accounts is the actual status-bar contributor.
- **Evidence:** packages/ui/src/App.tsx:264-268; plugins/quirky.accounts/quirky-plugin.json:265-267; first guarded report and screenshots.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Accounts cannot be isolated without real-provider effects.
- **Source:** assumed — autonomous

## D10: Enforce credential isolation at the macOS process boundary
- **Question:** how can the real Accounts footer run without touching the user's keychain or provider APIs?
- **Options:** run Accounts under HOME isolation alone; invent a fake footer; use a disposable account; enforce a macOS sandbox.
- **Chose:** scrub inherited token/secret/password/API-key/credential variables, retain private HOME/XDG/Claude/Codex paths, deny execution of /usr/bin/security and access to real Keychains/.claude/.codex paths, and deny non-loopback outbound network with sandbox-exec. A direct probe reported security Operation not permitted (exit126), and external DNS/network failed. Real Accounts displayed Keychain unavailable / Refresh failed; no provider success was simulated.
- **Why:** the setup worker found Accounts can query the actual macOS keychain even under an isolated HOME. This is an OS-enforced denial, not a fake plugin or private credential-path shim. sandbox-exec also prevents /bin/ps execution: the first inner process-scope startup failed and cleaned. The successful runner therefore supervises the sandbox from an outer real process scope.
- **Evidence:** plugins/quirky.accounts/src/profiles.ts:361-376; src/usage/credentials.ts:258-298; parent sandbox denial probe; lane2-settings-statusbar-owned startup/cleanup output.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a provider uses a credential source outside this sandbox's declared fences.
- **Source:** assumed — autonomous

## D11: Close the clipping investigation without changing working application code
- **Question:** does the reproduced current application require an overflow fix?
- **Options:** change CSS despite successful access; infer the old exact cause; record current target-dependent behavior and preserve code.
- **Chose:** preserve all production code and tests. Real footer run 20261028T211333-09d2 passed all three goals at 1280×720: one-viewport wheel over visible Settings content exposes the full action; with QR expanded the initially clipped action becomes fully visible after PageDown, and four Tabs reach its focus outline; visible Settings revoke yields success/empty state and real encrypted-peer close4001. Final public devices call returns an empty array.
- **Why:** fixed-footer wheel targeting returns NO_EFFECT while identical wheel over Settings returns OBSERVED. The host overflow works; the missing historical action trace does not prove its exact wrong recipient, nor a past driver implementation defect. Adding a nested scrollbar or reordering Mobile controls would be speculative. Screenshot geometry, not numeric DOM instrumentation, bounds the visual claim: the red action is fully above the real footer after navigation.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261028T211333-09d2/report.md; obs5/6/7/8 targeting comparison, obs10 initial clipping, obs12/16 reachability, obs18 revoke. Earlier no-footer run 20261028T210043-f8d5 passed the same scenarios. Both reports have no test overrides, console/network findings or kept-open windows.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another current build reproduces inability to scroll or keyboard-focus the action with correct targeting.
- **Source:** assumed — autonomous

## D12: Preserve the separate visual finding and bound the verification claims
- **Question:** what else did the run observe, and which checks actually passed?
- **Options:** call the whole UI defect-free; expand this item into restyling; retain a typed observation and exact evidence.
- **Chose:** append a MEDIUM contrast observation to BLOCKERS.md and both guarded reports: Mobile's red revoke button label is not distinguishable in the light theme, but the action is fully onscreen and named in accessibility data. Existing UI restyle/screenshot-review work owns that observation; no new follow-up item or speculative clipping fix. Parent build passed after frozen dependency install refreshed workspace links; parent scripts tests passed81/0 and root/mobile/desktop typecheck passed. No affected-source package suite is needed because this item changes only its specs, decision log and append-only observation ledger.
- **Why:** the queue title authorizes fixes only for reproduced app clipping. The isolated sandbox runtime's PTY startup was unavailable; no terminal/usage/provider behavior pass is claimed. Pairing and revoke use the actual production daemon and E2EE peer and succeeded. No permanent test was added for a no-defect investigation.
- **Evidence:** plugins/quirky.mobile/src/window/MobileStyles.tsx:17; DeviceList.tsx:49; guarded F1; parent build output and bg_54; final-devices empty arrays and cleanup receipts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** UI redesign does not address the recorded label contrast or a source change becomes necessary.
- **Source:** assumed — autonomous

## Progress
Actual two-topology UI investigation complete; no production changes. Both real peers revoked via Settings, both guarded runs ended, both daemon services exited0 with home/builtin cleanup; sandbox outer scope also cleaned. Specs reviewed with real Gemini promote/refute and deterministic findings adjudicated in D7; raw artifacts preserved under .quirk/build-loop/sb-mobile-settings-visibility/spec-review. Parent next commits evidence, performs the required roadmap catch-up, reads incoming decisions, checks the merge and lands this single item.
