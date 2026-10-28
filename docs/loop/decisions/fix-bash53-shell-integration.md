# fix-bash53-shell-integration decisions

## D1: Repair the existing Bash lifecycle wrapper without changing its public protocol
- **Question:** What scope does the fix item authorize, and which workflow applies?
- **Options:** Repair Bash empty-command detection and version coverage; redesign shell lifecycle reporting.
- **Chose:** Repair the existing wrapper and exercise Bash 5.2 and 5.3; use the fix-item debugging/TDD path without feature specs.
- **Why:** The queue identifies a precise extra OSC 133 completion on Bash 5.3 after an empty input line. Shell readiness, cwd and command status remain the existing contract. The reported failure is accepted as evidence, not rerun merely to confirm.
- **Evidence:** Canonical queue item fix-bash53-shell-integration; docs/loop/LOOP.md Fix items; packages/daemon/src/launch.ts BASH_INTEGRATION; packages/daemon/test/shell-path.test.ts shell integration.
- **Reversibility:** easy (private wrapper and regression coverage)
- **Confidence:** high
- **Revisit if:** Root-cause evidence requires a public API change.
- **Source:** locked by docs/loop/LOOP.md

## D2: Compile both GNU Bash releases into disposable macOS prefixes
- **Question:** How can both requested versions be exercised without changing the machine's installed shell?
- **Options:** Install a global shell; use temporary source builds; rely on an unverified remote runtime.
- **Chose:** Compile official GNU Bash 5.2 and 5.3 into owned temporary prefixes and run the real PTY regression against both.
- **Why:** The current system Bash is 3.2 and /opt/homebrew/bin/bash is absent. Disposable builds provide direct version evidence without changing user shell configuration or real application state.
- **Evidence:** Local bash --version and /bin/bash --version report 3.2.57; /opt/homebrew/bin/bash invocation reports command not found; cc and make are available.
- **Reversibility:** easy (temporary binaries only)
- **Confidence:** high
- **Revisit if:** Official sources cannot compile on this macOS host.
- **Source:** assumed — autonomous

## D3: Make the two-version matrix explicit and fail when either runtime is missing or misidentified
- **Question:** How does coverage stop depending silently on whatever /bin/bash a host provides?
- **Options:** Replace /bin/bash globally; skip unavailable versions in the ordinary suite; add a strict explicit matrix command.
- **Chose:** `bun run test:bash -- <bash-5.2-path> <bash-5.3-path>` validates both major/minor versions, then runs the actual Bash shell-session and PTY integration tests under each with `QUIRKY_TEST_BASH`. The ordinary suite keeps its system-shell coverage.
- **Why:** The suite transports tests but does not provision Bash versions. Explicit paths and a failing prerequisite check make a successful matrix run evidence for both requested versions, without a machine-level installation or silent skip.
- **Evidence:** scripts/test-bash-versions.ts; package.json test:bash; packages/daemon/test/shell-path.test.ts. Actual isolated matrix on GNU5.2.0 and5.3.20: each9pass/0fail/21assertions; no hook fix has been applied yet.
- **Reversibility:** easy (test-only runner and environment selection)
- **Confidence:** high
- **Revisit if:** A standard CI provisioner supplies a native version matrix.
- **Source:** assumed — autonomous

## D4: Keep the reported failure authoritative while investigating its missing local trigger
- **Question:** How should passing local boundary probes affect the user-reported Bash5.3 defect?
- **Options:** Dismiss the report; apply a speculative history guard; investigate the hook boundary and retain the evidence mismatch.
- **Chose:** Retain the report and investigate before changing production. New behavioral probes cover blanks, whitespace, comments, duplicate/compound commands, ignored history and disabled history. None has failed on these stock macOS5.3 builds yet.
- **Why:** A history-number fix would silently omit legitimate commands when history is disabled or ignores a command. A passing local probe does not refute the observed remote/Homebrew failure.
- **Evidence:** New boundary regressions passed on GNU5.3.0 and5.3.20; diagnostic hook traces show literal __quirky_prompt at the blank-input boundary on this host. Official GNU5.3patches001–020 were applied to produce5.3.20. First full-file runner attempt timed out180s, not a pass; the corrected Bash-only matrix with the known-good process PATH passed.
- **Reversibility:** easy
- **Confidence:** high (observations), unresolved (missing trigger)
- **Revisit if:** A diagnostic identifies the failing prompt/trap state.
- **Source:** assumed — autonomous

