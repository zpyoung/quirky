# fix-flaky-daemon-pty-client decisions

## D1: Diagnose retirement before changing the shutdown-count assertion
- **Question:** whether a repeated shutdown to the same silent old host is valid or a replacement race (systematic-debugging phase 1)
- **Options:** weaken the count assertion; diagnose the connect/retire/startup sequence and preserve the intended behavior
- **Chose:** diagnose the sequence, reproduce the scheduling gap deterministically and under bounded CPU load, then fix the demonstrated cause
- **Why:** the queue item reports two shutdowns under load even alone; this is authoritative failure evidence, not permission to re-pin an incidental count
- **Evidence:** queue item title; packages/daemon/test/pty-client.test.ts:203-215; m1-term-daemon D17
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** evidence proves repeated retirement is required for safe replacement
- **Source:** assumed — autonomous

## D2: Retain the locked older-retire/newer-refuse upgrade policy
- **Question:** whether to alter protocol upgrade policy while fixing the race
- **Options:** replace every mismatch; use side-by-side version endpoints; preserve older retirement and newer refusal
- **Chose:** preserve older retirement and newer refusal, scoped to connection/replacement behavior only
- **Why:** existing decision D17 binds this fix; the failure concerns scheduling, not protocol policy
- **Evidence:** docs/loop/decisions/m1-term-daemon.md:165-174
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a released protocol needs an explicit adoption policy
- **Source:** locked by docs/loop/decisions/m1-term-daemon.md

## D3: Use Gemini for the final cross-family review because Claude reviewers are unavailable
- **Question:** final review model pairing on an omp lane
- **Options:** Opus; Sonnet fallback; Gemini fallback; same-family review
- **Chose:** OpenAI implementation and Google Gemini final review through pi-watch
- **Why:** pi-watch --check opus and --check sonnet exited 5 with no authed/shipping model; --check gemini resolved google/gemini-3.1-pro-preview:high with exit 0. Readiness is not a completed review.
- **Evidence:** iteration 9 preflight output; pi-dev alias contract
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the review dispatch cannot return a substantive result
- **Source:** assumed — autonomous

## D4: Deduplicate retirement by authenticated incarnation within each establishment attempt
- **Question:** whether the duplicate shutdown is an allowed retry or a real startup race (systematic-debugging phases 2–3)
- **Options:** loosen the count; sleep longer before retries; remember a version globally; scope authenticated token/version/PID identities to one establishment attempt
- **Chose:** per-establishment authenticated incarnation bookkeeping; continue current-protocol probes while the replacement starts
- **Why:** `establish` starts one detached child without readiness acknowledgement and retries every 100 ms. Every old-protocol rejection re-enters `retireHost`. The 100 ms retirement timeout destroys only the client connection, so the old listener still accepts the next retry. A gated replacement held through four current-protocol probes reproduced three shutdowns instead of one under 20 bounded CPU burners on 10 cores (load average 25.1 before, 36.5 after). This is a real repeated-retirement race, not an overly strict count assertion.
- **Evidence:** packages/daemon/src/pty-client.ts:295-315,336-377,497-507; packages/daemon/test/pty-client.test.ts:212-243; isolated loaded RED run: exit 1, 0 pass, 1 fail, Expected 1 Received 3 at line 227; /tmp/quirky-pty-retire-lane7.0v0nj1/red.log
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a host can legitimately reuse the complete token/version/PID identity during the same attempt
- **Source:** assumed — autonomous

## D5: Verify the internal race through a real daemon API and replacement PTY, without UI or native claims
- **Question:** which smoke covers this internal connection change without inventing visible scenarios?
- **Options:** tests only; unrelated browser dogfood; real delayed host replacement followed by daemon API and actual shell output
- **Chose:** start a daemon with a fresh temporary HOME/QUIRKY_HOME, a silent older-protocol listener, and a gated real quirky-pty executable. Hold startup through three current-protocol probes, then release it; query `status.get`, create and subscribe to a real PTY, verify its output marker and exit code 3.
- **Why:** this exercises `PtyClient.establish` through actual daemon startup and actual detached host execution. The smoke observed one shutdown before release, a distinct live host PID matching `pty.pid`, real shell output and exit 3, and one shutdown total through five probes. No UI scenario was added or changed, so web/native dogfood is not applicable.
- **Evidence:** iteration 9 smoke command `bun /tmp/quirky-pty-retire-lane7.0v0nj1/smoke.ts`, exit 0 in 10.67 s; `RETIREMENT_BEFORE_RELEASE {shutdowns:1,probes:3}`; `DAEMON_API_STATUS` host alive with distinct PID; `REAL_PTY_OUTPUT {marker:true,exit:3,shutdowns:1,probes:5}`; `SMOKE_CLEANED true`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a visible upgrade-status or native behavior is added
- **Source:** assumed — autonomous

## D6: Catch up once and retain incoming Hosting policy unchanged
- **Question:** whether newly landed decisions conflict with the connection repair
- **Options:** diverge; change Hosting contracts; retain all incoming decisions and the narrow retirement fix
- **Chose:** merge build/roadmap once after source commit 02ff379b; read all of m7-sweep-hosting D1–D12; no conflicting PTY/retirement decision found
- **Why:** the incoming work changes Hosting batching, Project issue-type ownership, and Review browser routing, not the PTY upgrade contract. No loop infrastructure or generated queue/index files were edited manually.
- **Evidence:** merge output and docs/loop/decisions/m7-sweep-hosting.md:1-136
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** merged landing verification exposes a concrete integration conflict
- **Source:** locked by docs/loop/LOOP.md

