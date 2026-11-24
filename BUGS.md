<!-- schema-version: 1 -->
<!-- BUGS.md SCHEMA (append only — do not rewrite existing entries)
Entry format:
## BUG-[N]: [Short title]
- **Observed**: [date or session ID]
- **File**: [path/to/file.ts:line]
- **Description**: [what the bug is]
- **Introduced by**: [this session / unknown / commit SHA]
- **Severity**: [critical / high / medium / low]
- **Proposed fix**: [one sentence]
- **Blocker for**: [what this would break]

Required fields: title, file, description, severity.
-->

# BUGS

Bugs noticed during sessions but not fixed in the current scope.

Reviewed every PR. Use `/quirk:artifacts:bug` to append. Do not edit older
entries' IDs; manual edits to fix typos are fine.

## BUG-1: Reattach quarantine armed on only one of four PTY-swap paths; composer sends bypass it entirely

- **Observed**: 2026-08-13
- **File**: src/renderer/src/components/terminal-pane/terminal-pane-recovery.ts:290
- **Description**: armTerminalInputQuarantine has exactly one call site (terminal-pane-recovery.ts:290, gated on endpointReplaced). SSH drop, remote-runtime reconnect, and the Codex detached-pane restart scheduler never arm reattach quarantine, so in-flight input can land on a freshly swapped PTY on those paths even for raw keystrokes — the exact hazard terminal-input-quarantine.ts was written to prevent. Native chat's send path additionally bypasses quarantine entirely (different write path; quarantine keys by tabId, sends queue by ptyId), and its delayed auto-submit Enter means a stale send needs no second human confirmation. Discovered during docked-composer design research; out of scope for that feature.
- **Severity**: high

## BUG-2: Environment-dependent failures in relay/ssh test suites on this dev host

- **Observed**: 2026-08-14
- **File**: src/relay/agent-exec-handler.test.ts:27
- **Description**: Four tests fail deterministically on this machine: agent-exec-handler 'executes a non-interactive command with captured output and stdin' and 'merges caller-supplied provider environment into the spawned command environment' (spawn-arg mock mismatches), git-handler 'rethrows upstreamStatus failures that are not no-upstream-configured' (host git returns 'Stopping at filesystem boundary (GIT_...)' instead of 'not a git repository' — host git config bleed), ssh-remote-commands 'bounds real POSIX GC output with more than the exec-cap stage population'. Verified identical failures on a clean worktree at merge-base 8dc672c4c0 (pre-branch), so not a warp-rich-input regression; likely host git/config/environment dependence in the tests.
- **Introduced by**: pre-existing on main (verified at 8dc672c4c0)
- **Severity**: low
- **Addendum (2026-08-14)**: project-view-wrapper-source-context-boundary 'builds project work items with a host-pinned repository identity' also failed (30s timeout) in a full-suite run on this host during the branch adversarial review; file untouched by warp-rich-input. Same environment/load class; not yet reproduced in isolation.

## BUG-3: Two suites fail deterministically on this dev host, unrelated to any branch change

- **Observed**: 2026-08-18
- **File**: src/shared/posix-command-path-lookup.test.ts:61
- **Description**: `buildPosixCommandPathLookupScript > resolves without mutating alias and function masks in zsh` resolves `node` through the host's zsh, which finds `/usr/local/Cellar/node/25.9.0_1/bin/node` while the test process runs the nvm node it asserts against (`process.execPath`) — a host PATH-ordering dependence, not a code defect. `terminal-ime-xterm-resumed-preedit-visibility.test.ts` fails two cases (`shown: false` vs `true`) for a preedit the IME resumes. Both fail in isolation and on a tree with the working changes stashed; no commit on warp-rich-input touches either area.
- **Introduced by**: pre-existing / environment
- **Severity**: low

## BUG-4: TerminalPane.tsx's terminal-dock wiring is undeclared in the fork-ownership manifest

- **Observed**: 2026-08-23
- **File**: config/fork-ownership.json
- **Description**: TerminalPane.tsx carries ~128 lines of fork-authored terminal-dock wiring (imports, useTerminalPaneDock, the dock-mount JSX block, focus-ownership call sites) but is declared only as an `exceptions` entry whose reason describes an unrelated upstream fix ("Corrects effectiveChatViewMode"). No `seams` entry names the dock lines, and `residuals` is schema-illegal for exception paths, so nothing records or bounds the dock footprint. The guard passes because an exception path is checked for existence only, never content — confirmed in .github/scripts/check-fork-ownership.mjs (checkStaleEntries is the only check that touches an exception path). The wiring has ridden this unrelated exception since bbfba96abc and survived the v1.4.186 and v1.4.187 syncs without ever being described. Consequence: a sync has no declared spec of what the dock wiring should look like, and any accidental loss of those lines is invisible to CI. Needs an owner decision — split the dock wiring into its own manifest entry, or restate the exception reason to cover the file's real fork footprint.
- **Severity**: medium

