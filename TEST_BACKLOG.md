<!-- schema-version: 1 -->
<!-- TEST_BACKLOG.md SCHEMA (append only)
Entry format:
## TEST-[N]: [Function or behavior to test]
- **File under test**: [path]
- **Test type**: [unit / integration / e2e]
- **Reason skipped**: [time / complexity / mocking required / TBD]
- **Edge cases to cover**: [list]
- **Priority**: [P1/P2/P3/P4]

Required fields: file_under_test, reason_skipped.
-->

# TEST BACKLOG

Tests that were skipped, abbreviated, or flagged as needing expansion.

Reviewed every 2 weeks. Use `/quirk:artifacts:test-skip` to append.

## TEST-1: Load-sensitive tests that fail only under full-suite concurrency on this dev host

- **File under test**: src/main/updater.test.ts; src/rpc (terminal-output-frame-chunks-equivalence); src/renderer/src/components/github-project/project-view-wrapper-source-context-boundary.test.ts; src/renderer/src/components/right-sidebar (ai-vault-session-worktree-map); src/relay/subprocess.test.ts; src/main/providers (ssh-pty-provider-agent-session-create-operation); src/main/runtime/orchestration (orchestration-creator-authority-performance); src/shared/remote-runtime-shared-control-connection.test.ts; src/renderer/src/components/terminal-pane/terminal-fit-restore.test.ts; src/renderer/src/lib/palette-match/palette-match-performance.test.ts; src/main/providers (local-pty-shell-ready-zsh-zdotdir-discovery); src/cli/runtime/transport.test.ts; src/renderer/src/components/dashboard-popout (AgentMapWorkspaceContextMenu)
- **Test type**: unit / integration
- **Reason skipped**: environment — each passes in isolation on the warp-rich-input branch but intermittently times out or misses a fake-timer tick under full-suite load on an 8-core host (worker-pool contention; one case surfaced a 14999-vs-15000ms fake-timer bleed). None are touched by the branch; verified against RUN_BASE b84a7492 during the docked-composer run (2026-08-13..16). Re-confirmed 2026-08-25 on the composer-open-by-default branch against the remote sandbox: `--shards=16 --jobs=8` failed 15/16 shards across 45 files, `--jobs=4` failed 4/16 across 7 tests, and every checked file passed at `--jobs=1` — the failure count tracks concurrency, not the diff.
- **Edge cases to cover**: make the timeout-bound assertions load-tolerant (fake timers pinned per test, generous poll budgets), or isolate these files into a serial pool so full-suite runs stop reporting noise
- **Priority**: P3

## TEST-2: browser-cookie partition electron tests fail only under full-suite concurrency

- **File under test**: src/main/browser/browser-cookie-import-partition.electron.test.ts; src/main/browser/browser-cookie-import-partition-rollback.electron.test.ts
- **Test type**: integration
- **Reason skipped**: environment — both fail in a full `pnpm test` run on this 8-core host but pass in isolation on this branch, and pass in isolation at origin/main (33096f51b3). Same worker-pool contention class as TEST-1; neither file is touched by the warp-rich-input branch. Observed while verifying the rebase onto origin/main.
- **Edge cases to cover**: make the Electron cookie-clear assertions load-tolerant, or move the `.electron.test.ts` files into a serial pool
- **Priority**: P3

## TEST-3: No component-level harness proves a same-id reattach re-renders the dock

- **File under test**: src/renderer/src/components/terminal-pane/TerminalPane.tsx
- **Test type**: component / integration
- **Reason skipped**: no TerminalPane.test.tsx exists anywhere in the repo, and nothing renders <TerminalPane /> — the component owns a PaneManager, xterm instances, and the deferred connect loop, so standing one up is a harness project, not a test. The stale-dock fix is anchored instead by unit tests on the fork hook (use-terminal-dock-pty-binding-revision.test.ts, use-terminal-pane-dock.test.ts) plus the upstream contract test that proves the chokepoint fires on remount (pty-connection-reattach-binding.test.ts:173). The seam those three leave uncovered is the wiring itself: that TerminalPane's syncPanePtyLayoutBinding/clearExitedPanePtyLayoutBinding actually call the notifier. Verified manually in the Electron app instead.
- **Edge cases to cover**: generation remount, tab-move rehome and web-mirror remount all reattach to the id the layout already holds; pty exit clears the dock without a toggle; multi-pane splits where one pane rebinds and siblings do not
- **Priority**: P3

## TEST-4: No hook-level harness covers the handoff dialog's template-save selection rule

- **File under test**: src/renderer/src/components/agent-session-continuation/fork-session-handoff/use-handoff-dialog-state.ts:363
- **Test type**: unit / component
- **Reason skipped**: no test file renders `useHandoffDialogState` — `AgentSessionContinuationDialog.test.tsx` mocks the hook wholesale, so the hook has zero coverage today. It reads the app store through three `useAppStore` selectors plus `getState`, and drives capture, target resolution, secret scanning, and draft preservation, so a `renderHook` harness means standing up a full store fixture and mocking eight modules. The values a freshly opened dialog starts from are now covered by `handoff-dialog-open-seed.test.ts`, and the BUG-6 fix is anchored by `HandoffNotesControls.test.tsx` on the component side. What stays unproven is the wiring: that the render-time seeding runs on the open transition and not on unrelated re-renders, and that the newly saved template is adopted only when nothing was selected.
- **Edge cases to cover**: save with a template already selected (prior selection and steering note both survive); save with no template selected (new template is adopted and the note clears); a save that resolves after the generation ref advanced changes nothing
- **Priority**: P3

