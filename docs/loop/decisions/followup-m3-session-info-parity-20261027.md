# followup-m3-session-info-parity-20261027 decisions

## D1: Complete only the registered parity boundaries
- **Question:** Purpose, consumer, success criteria, scope and primary behavior (brainstorming essential coverage).
- **Options:** Rebuild Session Info; verify/fix the named boundary flows; broaden into Source Control.
- **Chose:** Named clipboard/denial/focus/scroll/flash/reveal, narrow layout, and NA-29 investigation only; inherit original public APIs and behavior.
- **Why:** m3-session-info D32 explicitly registered this follow-up; adjacent flows belong to other items.
- **Evidence:** docs/loop/BLOCKERS.md m3-session-info section; docs/loop/decisions/m3-session-info.md D32; external session-info.md flows2–3.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An exercised boundary requires a locked contract change.
- **Source:** locked by docs/loop/decisions/m3-session-info.md

## D2: Separate native delivery from browser feedback
- **Question:** What evidence closes clipboard, focus and Finder parity without native automation?
- **Options:** Claim web checks prove native outcomes; run forbidden foreground checks; preserve nightly evidence and complete native handoff.
- **Chose:** Preserve existing native SC-5 pass and SC-7/9 blocked results. Web checks cover actual permission rejection and narrow control behavior; native transient/denial/OS focus/flash/Finder effects remain explicit nightly scenarios.
- **Why:** LOOP.md forbids native surfaces here and expressly allows pending native-only scenarios. The existing report proves clipboard contents but not the short Copied label or certified focus/reveal.
- **Evidence:** docs/loop/native/m3-session-info.json; /Users/zpyoung/orca/workspaces/quirky/native-qa/.quirk/using-apps-like-a-user/runs/20261028T050836-d7f3/report.md; docs/loop/NATIVE.md scenario format.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The nightly run reports a product failure.
- **Source:** locked by docs/loop/LOOP.md

## D3: Audit supported narrow panels without inventing hidden-action fallbacks
- **Question:** Visual density, layout, errors, interaction and remaining gray areas (brainstorming).
- **Options:** Hide actions at narrow widths; horizontal scroll; wrap values/actions with vertical scrolling and existing overflow navigation.
- **Chose:** Preserve all available actions, accessible names and normal keyboard navigation; audit280px panel and240px stress where available. Long IDs/paths wrap. Fix only observed clipping/reachability defects. Do not stretch1.5s Copied feedback for the sampler.
- **Why:** Existing panel wraps actions and scrolls; no evidence justifies a second layout system. m3-session-info D21 distinguishes sampler limits from behavior.
- **Evidence:** plugins/quirky.session-info/src/window/SessionInfoPanel.tsx:20-23,78-108; docs/loop/decisions/m3-session-info.md D2/D21/D25.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** Actual built-app narrow checks expose clipping or inaccessible controls.
- **Source:** assumed — autonomous

## D4: Establish signal readiness before changing timeout behavior
- **Question:** Does the311ms result establish broken two-second SIGKILL grace?
- **Options:** Change production deadlines; weaken elapsed/cleanup checks; discriminate fixture startup from ready-group shutdown.
- **Chose:** Keep production grace, timeout classification and descendant cleanup. Probe deliberately delayed versus ready TERM-resistant fixtures, then retain a meaningful readiness-aware regression if the fixture is wrong. Do not rerun the known failure merely to confirm it.
- **Why:** The300ms timer starts at spawn, before the fake necessarily executes trap or records its child. The raw original file is unavailable; the summary alone cannot establish the failing lifecycle edge.
- **Evidence:** plugins/quirky.agents/test/generate.test.ts:332-343; plugins/quirky.agents/src/one-shot-run.ts:119-125,154-172; docs/loop/BLOCKERS.md original NA-29 evidence.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** A positively ready resistant group settles before grace or leaves live descendants.
- **Source:** assumed — autonomous

## D5: Use unattended one-spec execution and cross-family review
- **Question:** Skill questions, spec approval, execution pairing, dirty tree and platform scope.
- **Options:** Human questions/research swarms; LOOP.md autonomous recommended defaults.
- **Chose:** Standard relevant Visual/CLI/Integration gray areas resolved in D1–4; markdown combined logic/technical spec self-reviewed before code. IMPLEMENTER=omp-task; AUTHOR_FAMILY=openai; REVIEWER_ALIAS=gemini; at most3implementers. Leave inherited untracked .serena/ untouched/excluded. No global state, native foreground or protected-loop edits.
- **Why:** Current LOOP.md overrides skill human gates/spec split/research swarms. Opus probe returned0/8; Gemini probe verified google/gemini-3.1-pro-preview:high. Web doctor ready with playwright-cli0.1.22.
- **Evidence:** Current authoritative LOOP read via git show build/roadmap:docs/loop/LOOP.md; preflight tool output2026-10-28; spec docs/quirk/specs/2026-10-28-followup-m3-session-info-parity-20261027/logic.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Reviewer dispatch or web driver actually fails.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Scoped and self-reviewed combined spec; no implementation changes yet. Read-only scouts completed evidence mapping. Next: commit specification/contracts, discriminate NA-29 readiness, audit actual built narrow UI with private fake-provider daemon, record native handoff, focused checks then required gates/catchup/review/queue land. No pass claim from source inspection alone.