## BUG-5: Live-zsh ZDOTDIR discovery fails on a non-ASCII wrapper path inside the test sandbox

- **Observed**: 2026-08-24
- **File**: src/main/providers/local-pty-shell-ready-zsh-zdotdir-discovery.test.ts
- **Description**: `live zsh subprocess tests > ZDOTDIR discovery with real zsh > loads user .zshrc when the wrapper dir contains a non-ASCII (token-range) path` fails in the Docker test sandbox. It fails in isolation (6-file batch, 1 of 100 cases) as well as under full-suite load, and no renderer or composer change touches it — the container's locale/filesystem encoding is the likely dependence. Every other file that failed the 16-shard full-suite run passed when re-run in isolation, so those are the known load-sensitive class (TEST-1); this one is not.
- **Introduced by**: pre-existing / sandbox environment
- **Severity**: low
- **Proposed fix**: Assert the container's locale in the live-zsh lane, or skip the non-ASCII case when the filesystem encoding cannot represent the path.
- **Blocker for**: A clean green full-suite baseline on the remote sandbox.
- **Addendum (2026-08-25)**: the referenced test file was deleted upstream by c72a4eecdd (zsh wrapper collapsed to one .zshenv plus a precmd hook), which reached this fork with v1.4.189. Confirm the non-ASCII case still exists in the reworked live-zsh lane before acting on this entry.

## BUG-6: Saving a steering note as a template silently drops the already-selected template from the brief

- **Observed**: 2026-08-26
- **File**: src/renderer/src/components/agent-session-continuation/fork-session-handoff/use-handoff-dialog-state.ts:381
- **Description**: saveSteeringNoteAsTemplate calls setSelectedTemplateId(newId) and setSteeringNote(''), replacing whatever template was already selected. Repro: select 'Debug the failure', add a steering note, save the note as a new template 'Flaky triage' -- the brief loses the 'Debug the failure' block with no warning. The user's intent was to add a template, not swap the active one.
- **Introduced by**: code review of staged session-handoff customization changes
- **Severity**: low
- **Proposed fix**: Either keep the prior selection and treat the new template as catalog-only, or warn/confirm before replacing an active selection.
- **Resolved (2026-08-26)**: the save now adopts the new template only when nothing is selected; with a template already active the note and the selection both survive. Hook-level coverage is tracked as TEST-4.

## BUG-7: New Template option opens a dead-end naming panel once the catalog is at its limit

- **Observed**: 2026-08-26
- **File**: src/renderer/src/components/agent-session-continuation/fork-session-handoff/HandoffNotesControls.tsx:46
- **Description**: At HANDOFF_TEMPLATES_MAX the 'New Template' select option stays selectable and opens the naming panel, but canSave is permanently false so the user can never complete the action. The only explanation is a title attribute on the select item, which is invisible once the panel is open. A test asserts the current behavior ('opens template creation at the catalog limit while keeping save disabled'), so changing it means changing that test too.
- **Introduced by**: code review of staged session-handoff customization changes
- **Severity**: low
- **Proposed fix**: Disable the option at the limit, or render a visible at-limit message inside the naming panel next to the disabled save button.
- **Resolved (2026-08-26)**: the naming panel now renders the visible `templateLimitReached` message above the disabled save button, so the state is explained rather than silent.

## BUG-8: A patch carrying both templates and templateMutation discards the explicit templates write

- **Observed**: 2026-08-26
- **File**: src/shared/fork-session-handoff/handoff-settings-merge.ts:93
- **Description**: When a patch supplies both a templates array and a templateMutation, the merge computes the mutation against currentSettings.templates and then overwrites the caller's explicit templates value. The explicit write is silently lost. No caller batches them today, so this is latent, but it is a trap for any future caller that does.
- **Introduced by**: code review of staged session-handoff customization changes
- **Severity**: low
- **Proposed fix**: Apply the mutation against the patch's templates when both are present, or reject the combination explicitly rather than silently preferring one.
- **Resolved (2026-08-26)**: the mutation now composes onto the patch's templates, so a batched write and mutation both land.

