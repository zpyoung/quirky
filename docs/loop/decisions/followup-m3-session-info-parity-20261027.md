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
- **Chose:** Preserve all available actions, accessible names and normal keyboard navigation; audit280/240px and actual220px supported minimum. Long IDs/paths wrap. Fix only observed clipping/reachability defects. Do not stretch1.5s Copied feedback for the sampler.
- **Why:** Existing panel wraps actions and scrolls; no evidence justifies a second layout system. m3-session-info D21 distinguishes sampler limits from behavior.
- **Evidence:** plugins/quirky.session-info/src/window/SessionInfoPanel.tsx:20-23,78-108; packages/ui/src/App.tsx:169-180; docs/loop/decisions/m3-session-info.md D2/D21/D25.
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

## D6: Correct the SIGTERM test's unproved readiness precondition
- **Question:** Did the local311ms result prove production's two-second grace was wrong?
- **Options:** Change production cleanup; retain a startup-speed assumption; establish a ready resistant group.
- **Chose:** Production unchanged. The existing public daemon test now uses a3s natural deadline, publishes a ready marker after TERM-ignore/child setup, proves both processes live before completion, asserts timeout/Conflict and at least5s elapsed, then proves both gone. Its15s fixture budget includes the3s deadline+2s grace, startup and owned cleanup; no production deadline is widened.
- **Why:** Actual startOneShot diagnostic distinguished delayed initialization from a ready group. Delayed case timeout1200ms had no ready marker, settled1777.6ms and bothgone; ready case timeout3000ms became ready138.8ms, bothlive4810.6ms and settled5573.7ms with bothgone. Startup race explains the missing test precondition; original311ms exact cause remains inference because the old raw trace is unavailable.
- **Evidence:** Actual `bun .orca/loops/omp-until-done-50bc6f72/sigterm-parity-probe.ts` output before owned probe removal; parent `bun test plugins/quirky.agents/test/generate.test.ts -t 'ignores SIGTERM'` passed1test/6assertions in5.53s before the new operator directive. Source plugins/quirky.agents/test/generate.test.ts:332-362; runner unchanged.
- **Reversibility:** easy
- **Confidence:** high for observed ready-group behavior; medium for the historical startup-race explanation
- **Revisit if:** End-phase runs show a positively ready group settling before grace or retaining live descendants.
- **Source:** assumed — autonomous

## D7: Wrap inherited panel text instead of hiding narrow controls
- **Question:** What changes after the actual220px narrow-width audit?
- **Options:** Hide actions; add horizontal scrolling; inherit overflow-wrap:anywhere across panel text.
- **Chose:** One source property in SessionInfoPanel's root style. Existing row values already wrap and actions already wrap/scroll; inherited wrapping also covers unbroken error/model text.
- **Why:** The real web pass reached all five Identity actions by vertical scrolling and opened the captured transcript. The long stale-error path visibly clipped at the right edge (obs3/5). An outer panel scroll container, not the inner body's auto-height, correctly owns vertical scrolling; no shell layout change is needed.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261028T112829-d322/obs-3.png and obs-6.png; positive Open transcript obs-7.png; plugins/quirky.session-info/src/window/SessionInfoPanel.tsx:20. UI bundle rebuild passed after the property; post-fix visual verification was stopped by D8.
- **Reversibility:** easy
- **Confidence:** high for the observed clipping; post-fix visual outcome unverified
- **Revisit if:** End-phase narrow widths or long errors still overflow.
- **Source:** assumed — autonomous

## D8: Stop the verification campaign and land through typecheck only
- **Question:** The operator moved all testing/debugging to the end phase while this follow-up was in progress.
- **Options:** Continue old suite/dogfood/review gates; honor the new build-first rule.
- **Chose:** Stop immediately, close the owned browser/daemon, record partial evidence, commit current code/tests/native handoff, catch up once, typecheck and queue land. No follow-up item: all product flows already exist; remaining work is verification/debugging owned by the end phase.
- **Why:** New authoritative LOOP.md explicitly says in-progress items land now, typecheck is the only gate, failing tests are fine, and no new test/verify/review/debug follow-ups.
- **Evidence:** Operator interjection and `git show build/roadmap:docs/loop/LOOP.md` “Build first, test at the end.” Dogfood report .quirk/using-apps-like-a-user/runs/20261028T112829-d322/report.md records all4goals partial, no overrides. Before stop:220px values/actions wrap, vertical scroll/reveal reachability and Open transcript were observed; other widths, full history/focus matrix, recovery/consent, actual browser denial/copy, and post-wrap visual outcome are NOT passed. The attempted Cmd+R invoked the app's tab rename, not a reload, and is not evidence of updated assets.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The operator changes the end-phase policy.
- **Source:** locked by operator instruction and docs/loop/LOOP.md

## Verification already exercised before D8
- Actual ready-group diagnostic passed both cases; public NA-29 regression passed1test/6assertions. No production shutdown change.
- `bun run build` initially failed missing pngjs after switching to newer roadmap dependencies; `bun install --frozen-lockfile` installed2packages, then full production build packaged Quirky.app successfully. Only missing icon.iconset/unset release.baseUrl warnings. The later one-property wrapping change had a successful UI-only rebuild, not another full packaged build.
- No affected suite, scripts suite or review round was started. No full web/native pass is claimed. Existing native SC-5 pass and SC-7/9 blocked history remain untouched; two additional native feedback/denial scenarios are pending.
- Owned supplementary tab closed; official dogfood ended partial; owned UI daemon exited0 after SIGTERM with awaited harness cleanup. All throwaway runtime probes are removed before land.

## Progress
Operator build-first cutover: implementation is the narrow text-wrap fix, readiness-aware NA-29 regression and native handoff. Further verification stopped at D8; no unbuilt flow/follow-up item. Next: commit current work, merge roadmap once/read incoming decisions, make typecheck pass and land. Never claim the partial web campaign or unrun suites/review passed.