## D5: Exclude inherited DEBUG events from Quirky's prompt helpers, not from history
- **Question:** What concrete state transition can classify an empty submission as a completed command?
- **Options:** Compare history numbers; snapshot BASH_COMMAND into a trap argument; replace the latch with PS0; exclude internal helper frames.
- **Chose:** Before testing the armed latch, ignore DEBUG events whose immediate caller is __quirky_prompt, __quirky_arm or __quirky_histnum. Keep the existing filter for the outer __quirky_prompt call and leave the user-owned DEBUG fallback unchanged.
- **Why:** With `set -T`, DEBUG is inherited inside shell functions. __quirky_arm arms before its remaining statements; their inherited DEBUG event sets ran even though no user command ran. __quirky_prompt's body can also trip the latch before disarming. Both prompt and arm frames must be excluded. This fix neither depends on history nor suppresses real user functions. PS0 cannot cover system Bash3.2 and a promptvars-disabled PS0 latch fails; trap-argument snapshots did not fix the reproduced defect.
- **Evidence:** Uninstrumented diagnostic arm-probe.ts reproduced a first blank completion[0] on GNU5.3.0/5.2.0/system3.2 with functrace; prompt-only exclusion still failed, prompt-plus-arm exclusion passed. Permanent functrace PTY regression failed before at a phantom first-prompt command-start (expected0, received1) on5.3.20; after the helper-frame guard it passed1test/15assertions. GNU bashref.texi documents DEBUG inheritance under functrace. Exact original version-only environment remains unidentified, as D4 records.
- **Reversibility:** easy (four private wrapper lines)
- **Confidence:** high (independently reproduced hook defect); unresolved (original version-only trigger)
- **Revisit if:** The originating environment still reports a completion for blank input after this fix.
- **Source:** assumed — autonomous

## D6: Verify actual PTY behavior on both versions and preserve system-shell coverage
- **Question:** What execution evidence establishes the repaired lifecycle and version coverage?
- **Options:** Only assert generated source text; only run the system Bash; run a strict matrix and separate live PTY smoke.
- **Chose:** GNU5.2.0 and5.3.20 strict matrix plus an uninstrumented throwaway live-shell scenario in plain and functrace modes; retain ordinary system Bash3.2/zsh tests.
- **Why:** The observable contract is readiness once, no starts/completions on empty/whitespace/comment input, one start/completion per real command even with ignored/disabled history, cwd tracking, and the actual shell exit status. A real PTY exercises parsing and hook inheritance instead of echoing implementation details.
- **Evidence:** Final matrix each10pass/0fail/36assertions; system shell-path file25pass/0fail/70assertions. Separate four-way real-PTY smoke observed statuses[0,1,1,1,0,7,0],7command starts,1ready marker,cwd sub,exit3 in each mode/version. A wrong5.3 binary (5.2 supplied twice) was rejected with exit1. Every runtime used disposable homes and process-scope cleanup.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** CI gains a shared Bash-version provisioner, or the original environment still differs.
- **Source:** assumed — autonomous

## Progress
Source fix, permanent behavioral regressions and strict two-version runner are implemented. Failing-before/passing-after functrace regression and actual5.2.0/5.3.20 live smoke are recorded in D5–D6; original version-only trigger is not claimed proven. README documents mandatory matrix for shell-integration edits. BashFixReview is reviewing the narrow patch; next run affected daemon/PTY/terminal/consumer suites, scripts/typecheck, catch up, commit evidence and canonical queue-controlled landing. No UI surface changed, so no UI dogfood/native handoff is needed. Preserve untracked .serena metadata untouched.
