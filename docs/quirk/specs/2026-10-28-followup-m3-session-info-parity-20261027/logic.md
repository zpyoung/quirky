# Session Info parity follow-up

## Status & amendments
Status: Approved autonomously under LOOP.md night mode; one combined logic/technical specification.

**Amendments:** 2026-10-28 — Initial follow-up specification; inherits m3-session-info SC-5/7/9 and the explicit D32 follow-up. Existing native results are preserved, not represented as fresh passes.

## Conceptual model and data flow
Session Info remains the built-in public-API consumer inspecting the focused terminal agent. This item verifies the remaining interaction boundaries, not a new inspection model. Browser clipboard permission failures must propagate through the real command to visible failure feedback; only a completed write can publish Copied. The panel's identity actions, accordion, inspection and recovery controls must remain reachable in the shell's supported narrow panel layout. Exact terminal activation and transcript provenance remain owned by public terminal APIs.

One-shot generation is separate from Session Info. Its timeout is measured from process spawn; SIGTERM is sent immediately at the deadline, followed by SIGKILL after two seconds if the process group survives. Completion must not leave live descendants. A grace-duration assertion requires a demonstrably SIGTERM-resistant fixture, not an assumed startup speed.

## Key decisions & rationale
Choose focused boundary investigation and actual built-app web verification. Reject speculative production signal changes: the recorded 311 ms result alone does not prove broken cleanup. Reject treating browser checks as proof of Finder, OS-window activation or macOS permissions. Those require the existing nightly native handoff under LOOP.md.

## Decisions locked
- No human asks, foreground/native automation, real provider/network calls, or global user-state changes.
- Reuse existing commands, APIs, persisted accordion state and 1.5-second Copied feedback; no alternate native bridge or test-only production hook.
- Audit 280 px supported sidebar content and an additional 240 px stress width where the shell permits it; long provider IDs and transcript paths must not force actions out of reach. Use normal vertical scrolling and visible shell overflow routes.
- Test real browser clipboard denial through browser permission configuration, not a replacement clipboard implementation. Denial stays distinct from native permission evidence.
- Preserve the two-second production SIGKILL grace, timeout classification and leader/descendant cleanup requirements. Investigate fixture readiness before any permanent repair.
- Preserve existing native SC-5 pass and SC-7/9 blocked history; add separately identified pending transient-feedback, denial, activation/flash/scroll coverage as needed. A valid pending native handoff satisfies this lane's native-only delivery rule.

## Behavior & scenarios
| ID | Data before | Walkthrough | Required outcome |
| --- | --- | --- | --- |
| FP-1 | Actual local fake-provider session with a long ID and disposable transcript, narrow panel | Open Identity; reach Copy ID, Open history, Focus pane, Open transcript and Reveal transcript using visible controls and scrolling | Controls are visible/reachable and values wrap without horizontal clipping; Open history/transcript retain their existing public behavior; Finder itself is not launched by this lane |
| FP-2 | Same narrow panel with Hooks & MCP and stale Usage available | Open each section; reach telemetry consent and Retry using pointer/keyboard/scroll | No occluded actionable control; accessible labels and focus remain usable; retain existing loading/error/recovery semantics |
| FP-3 | Real isolated browser has clipboard writes denied | Click Copy ID | Visible failure, no Copied success label; no claim of an OS permission test |
| FP-4 | Real isolated browser permits copying | Copy ID and paste into an app text field; immediately observe feedback if tool sampling permits | Exact provider ID pasted; Copied resets after 1.5 seconds. A missed short label is recorded as a sampling limit, never stretched |
| FP-5 | Original native report confirms clipboard delivery but partial focus/reveal | Review report and handoff | Preserve provenance and statuses; complete pending native scenarios for uncaptured feedback, denial, OS activation/exact input/flash/bottom scroll, and exact Finder transcript selection |
| FP-6 | Disposable one-shot fixture starts before or after its SIGTERM disposition is ready | Discriminate startup delay from a ready resistant process group through the actual runner/public generation path | Record which precondition explains early timeout completion. Keep timeout outcome and two-second resistant-group grace; verify both leader and child are gone after completion. No production change without demonstrated defect |

## Scope & non-goals
Only the parity follow-up named in the queue. Existing feature acceptance remains binding. No Source Control feature expansion, new terminal layout model, OS permission grants, native harness changes, protected loop edits, process telemetry, retries or provider integrations.

## Industry insights
Use the existing source/decision evidence rather than a research swarm, per LOOP.md: original Session Info feature flows 2–3 and edge cases; m3-session-info D21/22/25/32; fix-test-process-leaks D4/5; current native report 20261028T050836-d7f3. Clipboard promises distinguish denial from completed writes (https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText). Standard accordion buttons retain keyboard behavior (https://www.w3.org/WAI/ARIA/apg/patterns/accordion/).

## Deferred ideas
None. Native-only outcomes are an explicit required handoff, not unimplemented product functionality. Linux/Windows native signal/clipboard verification is outside the locked macOS delivery platform.

## Glossary
- Ready resistant group: the fake has installed its TERM disposition and created its recorded child before the deadline.
- Native evidence: real Electrobun/macOS observation, distinct from Chromium/web state.
- Parity: observable behavior from the original feature doc, minus its recorded defects.

## Technical decisions, contracts and verification
No exported contract changes are planned. Preserve `quirky.session-info/get`, sections/inspect, existing routed commands and `quirky.terminal/focus-pane`/openExternal. Any proven layout repair belongs in `plugins/quirky.session-info/src/window/SessionInfoPanel.tsx` and existing UI tests only if a meaningful behavior regression needs one. SIGTERM investigation owns `plugins/quirky.agents/test/generate.test.ts` and, only upon demonstrated source fault, `src/one-shot-run.ts`; public daemon generation must prove timeout plus actual process-tree cleanup. All subprocesses use private HOME/QUIRKY_HOME and the repository ProcessScope with awaited cleanup.

Before code, commit this specification and the decision log. At most three OpenAI omp implementers, Gemini cross-family review (Opus unavailable). Parent owns native scenario JSON and decision/evidence docs. Disjoint source slices may run concurrently; no build/tests/formatters mid-flight. Parent runs focused regression checks after the writer barrier.

Required gates: actual production build and one unattended web dogfood pass using the real daemon with owned fake providers; `bun scripts/suite.ts plugins/quirky.session-info plugins/quirky.agents` plus any changed importing packages; `bun test scripts`; `bun run typecheck`. Catch up once with `git merge build/roadmap`, read incoming decisions, rerun affected checks as LOOP.md requires, one final review round, then authoritative queue land. No whole-suite pre-land run. Remove throwaway runtime probes after observed proof; update docs with exercised evidence and exact limits.
