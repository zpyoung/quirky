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

## Progress
Implemented regression-first on baseline 5526c9e5c466ab46106c7c295ff43e5dc6cd0a30. Loaded RED failed with Expected 1 Received 3 (20 bounded burners, 10 cores, load average rising to 36.5). Agent then added authenticated token/version/PID retirement identities local to establish(). Loaded GREEN ran the entire PTY client test file: 10 pass, 0 fail, 53 assertions in 28.04 s; observed machine load average 54.6 to 126.2, so this is evidence under load, not an assertion of a controlled exact load. All load workers settled and were cleaned. Existing silent-host scenario is strengthened with an explicit replacement-start gate and successful replacement list request; its one-shutdown and five-second bounds remain. No unrelated files edited. Next: commit, catch up once with build/roadmap, read incoming decisions, actual daemon/real PTY smoke, scoped daemon+PTY-host suites, scripts and typecheck, final Gemini review, then canonical land.