## BUG-9: A server-side rejected template mutation fails silently in the settings editor

- **Observed**: 2026-08-26
- **File**: src/shared/fork-session-handoff/handoff-settings-merge.ts:40
- **Description**: A rejected add/update (empty name or body, duplicate id, at the catalog limit) returns applied: false with no reason. HandoffTemplatesPane.saveEditor then returns false and the editor just stays open, while persistTemplateMutation only toasts on a thrown error -- so the user sees nothing. Currently unreachable because canSave/atLimit gate every path client-side, but the rejection channel carries no signal a caller could surface.
- **Introduced by**: code review of staged session-handoff customization changes
- **Severity**: low
- **Proposed fix**: Return a reason code alongside applied: false and have the pane surface it as a toast or inline editor error.

## BUG-10: Tab close may not release the handoff dialog's store subscription

- **Observed**: 2026-08-26
- **File**: src/renderer/src/lib/fork-session-handoff/launch-session-handoff.ts:399
- **Description**: Raised by the first review pass on this branch and carried unverified into the merge. The delivery waiter subscribes to the app store and clears itself on resolution; the claim is that closing the receiving tab before delivery resolves leaves the subscription attached. Not reproduced in this pass — treat the file pointer as the starting point, not a confirmed line.
- **Introduced by**: first code-review pass on the session-handoff branch
- **Severity**: low
- **Proposed fix**: Confirm the waiter's teardown path runs when the target tab disappears, and add a test that closes the tab mid-wait.

## BUG-11: Start with an unresolvable target is a silent no-op

- **Observed**: 2026-08-26
- **File**: src/renderer/src/components/agent-session-continuation/fork-session-handoff/use-handoff-dialog-start.ts:55
- **Description**: The opening guard returns false when `request`, `selectedAgent`, `target`, or `compositionInputs` is missing, without calling `setOperationError`. Every later failure path in the same function does set one. If the button is ever reachable while the target cannot resolve, the click does nothing and says nothing. `startDisabled` is expected to gate this today, so it is latent rather than live.
- **Introduced by**: first code-review pass on the session-handoff branch
- **Severity**: low
- **Proposed fix**: Set an operation error in the guard, or assert the invariant so an unreachable state fails loudly instead of silently.

## BUG-12: SSH-backed repo-state probes are not cancellable

- **Observed**: 2026-08-26
- **File**: src/renderer/src/lib/fork-session-handoff/handoff-repo-state.ts
- **Description**: The module carries no AbortController or cancellation token, so a repo-state diff started against a slow SSH host keeps running after the user changes target or closes the dialog. The result is discarded by the caller's generation check, but the work and the remote round-trip are not stopped.
- **Introduced by**: first code-review pass on the session-handoff branch
- **Severity**: low
- **Proposed fix**: Thread an AbortSignal through the probe and abort it when the target changes or the dialog closes.

## BUG-13: Lineage badge attribution in split tabs may point at the wrong pane

- **Observed**: 2026-08-26
- **File**: src/renderer/src/components/agent-session-continuation/fork-session-handoff/SessionHandoffLineageBadge.tsx
- **Description**: Raised by the first review pass and carried unverified into the merge. The badge resolves its jump target through `resolveOriginalPaneTarget` and `parsePaneKey`; the claim is that a tab holding several panes can resolve to a sibling rather than the pane that produced the handoff. Not reproduced in this pass.
- **Introduced by**: first code-review pass on the session-handoff branch
- **Severity**: low
- **Proposed fix**: Reproduce with a split tab whose panes ran different agents, then key the badge's target on the recorded pane id rather than the tab.

## BUG-14: Stuck-draft recovery never matches a fork release tag

- **Observed**: 2026-09-02
- **File**: config/scripts/publish-complete-draft-releases.mjs:10
- **Description**: `DESKTOP_RC_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/` rejects the fork's `.zyNN` suffix, so `isReleaseCutDraft` returns false for every tag this fork cuts. The `publish_drafts` step in `release-cut.yml` exists to unstick a complete-but-undrafted RC before deciding whether to cut another tag; on this fork it always reports `published_count=0, skipped_count=0` and the recovery is dead code. Found while diagnosing the pnpm-pin release failures — those drafts are artifact-less so they _should_ be skipped, but they were never even considered.
- **Introduced by**: the fork's `.zyNN` version-suffix scheme, which postdates the upstream pattern
- **Severity**: low
- **Proposed fix**: Widen the pattern to accept an optional `.zyNN` identifier (`/^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+(\.[0-9A-Za-z]+)?$/`) and cover it with a case in the script's tests. Verify `verifyRequiredReleaseAssets` still refuses an artifact-less draft before relying on it.

