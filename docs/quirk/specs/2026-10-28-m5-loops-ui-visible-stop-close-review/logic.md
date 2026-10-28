# Loop Stop and Close acceptance coverage

Reader: end-phase implementers and reviewers — Decision: run the remaining visible scenarios without weakening native ownership or mistaking a tool limitation for an app failure.

## Status & amendments
Status: Approved autonomously under the current build-first LOOP.md policy. One combined logic/technical specification; no separate review or tech.md.

**Amendments:** 2026-10-28: initial specification. The current build-first policy postpones this item's originally requested visible dogfood and bounded cross-family review until the existing end phase. No new verification-only follow-up is created.

## Purpose and conceptual model
The shipped Stop panel and live-tab Close dialog control a daemon-owned loop. A view never owns its worker. This item retains those controls and their guards, adds missing permanent native-protocol UI acceptance coverage, and accurately finalizes the earlier setup verdict.

Consumers are people using the existing loop UI and agents invoking its declared commands. Success for this build-phase item is committed coverage and a typechecked landing, not a newly claimed visual or review pass.

## Scope and non-goals
Cover the existing U07 Stop and U11 Close flows from the parent specification and the unique native conversation fixture prerequisite. Preserve setup tests, API/CLI tests, production ownership, stale-binding rejection and focus behavior. The earlier setup Start was tool-limited UNSETTLED after a successful background creation and stable observation, not an observed product failure and not a formal pass.

Do not redesign setup, add a loop picker, add PTY loop agents, relax provider conversation exclusivity, change production deadlines, rerun the old failure, or perform a review/dogfood/suite campaign before the end phase. All other fork-loops.md flows remain in their landed owners.

## Decisions locked
- Interaction: exercise the actual rendered buttons while using public daemon/window APIs to create/read state; do not substitute call-count assertions for lifecycle outcomes.
- Data/lifetime: simultaneous new native conversations have distinct IDs; resume keeps the requested identity. No production guard changes.
- Error state: retain all existing refusal tests and guards. Cancel changes neither the loop nor its hosted tab. A failed close leaves the tab.
- Isolation: every process uses disposable HOME, QUIRKY_HOME and provider directories, and cleanup awaits its owner before removing them. macOS only.
- Verification: write acceptance tests now; do not run them. Typecheck is the current gate. Do not fabricate a cross-family review result or promote the setup tool verdict to PASS.

## Behavior and scenarios

### S1: Stop Cancel and after-iteration
Before: a native loop has an actually in-flight held turn and a hosted rail. Click Stop, then Cancel. After: the same loop/session/turn remains live. Reopen Stop and choose After this iteration. The held turn must not be interrupted. Release it through the fixture's native protocol; the loop becomes stopped with exactly the settled iteration retained and no next turn. This distinguishes deferred stop from Now.

### S2: Stop Now
Before: a different native loop is working on a held turn. Click Stop then Now. After: it is stopped, the interrupted attempt is retained as stopped rather than counted as completed, and the UI keeps history but removes lifecycle controls. Confirm public loop/history and native turn evidence, not just a button callback.

### S3: Close Cancel, Keep running and Stop loop
Before: two concurrent native loops own distinct provider conversation IDs, with at least one loop held in-flight. Invoke the existing tab-close entry point. Cancel retains the exact hosted tab and live session. Keep running removes only that view and leaves the same loop/turn alive; let the native turn settle and confirm its next queue work runs without the view. Reopen via the existing declared command, then select Stop loop from a live close dialog: stop succeeds before tab removal, while the other loop remains unaffected. Existing stale-binding and paused-race tests are retained unchanged.

### S4: Setup evidence classification
Before: the parent record describes successful background Start and preserved focus, but the tool marked the final action UNSETTLED. After: decision log and append-only handoff explicitly preserve that tool-limited classification. No new app-failure claim or formal pass is inferred from the summary. Existing setup tests remain intact.

### S5: Review and visible proof policy
Before: one bounded cross-family review and visible dogfood were unstarted. After: record them as not executed under the current policy and carry the exact S1–S3 goals to the already scheduled loop sweep/end phase. Do not add another verification-only item.

## Key decisions & rationale
Use the shipped shared Codex app-server executable fixture with its existing uniqueThreads option and the loop daemon harness. This exercises the actual structured transport and renderer handlers without credentials. A new runtime fix is not justified by the parent evidence: its visible startup crash came from duplicate fixture identities. Alternatives rejected: weakening the owner guard would hide a real safety boundary; running the old campaigns now would violate the current operator policy; documentation alone would leave the missing Stop-panel acceptance coverage unwritten.

## Industry insights
No external research swarm: the feature doc, locked roadmap/architecture, parent U07/U11 specification and m5-loops-ui D18/D22/D25 are the research inputs, as LOOP.md requires.

## Deferred ideas
No unbuilt production flow was found. Visible runtime proof and the bounded review move to the existing end phase by policy, not to a new follow-up item. Linux/Windows verification remains deferred platform work.

## Glossary
Held turn: native fixture turn that remains working until explicitly steered or interrupted. Hosted tab: a view with no native-process ownership. Deferred stop: allow the current turn to settle, then prevent another iteration. Now: interrupt the current turn and stop.

## Technical decisions and shared contracts
- Extend only `plugins/quirky.loops/test/rig.ts`: optional `nativeCodex?: boolean` selects the existing real Codex app-server fixture with `uniqueThreads: true`; optional `nativeFixture` exposes its typed request log. Default scripted mode and all existing callers stay unchanged.
- Native mode must not install the scripted runner override; it must temporarily remove any inherited override and restore it during cleanup. Its executable is discoverable solely from the disposable provider bin, including a node interpreter shim to the current Bun binary if needed.
- Add `plugins/quirky.loops/test/ui-native-controls.test.ts` for S1–S3. Reuse existing headless-window/geometry/native fixture patterns. Do not modify production source or existing tests. No new exported product schema or API.
- One implementer owns both files in one isolated component worktree. Parent owns specs, decision log and append-only BLOCKERS handoff. There are no successor dependencies or review rounds.
- Build-phase acceptance command: `bun run typecheck` must exit 0. End-phase targeted command, recorded but not run now: `bun test plugins/quirky.loops/test/ui-native-controls.test.ts`. End phase also owns real browser proof and the bounded cross-family review; a headless DOM run alone cannot claim those.
- Self-review: S1–S3 cover every requested Stop/Close choice; S4 distinguishes tool evidence from app behavior; S5 records the current override. All fixtures use exact process ownership; no guard, test, assertion or deadline is removed.
