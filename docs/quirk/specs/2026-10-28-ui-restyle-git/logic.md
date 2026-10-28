# Git, Reviews and Checks graphite restyle

Status: Approved parent design applied autonomously under LOOP.md, 2026-10-28.

## Purpose and conceptual model

Apply [the approved redesign](../2026-10-28-ui-redesign/logic.md) to all registered desktop surfaces owned by quirky.git and quirky.reviews. quirky.checks is the backend check runner, not a second Checks panel. The host retains tool placement, title bar, stripes, view tabs, appearance and persistent layout. Plugins retain feature state and actions.

## Scope and non-goals

In scope: Git source control, notes, diff/conflict/combined views, AI forms and dialogs; Reviews detail, conversation/files/checks tabs, creation/settings, Checks panel and agent dialog; opt all three named plugins into canonical UI lint.

Non-goals: changing Git/hosting/check runner APIs, feature behavior, stable contribution IDs, keyboard shortcuts, phone UI, shell layout authority, or adding another check-runner UI. No provider credentials or real user repositories/homes are used in verification.

## Key decisions and rationale

1. Reuse @quirky/ui's existing fifteen controlled components and its public stylesheet. Reject plugin-private CSS or a parallel toolkit because they violate the approved contract.
2. Compose shared rows, badges/status dots, headers, buttons, fields, forms, tabs, dialogs and empty states. Native textarea/select/checkbox controls may live in shared FormRow with shared field classes; their labels, values and callbacks remain unchanged. Layout-only wrappers may use shared utility classes and token-valued inline geometry, never raw colors/pixels or copied component styling.
3. Keep Changes, Reviews and Checks in their existing right-top defaults and keep diffs in center views. Preserve host IDs and public routing rather than re-registering tools.
4. Preserve semantic status: working/pass/additions green, attention/modified amber, failures/deletions destructive red, completed indigo, idle/queued muted. Both appearances inherit canonical --ui-* tokens.
5. Preserve current consumer-visible control names, worktree ownership, selection, loading/errors, confirmation and disabled rules. Text about implementation may change only where the approved parent gives exact screen copy.

## Data flow

Existing daemon API/event projections remain authoritative. Presentation controls invoke existing callbacks and commands. No new durable or transient feature state authority is introduced. Notes/drafts remain scoped to their existing worktree/session owners; view inputs and routing are unchanged.

## Acceptance scenarios

- AC1 Changes: selected fixture worktree with modified/untracked files opens in right-top. Shared rows display paths and state, existing stage/unstage/discard/commit/remote/history/base-selection actions remain available with the same preconditions. Switching worktrees preserves existing draft/notice boundaries.
- AC2 Empty/loading/error: no selected workspace shows a shared empty state; clean worktree shows `No changes` and one `Open terminal` action; loading is readable; API errors remain visible and actionable rather than being suppressed.
- AC3 Git views: opening file/combined/conflict diffs still uses original view inputs and center routing; notes and AI controls remain fully operable with original confirmation/error behavior. Diff data uses tokenized add/delete/status semantics and readable overflow.
- AC4 Reviews: opening a review retains conversation/checks/files navigation, comments/replies, file filtering, check expansion/grouping, provider actions, external-link routing and confirmation. Creation and hosting settings retain validation, submission, values and errors.
- AC5 Checks: the review-owned Checks tool remains right-top and retains filtering, status/grouping, polling/visibility, check details and agent dialog. quirky.checks runner API/CLI and ownership/cancel semantics are untouched.
- AC6 Appearance: every in-scope panel/view/form uses shared components and tokens in dark/light; no private injected style, plugin CSS, raw colors/pixels or dependence on obsolete presentation selectors remains in migrated markup.
- AC7 Enforcement: scripts/ui-lint-plugins.json contains quirky.git, quirky.reviews and quirky.checks alongside any incoming entries. Canonical UI lint and full typecheck pass without exemptions or baselines.

Data example: a fixture worktree starts with modified README.md and untracked new.ts. Opening Changes shows these paths with their existing stage actions. Staging README.md moves it to Staged, leaving new.ts Untracked; no feature API changes. Dark/light use the same rows, names, actions and data; only canonical tokens change.

## Defect boundaries and verification