## BUG-15: Activity-window cutoff never advances on a quiet sidebar

- **Observed**: 2026-09-10
- **File**: src/renderer/src/components/sidebar/fork-workspace-activity-window/use-workspace-activity-filter.ts:25
- **Description**: getWorkspaceActivityFilterContext memoizes on a module-global previousInputs/previousContext pair and only recomputes now: Date.now() when one of its keys changes identity. Three of those keys (worktreesByRepo, repos, folderWorkspaces) are compared but never read into the context, so the cutoff advances only as a side effect of unrelated store traffic. With the window on 'Past 24 hours' and nothing else changing, a workspace that should age out stays visible indefinitely. Second defect in the same module: previousInputs/previousContext are module-level, so they survive across createUIStore() instances and can leak state between tests. Found during /code-review high --fix on branch zpyoung/project-filters (reviewer finding 11).
- **Severity**: medium
- **Resolved (2026-09-11)**: the hook now memoizes per instance through useShallow and re-keys `now` on the shared minute clock while a time-based window is active; the non-hook selector is pure and reads the clock on every call.

## BUG-16: ask-services pulls electron into the node-only runtime graph, failing pnpm lint

- **Observed**: 2026-08-31
- **File**: src/main/fork-ask-question-tool/ask-services.ts:21
- **Description**: check:runtime-electron-ratchet fails on the branch as committed (8d1dd7eb0e): 'src/main/fork-ask-question-tool/ask-services.ts' is a new module reachable from the Quirky runtime that imports electron, via the lazy require('electron') for app.getPath('userData'). The ratchet is static, so the lazy require does not exempt it. pnpm lint aborts at that gate, so the four localization/skill verifiers after it never run in a single lint invocation, and PR CI will fail. Reproduced independently of any working-tree change (clean HEAD).
- **Severity**: high
- **Proposed fix**: Route the userData path through a port in src/main/host/ (the ratchet's prescribed escape) so ask-services depends on the port instead of electron, or move the db-path resolution out of the runtime import graph.
- **Resolved (2026-09-12)**: ask-services resolves the db path through the shared `getAppEnvironment()` port instead of requiring electron; the ratchet gate passes.

## BUG-17: AskPendingCountBadge is never mounted, so the pending-ask count is unobservable

- **Observed**: 2026-09-11
- **File**: src/renderer/src/components/fork-ask-question-tool/AskPendingCountBadge.tsx:21
- **Description**: The badge component and its unit test exist and pass, but a repo-wide grep for AskPendingCountBadge and selectPendingAskCount finds no render site outside the component and its own test. The 'badge the count' half of commit 7cb8a3b837 therefore ships dead: no surface in the app ever displays the cross-pane pending-ask count, and manual testing cannot observe it.
- **Introduced by**: 7cb8a3b837
- **Severity**: medium
- **Proposed fix**: Mount it in the sidebar worktree row / tab header alongside the other per-worktree indicators, declared as a fork seam in config/fork-ownership.json.

## BUG-18: two ask e2e tests fail on a clean baseline, so the lane never proved the answer path

- **Observed**: 2026-09-11
- **File**: tests/e2e/ask-card.spec.ts:214
- **Description**: 'answering resolves the blocked wait and collapses the card' and 'restores a pending ask with its partial draft intact after a renderer remount' both fail under `--project=electron-headless`. Confirmed pre-existing: they fail identically on a throwaway worktree at 0dfa466215, which still has the old terminal-pane dock and none of the right-sidebar work. In the first, the card renders and Submit is clicked (verified in the failure screenshot: field filled, footer visible) but `installAskRpcRecorder`'s poll never sees an `ask.answer` call — consistent with `window.api` being a frozen contextBridge object, so the `window.api.runtime.call = ...` reassignment silently no-ops. The remaining four tests in the file pass. Matches the AGENTS.md note that the e2e lane "has not been run anywhere yet".
- **Severity**: medium
- **Proposed fix**: Record RPC calls through a seam the renderer reads at call time rather than reassigning a contextBridge property — e.g. expose a test-only hook on `window.__store` or wrap at the preload boundary under an env flag. Then re-check the remount test, which may share the same cause.
- **Resolved (2026-09-12)**: both tests now register a real ask over `ask.register` and assert the registry's own answered event and persisted draft, so nothing reassigns the frozen contextBridge API.
