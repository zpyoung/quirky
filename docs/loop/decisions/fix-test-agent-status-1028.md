# fix-test-agent-status-1028 decisions

## D1: Repair the assigned agent-status contracts without widening provider APIs
- **Question:** Which failures and verification belong to this end-phase fix?
- **Options:** Repin failed assertions; trace consumer behavior and repair its root cause; widen adjacent plugin APIs.
- **Chose:** Trace the six assigned failures, repair consumer-visible behavior, and delete incidental assertions rather than repinning them.
- **Why:** The queue names OSC session/turn ownership and the hooks switch lifecycle; tests must retain isolated homes and process cleanup.
- **Evidence:** docs/loop/reports/m7-test-triage.json; assigned queue item title; docs/loop/LOOP.md Fix items.
- **Reversibility:** easy (local repair)
- **Confidence:** high
- **Revisit if:** Evidence identifies an upstream contract owned by another repair.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use native task implementers and a reachable independent reviewer
- **Question:** Which backend pairing can run unattended on this omp lane?
- **Options:** omp task implementers with opus; next reachable cross-family reviewer; task reviewer fallback.
- **Chose:** omp task implementers (OpenAI family) and gemini (`google/gemini-3.1-pro-preview:high`) for final review.
- **Why:** `pi-watch --check opus` exited 5: no authed/shipping model among its eight candidates. The full ladder probe resolved gemini and flash as cross-family alternatives; no authentication changes are permitted.
- **Evidence:** This iteration's opus and full-alias preflight output.
- **Reversibility:** easy (review backend only)
- **Confidence:** high
- **Revisit if:** Another cross-family backend resolves.
- **Source:** assumed — autonomous

## D3: Assert absent OSC questions directly
- **Question:** Do the two OSC triage errors establish a production ownership defect?
- **Options:** Change the status model to store empty strings; coerce undefined into strings; assert the semantic absence of a question.
- **Chose:** Assert `question` is undefined after a replacement or new turn, preserving the existing prompt, detail, wrong-process and stale-event regressions.
- **Why:** The recorded error says containment requires strings or arrays. `AgentRow.question` can legitimately be absent, and the turn-fencing case already waits for that absence. A containment matcher on undefined is invalid; weakening production ownership fences would address the wrong problem.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.agent-status; plugins/quirky.agent-status/test/transcript-producers.test.ts:160-168,207-223.
- **Reversibility:** easy (test contract only)
- **Confidence:** high for the matcher defect; no production-fix claim
- **Revisit if:** Consumer-visible stale question state appears in the repaired checks.
- **Source:** assumed — autonomous

## D4: Retain the already-landed duplicate-key repair for hooks settings
- **Question:** Why did the baseline lose the canonical hooks setting, and does this item need another runtime change?
- **Options:** Rename the setting; add an alias or fallback; retain the existing manifest repair and verify the actual lifecycle.
- **Chose:** Retain the existing manifest repair in `d50e89de`; no new settings/runtime change.
- **Why:** Baseline `97aaa12d` declared two `contributes.setting` JSON keys: an earlier hooks-only array and a later dashboard-only array. JSON parsing retained the later array and omitted hooks. `d50e89de` removes the earlier duplicate key and adds hooks to the surviving array. Current registration accepts the locked canonical setting ID.
- **Evidence:** `git diff 97aaa12d..992d9e53 -- plugins/quirky.agent-status/quirky-plugin.json`; confirmed commit `d50e89de`; current manifest:1500-1518; packages/daemon/src/plugins/ui-service.ts:192-195.
- **Reversibility:** easy (no additional runtime patch)
- **Confidence:** high
- **Revisit if:** Canonical plugin checks identify any remaining hooks lifecycle failure.
- **Source:** locked by docs/loop/decisions/m1-agent-status.md D26

## D5: Exercise the public CLI in isolated plugin ownership
- **Question:** What runtime smoke proves the hook switch without launching real providers or reading OS credentials?
- **Options:** Start all built-ins; use the real status plugin and daemon with fixture dependencies; rely on assertions alone.
- **Chose:** Standalone script starts the real daemon/status plugin with only fixture session/worktree/agents/hosting dependencies, then drives actual `quirky` CLI commands.
- **Why:** This exercises install, disable/removal, refusal, hooks-disabled status, persisted restart, re-enable/reinstall and explicit removal without activating accounts, Keychain access, or provider sessions. Every child is process-scoped and homes are temporary.
- **Evidence:** `bun /tmp/quirky-agent-status-lane2-4YLv5c/smoke.ts` exit0/3.01s; `AGENT_STATUS_CLI_LIFECYCLE_OK`; `AGENT_STATUS_SMOKE_CLEANED true`.
- **Reversibility:** easy (throwaway verification script)
- **Confidence:** high for CLI/API behavior; no UI or native acceptance claim
- **Revisit if:** Full end-phase checks disagree.
- **Source:** assumed — autonomous

## Progress
Workers returned. OSC test-only repair committed as ab53523e; hook registration root cause already repaired by d50e89de. Isolated actual CLI lifecycle smoke passed and cleaned. No exported API or UI changes; existing hooks/OSC tests retained as regression coverage. Next: single roadmap catch-up, read incoming decisions, canonical plugin suite, scripts and typecheck, one final review, commit evidence and land. Inherited untracked .quirk/ and .serena/ retained untouched.
