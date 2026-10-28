# m7-sweep-terminal decisions

## D1: Audit all nine docs; preserve explicit exclusions
- **Question:** What does the terminal parity sweep include?
- **Options:** Rebuild every original feature; audit shipped features and close bounded gaps; inspect only known blockers.
- **Chose:** Audit every flow and defect in ask.md, cli.md, agent-status.md, launch-settings.md, notifications.md, providers.md, term-daemon.md, term-ui.md and worktrees.md; implement bounded missing behavior and record larger gaps in one dependent follow-up.
- **Why:** The item explicitly requests every remaining flow, including omissions and deferrals, while permitting follow-up items for larger work. Do not claim an audit is runtime proof.
- **Evidence:** queue.ts wait --lane 7 returned m7-sweep-terminal; docs/roadmap.md:13-55; canonical docs/loop/LOOP.md night-mode rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A flow cannot be assigned to shipped evidence, a fix or a named follow-up.
- **Source:** locked by docs/roadmap.md

## D2: Use unattended night-mode workflow and autonomous defaults
- **Question:** How are skill questions and breadth handled without a person?
- **Options:** Ask and wait; silently omit ambiguous flows; choose documented/recommended defaults and record them.
- **Chose:** No human prompts, no external research swarms, standard gray areas, markdown logic spec with final technical section, contracts before implementers, at most three implementers, one final review and one catch-up. Use source docs and prior decisions for observable behavior; fail closed on unsupported targets and permissions.
- **Why:** Canonical LOOP.md explicitly supplies the unattended and night-mode overrides. Audit scouts map repository evidence, not external research options.
- **Evidence:** Canonical git show build/roadmap:docs/loop/LOOP.md; claim at 2026-10-28 01:56 CDT.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A locked decision conflicts with core requirements.
- **Source:** locked by docs/loop/LOOP.md

## D3: Use OpenAI implementers and reachable Gemini reviewer
- **Question:** Which cross-family implementation/review pair is available?
- **Options:** omp task + opus; omp task + sonnet; omp task + gemini; same-family fallback.
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Review has not yet run.
- **Why:** pi-watch --check resolved Gemini google/gemini-3.1-pro-preview:high; opus and sonnet have no authed/shipping models. Prefer reachable cross-family review to a knowingly unavailable backend.
- **Evidence:** Scratch /tmp/quirky-m7-sweep-terminal-lane7.KpyVcb; pi-watch --check output, exit5 because5 unavailable aliases; codex/terra/gemini/flash available.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual review dispatch fails; availability is not review assurance.
- **Source:** assumed — autonomous

## D4: Preserve inherited untracked files without staging them
- **Question:** How should inherited dirt be handled?
- **Options:** Commit it; stash/remove it; leave unrelated untracked files untouched and use isolated component trees.
- **Chose:** Preserve .serena/, test.ts and test-migrated.test.ts unstaged. All implementation work uses separately scoped component worktrees.
- **Why:** Previous iteration identifies these as user/inherited state. No tracked edits existed on orientation. They must not enter the product diff or be destroyed.
- **Evidence:** Initial git status --short --branch; lane7 iteration7 notes.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An inherited file blocks a required command.
- **Source:** assumed — autonomous

## Progress
Claimed and created build/m7-sweep-terminal. Step3 audit in progress: three read-only scouts cover ask/cli/notifications, status/launch/providers, and daemon/UI/worktrees respectively. No implementation or verification claimed. Scratch /tmp/quirky-m7-sweep-terminal-lane7.KpyVcb. Next: synthesize full parity matrix, lock bounded contracts in logic.md, commit then dispatch at most three independent implementers.