## D7: Accept the substantive Gemini review without treating its timing estimate as evidence
- **Question:** what did the single final cross-family review establish?
- **Options:** treat model readiness as review; accept all narrative claims; record the actual focused result and retain measured verification
- **Chose:** completed one read-only Gemini high review through pi-watch; it returned `STATUS: PASS` with no concrete introduced correctness, race, cleanup, security or test-reliability findings
- **Why:** the reviewer read the client, gated fixture and tests and inspected host references. Its statement of “<500 ms real execution time” is an unmeasured estimate, not adopted: the loaded full-file run actually took 28.04 seconds. Passing stress/smoke evidence, not model timing prose, supports the repair.
- **Evidence:** bg_4 exit 0 in 247.62 s; google/gemini-3.1-pro-preview:high; required STATUS trailer verified; loaded GREEN and real smoke under D4/D5
- **Reversibility:** easy
- **Confidence:** high for the observed review result; bounded to this repair
- **Revisit if:** normal gates reveal a concrete defect or an independent reviewer supplies a reproducing interleaving
- **Source:** assumed — autonomous

## D8: Retain the scripts hook failure and run recovery without changing infrastructure
- **Question:** how to handle the first required scripts gate failing while the focused repair suites pass
- **Options:** suppress it; raise a timeout/change protected scripts; retain the failure and recover the unchanged gate after the stress/review work has settled
- **Chose:** retain the actual failure and run the unchanged scripts gate again with the same isolated HOME/QUIRKY_HOME; run typecheck separately because the failed `&&` chain never reached it
- **Why:** the first gate ended 67 pass/1 fail in 323.68 seconds: `cleanup stops the full process tree and guardian after caller-home removal` hit a beforeEach/afterEach hook timeout (14,182.55 ms test duration). That test imports process-scope only, not PtyClient. This identifies the failed boundary but does not prove load causality. No production policy, suite routing, retry configuration, hook timeout, assertion or protected infrastructure changed.
- **Evidence:** scripts/process-scope.test.ts:1-6,206-255,257-309; bg_2 exit 1; artifact://15 preserved in the local evidence archive. Separate bg_5 `bun run typecheck` exited 0 in 214.76 s, frozen install checked 596 installs/610 packages without changes and tsc emitted no diagnostics.
- **Reversibility:** easy
- **Confidence:** high for observed failure and independent compiler result; no claimed root cause for the hook timeout
- **Revisit if:** the unchanged scripts recovery or canonical merged gate fails again
- **Source:** assumed — autonomous

## D9: Let the canonical merged gate decide landing; do not relax protected scripts
- **Question:** the unchanged scripts recovery failed at different timeout boundaries
- **Options:** keep retrying worktree gates; alter protected test infrastructure; request the required canonical merged verification and accept only its successful result
- **Chose:** request normal `queue.ts land`, retaining both failed local scripts receipts and all measured passing repair evidence; do not mark the item complete unless the controller's complete merged gate succeeds. If the controller cannot verify it, preserve the repair and record the actual blocking prerequisite through the queue.
- **Why:** recovery ended 66 pass/2 fail in 507.37 s: `runFiles emits no profile rows when profiling is disabled` timed out at 5,011.61 ms; `batched land > leaves a waiting item that conflicts for its own lane` timed out at 39,015.24 ms against its 30,000 ms bound, reporting an empty `git rev-parse --absolute-git-dir` result after the timeout. The earlier process-scope hook did not fail on recovery. Different timed-out infrastructure paths do not justify changing product behavior, asserting a proven load cause, or weakening any gate. The canonical controller verifies a fresh merged result and owns whole-suite serialization.
- **Evidence:** bg_6 exit 1, artifact://19 preserved in the evidence archive; scoped daemon/PTY-host gate 89/89 files with `flaky:[]`; root compiler exit 0; loaded regression and actual daemon/PTY smoke under D4/D5
- **Reversibility:** easy
- **Confidence:** high for retained outcomes; no claim that scripts currently pass
- **Revisit if:** canonical merged verification fails
- **Source:** assumed — autonomous

## Progress
Repair implemented and committed as 02ff379b on baseline 5526c9e5c466ab46106c7c295ff43e5dc6cd0a30; one clean roadmap catchup brought m7-sweep-hosting D1–D12, all read without conflict. Loaded RED: Expected 1 Received 3; loaded GREEN full PTY-client file: 10 pass/0 fail/53 assertions. All 20 bounded load workers settled and cleaned. Actual daemon API plus detached real host/PTY smoke passed (one shutdown, real output, exit 3, owned home removed). Scoped daemon+PTY-host runner passed 89/89 files with no retries. Frozen-install root typecheck passed. One substantive Gemini high final review returned PASS/no concrete findings; no second review round or unclosed review findings. Required local scripts gate FAILED twice at different infrastructure timeout boundaries; retained under D8/D9, not relabeled green. No timeout, assertion, retry, loop infrastructure or protected script changed. Next: commit final evidence, detach, request canonical queue.ts land and wait for its actual full merged suite/scripts/typecheck result. Only successful canonical landing completes the item; otherwise resolve a concrete reachable failure or block with exact evidence. User-owned untracked .serena/, test.ts and test-migrated.test.ts remain untouched.