No new feature flows are introduced; existing Git/Reviews/Checks behavior tests remain the regression contract. Do not add source-text, copied-markup or incidental-class assertions. Add deterministic consumer-behavior coverage only if a migration changes an uncertain interaction boundary. Build-first forbids suites, formal review rounds and full dogfood campaigns for this item. The landing gate is `bun run typecheck`, including canonical UI lint. A bounded real isolated web-surface smoke supplies actual runtime/visual evidence; full independent golden scoring is not inferred from it.

## Decisions locked

Approved graphite system, fifteen shared components, semantic tokens, right-top tool defaults, center diff views, desktop-only and no feature/shortcut changes. Follow decisions ui-tokens-and-components D2/D4/D10, ui-shell-slots D3/D5/D6, and ui-screenshot-review D5/D8.

## Industry insights

Reuse the approved parent design's cited research; no external research swarm under build-first.

## Deferred ideas

None. Screenshot scoring and end-phase suites remain the standing verification process, not newly invented product work.

## Glossary

Checks tool: quirky.reviews' panel. Checks runner: quirky.checks backend. Shared field: native control styled by public design-system classes inside FormRow.

## Technical contracts and execution

Initial existing contracts were committed before dispatch. Public imports: @quirky/ui and @quirky/ui/styles.css; additive shared-system gaps discovered by implementers are specified below. Shared contract authority: packages/ui/src/design-system/contracts.ts and index.ts. Use ui-stack/ui-cluster/ui-text-muted and existing field classes where appropriate. All static layout dimensions use canonical --ui-* spacing/row/type/border/radius tokens; zero, percentages, unitless flex values and persisted/measured user geometry remain valid layout semantics. Never migrate private CSS into packages/ui under feature selectors.

Three independent components, width cap three, no dependency edges:
- Git panel owner: plugins/quirky.git/src/SourceControl.tsx, src/panel/**, src/notes/** and corresponding panel/notes UI tests, plus window/notes-view.test.ts and window/panel.test.ts for semantic selector migration. test/ui/notes-view.test.ts and support.ts belong exclusively to the view owner.
- Git view/AI owner: plugins/quirky.git/src/view/**, src/ai/**, src/ui.tsx and corresponding view/AI UI tests, including window/{conflict-views,conflicts,hosted-diff,view-combined,view-file}.test.ts for semantic selector migration only.
- Reviews owner: plugins/quirky.reviews/src/** and corresponding Reviews UI tests only, including removing src/style.ts and its injection.

Parent owns scripts/ui-lint-plugins.json, these docs, focused runtime evidence and any narrowly required shared-system gap. Workers use separate /tmp worktrees and absolute tool paths, never commit, run checks, edit protected loop paths or touch another scope. Parent audits all three at a barrier, commits/merges components, removes worktrees, runs final gate, catches up roadmap once and lands canonically.

Acceptance commands (parent only): `bun run ui:lint`; `bun run typecheck`. Focused smoke uses the actual daemon-served renderer with a fresh HOME/QUIRKY_HOME and owned browser; all started processes and scratch homes are removed. Tests remain unrun under build-first. No native-only behavior is changed; Linux/Windows verification is not claimed.

## Status & amendments

2026-10-28: scoped combined logic/technical contract derived from approved parent; self-review found all three named plugins covered, with standalone runner intentionally unchanged except lint enrollment.

### Shared-system gaps resolved during implementation

The existing controls lacked required existing behaviors. Extend the shared Menu family with controlled `ContextMenu` and `ContextMenuItem`: viewport x/y, caller-owned items/onClose, nested hover/keyboard submenus, disabled explanations, current markers, headings, details and badges. Extend triggered `MenuItem` with optional `checked: boolean`, rendering `menuitemcheckbox` only when provided.

Extend the shared dialog family with nonmodal `Popover`: open/label/anchor/optional boundary/onClose/children, portal placement bounded to the supplied element intersected with the viewport, outside-pointer/Escape dismissal, no backdrop or focus trap. Feature contents/actions remain caller-owned. Triggered Menu accepts optional `trigger: ReactNode` separately from its accessible label, preserving compact icon triggers.

Publish `@quirky/ui/editor-theme` exporting `editorTheme: Extension` for tokenized CodeMirror chrome/merge/diff colors, generic `ui-editor-conflict-*` decorations, accent-line highlighting and imperative action-gutter/inline-widget chrome. Language/syntax/document/conflict/note authority remains in the feature. This is an editor-engine adapter, not a plugin CSS exemption. Shared behavior tests cover submenu focus/selection boundaries, checkbox roles/state and nonmodal dismissal; authored but not run under build-first.
