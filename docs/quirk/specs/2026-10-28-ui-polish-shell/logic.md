# Shell polish: plain Worktrees and quiet stripes

**Status:** Autonomously approved under LOOP.md, 2026-10-28. Tech spec required: shell and plugin presentation boundary.

## Why and conceptual model

The approved graphite shell puts the worktree list first. The current published shell captures instead devote most of the panel to filters/options, show tiny dropdown arrows beneath every stripe icon, and highlight Primary as if selected. This item corrects those three presentation defects without changing workspace operations or tool placement authority.

Consumers: desktop users in dark and light themes. Success: plain initial list, one header options affordance, quiet stripes, neutral Primary badge, unchanged access to existing controls, current shell captures and passing UI lint/typecheck.

## Key decisions & rationale

Use one shared options popover opened by an accessible filter/options icon button in the Worktrees panel header. Keep existing workspace settings/filter controls inside it rather than duplicating their state or replacing them with a second settings dialog. An inline expandable block still consumes list space and conflicts with the request; a new modal interrupts lightweight filtering.

Remove the visible stripe dropdown chevrons, not tool movement functionality: retain the existing context-menu route and keyboard access. Primary remains visible using the existing neutral badge variant. Selection keeps its existing accent treatment.

## Behavior & scenarios

### S1: Open Worktrees

Given the synthetic project has main, ui-review-notes and ui-review-ready, opening Worktrees shows its project/worktree rows immediately beneath the host header. Add project, Workspace options, Activity filters, All/Live only/Today/Week/Month, filter checkboxes, Clear filters and More workspace tools are absent from the closed panel body. One labeled options icon is available in the Worktrees header, alongside the existing close control.

### S2: Use and dismiss options

Click the header options icon: all named controls become reachable in a shared popover. Opening existing settings/disclosures and changing filters retains current canonical callbacks, persistence and selected-workspace exceptions. Example: choose an activity filter, dismiss, reopen; the selected filter remains selected. Clear filters restores All and clears filter checkboxes. Escape and outside click dismiss the popover without discarding applied filter changes. Add project continues to open its existing dialog; cancelling it creates no project. Empty/loading/error list behavior is retained; an empty list still has its recovery action.

Escape returns keyboard focus to the header options button, including when focus is inside the popover. Outside-click dismissal does not restore focus to the header button.

### S3: Quiet stripes without losing movement

Every assigned tool on left, right and bottom stripes has one visible icon button and no underneath dropdown chevron. Clicking continues to open/close its slot. The existing tool context menu still exposes move-to-slot actions, including keyboard access, and drag movement continues unchanged.

### S4: Primary identity and themes

Main keeps its Primary label in the neutral badge treatment, with no indigo fill. Selecting a worktree still uses the approved selection treatment. Both dark and light use only shared components/tokens. Recapture the two shell after PNGs at the existing 1340×600 viewport, with the options closed and real synthetic worktree rows visible. Preserve historical before images and accurately update provenance for these two replacements only.

## Data flow

Host tool header renders the plugin-provided options affordance; plugin state and public APIs continue owning worktree preferences and operations. Popover visibility is ephemeral UI state. Stripe menus retain their existing layout API. No daemon protocol, persisted schema, CLI or plugin registration identity changes.

## Scope and non-goals

Only the three requested shell presentation corrections and their evidence. No workspace feature changes, layout defaults, keyboard shortcut changes, additional filters, new plugin, native chrome, phone UI or unrelated restyles. No separate Linux/Windows certification.

## Decisions Locked

- Layout/density: plain list first; options belong behind one header icon, not another permanent toolbar.
- Interaction: existing shared popover semantics, accessible label, Escape/outside dismissal; existing operations are preserved.
- Loading/empty/error: retain existing owner states and recovery, no fake data or suppressed errors.
- Styling: existing shared components and semantic neutral badge only; no raw color/pixel/plugin CSS or lint exemptions.
- Evidence: replace actual shell after screenshots, not goldens or historical before evidence; update affected provenance.

## Industry Insights

Reuse the approved redesign's shared-component and host-owned placement decisions. No external research swarm: LOOP.md names the approved spec and earlier decision logs as the design research.

## Deferred Ideas

None. No unbuilt flow is added by this presentation correction.

## Glossary

- Header options: one accessible icon button in the Worktrees tool header.
- Stripe: host-owned left/right icon column or bottom icon row.
- Neutral badge: existing non-accent semantic badge treatment.

## Status & amendments

2026-10-28: autonomous decisions follow the exact queued request and approved parent spec. Self-review: all three corrections and screenshot/lint acceptance are covered; no unresolved question or feature expansion.

**Amendments:** none.
