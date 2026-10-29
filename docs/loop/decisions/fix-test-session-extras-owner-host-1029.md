# fix-test-session-extras-owner-host-1029 decisions

## D1: Diagnose the landed composition before changing its contracts
- **Question:** Which historical acceptance failures still apply after the predecessor's final compiler/helper repairs?
- **Options:** Assume all eight remain; assume compiler fixes closed them; run the owning canonical remote acceptance and inspect actual failures.
- **Chose:** Run Accounts, Vault and Handoff through `bun scripts/suite.ts`; retain owner/grant/generation/instance fences, reviewed target-only delivery, source liveness, remote archive privacy and saved-agent drafts. No direct local test runs and no additional review campaign.
- **Why:** The queue explicitly distinguishes the old 63/71 snapshot from the final landed source and requires current evidence plus associated actual owner UI scenarios.
- **Evidence:** Claimed queue title; m7-session-extras-owner-host-flows D1/D2/D6/D8–D11; canonical owning acceptance launched on current roadmap source.
- **Reversibility:** easy
- **Confidence:** high for scope; causes remain unproven until current output
- **Revisit if:** Current failure evidence identifies a missing owner contract rather than an implementation/fixture defect.
- **Source:** locked by queue requirement and docs/loop/LOOP.md

## D2: Preserve platform and real-state boundaries
- **Question:** What may executable acceptance access?
- **Options:** Real user homes/provider accounts; isolated homes and controlled providers with actual paired-owner transport.
- **Chose:** Private HOME/QUIRKY_HOME/process scopes; controlled provider executables and fresh pairing/registered workspace bindings. No real credentials, native OS acceptance, paid-provider claim or cross-platform support inference. All checks use canonical suite placement; local build/typecheck and isolated browser surface operation remain separate evidence.
- **Why:** Locked loop safety rules and predecessor platform exclusions apply unchanged.
- **Evidence:** docs/loop/LOOP.md Hard rules; predecessor D4; claimed queue title.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A scenario cannot be exercised without external credentials or native-only interaction.
- **Source:** locked by docs/loop/LOOP.md; deferred: platform

## D3: Repair the demonstrated feature producers, not authority guards
- **Question:** What remains after the predecessor's final helper/compiler corrections?
- **Options:** Restore the old eight-file failure inventory; weaken safety assertions; trace the current three failed paths.
- **Chose:** Fresh owning suite reports68/71 files passing, three failing. Preserve a restored valid draft agent through target validation; read the owner archive's latest prompt (with latest user-preview fallback); forward the reported transcript path inside the target owner's schema-declared source object. A replacement connected instance on the same pinned host/worktree marks the old mirror stale, without retargeting it.
- **Why:** Current exact failures were saved Codex becoming Claude, archive prompt becoming null and caller-only transcript path becoming none. Target-side containment remains the authority, never caller path existence. An initial misplaced top-level reportedPath was rejected by schema; the corrected nested producer preserves that schema.
- **Evidence:** Initial canonical71file suite68pass3fail158.40s; follow-on targeted4file outputs; service.ts ownerProbe/source parser and probeFor; window/model.ts openSource/refreshTargetAgents; owners.ts resolveWorkspace; existing no-spawn/redaction regressions.
- **Reversibility:** easy
- **Confidence:** high for observed source paths; complete acceptance still pending
- **Revisit if:** Final owning suites or actual paired-owner surface identifies another producer discrepancy.
- **Source:** assumed — autonomous, evidenced repair

## D4: Correct filtered fixtures and discard serialized error wording mirrors
- **Question:** Which newly reached assertions reveal fixture errors rather than production defects?
- **Options:** Change the scanner to ignore requested agents; serialize Error.message specially; fix the caller and keep semantic refusal checks.
- **Chose:** Include Codex in the archive list request before looking for its Codex fixture. Delete the JSON-stringified error wording regex for rejected phone registration, retaining rejection, unchanged owner registry and no new agent process.
- **Why:** A Claude-only list cannot contain Codex; standard Error.message is not enumerable. Neither observation justifies changing production discovery or error encoding.
- **Evidence:** Vault owner-host failures at706 and804 after initial prompt assertion passed; retained next authority/instance tests.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A semantic refusal or unfiltered discovery regression fails.
- **Source:** assumed — autonomous; locked by engineering prohibition on incidental wording/implementation mirrors

## D5: Exercise resume with a real PTY and the correct fixture environment
- **Question:** Why did the newly reached physical resume wait never observe an executable start?
- **Options:** Increase its15second deadline; treat a recorded fake create request as a process; execute the controlled provider on a real PTY.
- **Chose:** Switch only ownerA to the real in-process PTY server before resume. Preserve actual start/cwd/HOME/resume-argv and no-other-host launch assertions. Stop the physical server on both failure cleanup and the explicit owner restart. Apply ownerA's process environment around this physical launch, restoring it in finally. Capture only the named dummy owner secret from the actual provider launcher in a separate private observation file.
- **Why:** startFakePtyHost records create requests but never executes them. All three fixture kernels share process.env, which otherwise remained ownerB's. The shared fake agent intentionally logs a small env allowlist that excludes the dummy secret; changing production transport or the shared logger would fix neither fixture boundary.
- **Evidence:** Owning83file output82pass1fail at restart wait; physical replacement reaches149assertions and exposes wrong HOME, then150assertions exposes missing whitelist observation; test-owned launcher records the real variable, not a synthesized start.
- **Reversibility:** easy
- **Confidence:** high for demonstrated fixture boundaries; final acceptance pending
- **Revisit if:** Real PTY cleanup or final resume/restart assertions fail.
- **Source:** assumed — autonomous, source-proven fixture correction