## TEST-5: The composer's IME deferral and remount behaviour is replayed but untested in fork shape

- **File under test**: src/renderer/src/components/native-chat/use-native-chat-composer-attachments.ts; src/renderer/src/components/native-chat/fork-agent-composer/AgentComposerField.tsx; src/renderer/src/components/native-chat/NativeChatComposer.tsx
- **Test type**: unit / component
- **Reason skipped**: the v1.4.194 sync replayed upstream's IME rework (`useImeEnterGestureOwnership`, uncontrolled textarea with a layout-effect draft sync, attachment deferral while composing, `key={paneKey}` remount) into the fork's tier-2 composer copies. Upstream's own new assertions for it live in `NativeChatComposer.test.tsx` and `use-native-chat-composer-attachments.test.tsx` against upstream's module layout — those tests mock `./NativeChatComposerField` and `./use-native-chat-composer-keydown`, which the fork deletes, so they cannot be taken verbatim. The fork's equivalents were updated only far enough to compile against the new prop shape. `native-chat-composer-composition.test.tsx`, upstream's new field-level composition suite, was dropped with the component it exercises.
- **Edge cases to cover**: a draft clear dropped mid-composition leaves only the composed segment (`imeComposedSegment`); paths attached while composing are deferred and flushed on IME settle; a deferred batch over `NATIVE_FILE_DROP_MAX_PATHS` is rejected whole and keeps its notice; blur while composing settles like `compositionend`; a `paneKey` change remounts the field instead of carrying the previous pane's provisional value
- **Priority**: P2

## TEST-6: The sidebar section-separator predicate ships with no test

- **File under test**: src/renderer/src/components/sidebar/fork-sidebar-section-separator/section-separator-class.ts
- **Test type**: unit
- **Reason skipped**: environment — vitest cannot run on this machine (sandbox-only lane) and this worktree has no `QUIRKY_SANDBOX_DOCKER_HOST` configured, so a new test file could not be executed before landing. `sidebarSectionSeparatorClass` is a pure predicate over `(settings, row, index, context)` and is cheap to cover once a runner is reachable; the fork convention already puts fork tests beside fork code, so the file has an obvious home. Nothing in CI currently fails if a suppression rule regresses.
- **Edge cases to cover**: setting disabled returns no class; the first header in the list gets no separator; a header immediately beneath a host header gets none; the pinned sticky-header branch returns none; nested headers (`projectGroupDepth > 0`) get none; a top-level header after a normal row does get the hairline; the collapsed-Pinned case (`followsCollapsedPinnedHeader`) pins whichever behavior is decided to be intended
- **Priority**: P3

## TEST-7: no-top-level-translate times out deterministically in the remote sandbox

- **File under test**: src/renderer/src/i18n/no-top-level-translate.test.ts
- **Test type**: unit
- **Reason skipped**: environment — the test walks every renderer .ts/.tsx and builds a TypeScript AST per file under an explicit 15_000ms budget. In the remote Docker sandbox it takes 39s with the ask-card changes applied and 62s on clean HEAD with them reverted, so it times out on every run even at --shards=4 --only=2 with no competing shards. Distinct from TEST-1: that class is intermittent under worker-pool contention, while this fails at minimum concurrency and is slower without the diff than with it — a budget-vs-host mismatch, not the diff.
- **Edge cases to cover**: Raise the per-test budget to something the sandbox container can meet, or cache/parallelize the AST scan; then confirm it passes in a --shards=16 --jobs=8 full run, not only in isolation.
- **Priority**: P3

## TEST-8: tabs-terminal-dock's host-mirror assertions flake in isolation, not just under load

- **File under test**: src/renderer/src/store/slices/fork-terminal-dock/tabs-terminal-dock.test.ts
- **Test type**: unit
- **Reason skipped**: flaky — the `terminal dock state` cases that `vi.waitFor` on `setWebRuntimeTabPropsMock` fail intermittently at `--shards=1 --jobs=1` with no competing work. Measured on the remote sandbox: 2 of 3 runs failed at e57ecedc8f, and 3 of 3 failed on a throwaway worktree at 0dfa466215, which predates the right-sidebar ask work entirely. Failing more often on the older tree rules out the ask changes as the cause. Distinct from TEST-1 (contention-only) and TEST-7 (deterministic budget miss): this one fails at minimum concurrency and is not reproducible on demand.
- **Edge cases to cover**: Find what the waitFor is racing — most likely the mirror dispatch is scheduled off a timer or microtask the test does not drive — and await that seam instead of polling the mock. Then run the file 10x at --shards=1 to confirm the flake is gone.
- **Priority**: P2
