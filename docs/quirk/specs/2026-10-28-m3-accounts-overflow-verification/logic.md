# Accounts responsive verification

## Status & amendments
Approved autonomously under the unattended loop contract. 2026-10-28 initial spec retained for end-phase acceptance; original tech spec was written before the policy change.

**Amendments:** 2026-10-28 operator moved all testing/debugging to the end phase and explicitly ordered this in-progress item to land now with typecheck only. AC1–AC4 remain acceptance obligations for that end phase, not claims achieved by this landing. The active suite was cancelled without a verdict; no repair, badge-only/Remaining completion or guarded UI pass is claimed. Decisions D7–D9 record completed observations and the superseded schedule. No additional testing/debugging follow-up is allowed under the updated LOOP.

## Purpose and conceptual model
Close the missing observations named by `m3-accounts-overflow-verification`, not rebuild Accounts. The status bar projects provider quota snapshots; presentation preferences change density without changing quota or account identity. Available width determines a visible prefix and a collapsed suffix represented by `+N`.

## Scope and non-goals
Own constrained-width collapse, tooltip accuracy, badge-only presentation, recovery on widening, and a bounded passing affected-package run with evidence about the earlier 1,800-second timeout. Preserve prior core, transcript-content and full-width popover reports separately. Account login/restart extensions, remote/Windows behavior, native OAuth dialogs and the independent remaining-flows/review backlog are not this queue slice.

## Behavior & scenarios
### AC1: Normal-density overflow and recovery
Data before: an isolated daemon has several configured fixture providers with distinct known quota percentages, normal density, and a full-width footer showing all providers. Walkthrough: narrow the real browser until the footer cannot fit its chips, then widen it. Data after: narrow layout shows a visible prefix and `+N` for exactly the omitted suffix; Usage and refresh remain reachable and no visible chip is clipped. Widening restores all chips and removes `+N`. Actual DOM geometry, visible screenshot and the public UI projection agree.
Provider chips and the `+N` control keep their complete keyboard-focus ring inside the overflow-clipped row in both light and dark themes.

### AC2: Overflow tooltip and access
Data before: AC1's collapsed suffix. Walkthrough: hover the visible `+N` control and inspect its native title, then click it. Data after: title starts `Also:` and includes exactly the hidden providers and their displayed percentages in order; click opens the real Usage roster with the fixture providers available. Remaining direction must use remaining percentages, not consumed values. Browser-native tooltip painting may be driver-limited; title inspection plus positive hover and click is required, and that limit is recorded rather than claiming a screenshot of an unpainted native tooltip.

### AC3: Badge-only density
Data before: same providers and normal-density narrow layout. Walkthrough: use Appearance's visible `Show provider badges only` control, inspect the footer, narrow until badge overflow occurs, then widen. Data after: provider-specific letters replace percentage/reset text in visible chips; counts and hidden identities remain correct, no badges clip, Usage/refresh stay reachable, widening restores all configured badges. Switch back to normal density through the same UI.

### AC4: Bounded affected-package result and diagnosis
Data before: inherited evidence records 48 core tests/295 assertions passing and a separate ten-directory suite timeout with no verdict. Walkthrough: recover the old invocation/output where retained, trace current runner/process-lifetime history, and execute the complete affected selection through `bun scripts/suite.ts` with profiling and an external bound, without omitting tests or weakening assertions/timeouts. Data after: retain a terminal passing result plus selected-file counts/durations. If a blocker is observed, diagnose and repair it, then obtain a bounded passing rerun of the complete affected selection; diagnosis or repair alone is incomplete verification. Do not attribute a historical stalled process without evidence; distinguish historical uncertainty from current repaired behavior.

## Defects guarded against
The source doc records narrow collapse and icon-only density as unexercised, not established Orca defects. Do not manufacture a parity bug. The inherited Quirky full-width popover clipping repair remains intact; AC2 checks that the opened roster is usable at the constrained width. Any newly observed clipping/count/identity mismatch is a defect to reproduce before repair.

## Decisions Locked
- Layout/information density: inherited measured collapse, suffix order, unique provider letters and Compact/Used defaults; no responsive redesign.
- Interaction: `+N` opens the existing Usage surface; Appearance owns density; use the public API only for isolated setup and observation.
- Error/recovery: preserve missing/stale provider semantics and existing authentication boundaries. Width is not a provider error.
- Output/performance: the old timeout remains a timeout, never a pass. A new result is reported separately with its exact coverage.
- Isolation: temporary HOME and QUIRKY_HOME, fixture network/credential boundaries only, stop all owned processes, no real account changes.

## Key decisions & rationale
Recommended: verify existing measured behavior and fix only reproduced defects. Alternatives rejected: mounted DOM-only geometry cannot prove browser layout; adding CSS breakpoints or extra providers to production would alter behavior to satisfy a verification task. Recover evidence and run the existing suite rather than adding speculative runner timeouts.

## Industry insights
No external research swarm under LOOP.md. Evidence: external `research/orca-features/accounts.md`, Read usage steps 6 and Verified in the app; inherited Accounts decisions D7, D23, D28–D35; live Usage component and suite/process ownership implementation.

## Deferred Ideas
None added. Existing separately queued Accounts remaining-flows work is unchanged.

## Glossary
Visible prefix: providers still rendered as individual chips. Collapsed suffix: remaining providers represented by `+N`. Badge-only: existing `density: icons` preference. Affected suite: original changed packages and their consumers, not a replacement narrow core test run.