## D6: Keep visible browser outcomes and physical byte evidence distinct
- **Question:** What do actual paired-owner UI scenarios establish beyond renderer-model tests?
- **Options:** Infer delivery from closing a dialog; infer source identity from a provider ID; operate the actual built UI and separately read controlled executable input logs.
- **Chose:** Actual private paired-daemon web runs. Accounts/Usage remote focus25→65, disabled remote sign-in, remote-only selection and local return are visible. Fresh final-source archive review contains the latest owner prompt, preserves nondefault Goose across close/reopen and launches on the exact remote workspace. Live-source review shows the different-owner warning and one synthetic secret marker; Start leaves the original Claude running with a lineage badge. Separate physical logs show each reviewed body plus locked notice in exactly one bracketed paste followed by one submit on the correct remote executable, and no input/exit on the original local source.
- **Why:** Remote Read Screen shows a non-echoing controlled program's Ready output, not its received input. Physical byte proof must not be attributed to that screenshot. Initial pre-final-runtime archive goal was explicitly partial and repeated against fresh source rather than relabeled passed.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261029T061653-b7cf (Accounts pass, initial archive partial);20261029T062647-d13e (archive and live cross-host goals pass); ignored notes session-owner-repair-evidence/{physical.json,physical-logs.tar.gz}. Doctor pin0.1.22 ready; no test overrides, console errors or network failures. Opacity visibility finding is the xterm hidden textarea; visible canvas context menu succeeds. CodeMirror value-only observation was too narrow; screenshot/tree show the edit and subsequent tree-based edit is OBSERVED.
- **Reversibility:** easy
- **Confidence:** high for exercised private real-transport/PTY paths; not real paid-provider/native OS acceptance
- **Revisit if:** Current-source composition changes the observed source or destination path.
- **Source:** assumed — autonomous; locked by queue associated actual-owner UI requirement

## D7: Preserve the incoming frozen API contract during the single catch-up
- **Question:** Does API1.0's executing-host declaration gate conflict with these owner feature repairs?
- **Options:** Bypass version checks for fixtures or built-ins; retain the explicit migrated declarations and current host compatibility checks.
- **Chose:** The sole clean roadmap merge brings140files including m7-api-freeze. Read D1–D25 and raw Progress in full. Required stable apiVersion floors, separate wire/catalog domains, CLI/UI per-module gating, existing lifecycle disposal and explicit sample-distro behavior remain unchanged. No conflicting owner/feature decision and no declaration shim is required.
- **Why:** This repair changes feature producers/fixture observation, not exported author contracts; built-ins and the shared writePlugin helper migrated with the incoming owner. D24's no-extra-campaign rule is respected: already requested owner acceptance and actual UI evidence stay bounded; no model review or unrelated sweep is added.
- **Evidence:** source commitdb87497b; actual clean git merge build/roadmap output; incoming m7-api-freeze D2–D4/D8/D14/D16/D24; caught-up root typecheck plus actual UI build exit0/32.05s. Fresh caught-up owning83file suite launched separately.
- **Reversibility:** easy
- **Confidence:** high for read contracts and compiler/build gate; final suite result pending
- **Revisit if:** Canonical landing rejects a merged type or declaration.
- **Source:** locked by incoming m7-api-freeze decisions and queue repair scope

## D8: Close acceptance with current owning checks, not the historical failure list
- **Question:** What evidence closes this repair item without a new review/debug campaign?
- **Options:** Reuse the predecessor's stale71file report; infer all repository tests pass; report current bounded owning acceptance and actual surface evidence.
- **Chose:** Final caught-up Accounts/Vault/Handoff plus scripts suite passes83/83 files with no failures/flakes in169.62s. Remove incidental newly added request-count/forwarded-tuple assertions while retaining delayed validation, valid/invalid saved-agent selection and no Start side effect while loading; final two affected UI files pass2/2/no flakes14.90s. Final root typecheck passes31.79s (UI lint, root/mobile/prepared desktop); caught-up actual UI build passed with11host files/26plugin modules. No production change follows those checks.
- **Why:** All three original current failures and subsequent newly reachable fixture boundaries are exercised. No timeout was increased, assertion was repinned, authority weakened or uncertainty hidden. API/CLI real owner routing and physical resume/restart assertions remain in the owning suite. Actual web/physical proof is bounded separately in D6.
- **Evidence:** canonical suite outputs83/83 premerge166.61s and caught-up169.62s, final2/2 UI14.90s, final typecheck31.79s; D6 reports and exact archived physical logs; source commitdb87497b. Existing historical predecessor failure receipt is not overwritten.
- **Reversibility:** easy
- **Confidence:** high for exercised feature/fixture boundaries; no full-repository/native OS/paid-provider/all-platform acceptance claim
- **Revisit if:** Canonical merged-result gate identifies a type or integration failure.
- **Source:** locked by queue repair acceptance and evidence requirements

## Progress
All requested repairs, owning acceptance, actual owner UI scenarios, physical delivery evidence and public documentation are complete. Source commitdb87497b plus sole clean140file roadmap catch-up; incoming API-freeze decisions fully read, no conflict. Caught-up owning83/83 files169.62s and final cleaned UI2/2 files14.90s/no flakes; final root typecheck31.79s and caught-up actual UI build pass. Both web reports kept_open[]/cleanup_errors[]/overrides[] and both private daemon/PTY services exited0 after scope cleanup; all implementers/checks returned. No extra review campaign or successor. Next: commit final receipt/test-only cleanup, detach and canonical land exactly this item; await actual receipt before ending, then remove only the archived owned /tmp scratch.
