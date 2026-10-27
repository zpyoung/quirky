# fix-flaky-quirky-git-files-scenarios decisions

## D1: Diagnose the recorded load failure without expanding feature scope
- **Question:** Which workflow and acceptance applies to this fix item?
- **Options:** Rebuild Git file features; trace and repair the recorded scenario flake.
- **Chose:** Trace the scenario and reproduce under owned CPU load before a minimal repair.
- **Why:** The queue explicitly identifies repeated under-load failures followed by isolated passes. Fix items skip brainstorming/specs.
- **Evidence:** docs/loop/LOOP.md:188-200; shared build-loop/flakes.log lists files.test.ts on 2026-10-27 at 13:38, 13:47, 14:53 and 15:28 UTC; the log contains file names only, not assertion output.
- **Reversibility:** easy (test/runtime repair only)
- **Confidence:** high
- **Revisit if:** Reproduction identifies an unrelated feature contract problem.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use a reachable cross-family reviewer
- **Question:** Which reviewer can independently review the OpenAI implementation?
- **Options:** Opus via pi-watch; next authenticated cross-family alias.
- **Chose:** Preflight cross-family aliases; Opus is unavailable on this machine.
- **Why:** `pi-watch --check opus` exited 5, with zero authenticated/shipping combinations. No login changes are permitted or necessary.
- **Evidence:** Lane 10 iteration 3 tool output; skill://pi-dev.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A cross-family alias becomes reachable.
- **Source:** assumed — autonomous

## Progress
Claimed on lane 10; clean branch created from build/roadmap. Read-only scout is tracing Git scenarios. Next: capture actual failure output under owned CPU contention, test one root-cause hypothesis, then implement minimal repair. No fix or reproduction has been claimed yet.
