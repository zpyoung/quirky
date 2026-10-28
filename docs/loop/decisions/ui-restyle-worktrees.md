# ui-restyle-worktrees decisions

## D1: Restyle the existing Worktrees UI owner, not a new repository tool
- **Question:** brainstorming purpose, consumers, scope and default placement
- **Options:** CSS repaint; new repo panel; in-place shared-component migration
- **Chose:** in-place migration, existing Worktrees left-top tool and repo APIs
- **Why:** repo has no UI bundle; all repository operations render under Worktrees. A second tool changes approved behavior and duplicates authority.
- **Evidence:** plugins/quirky.worktree/src/ui.tsx; quirky.repo manifest; ui-shell-slots D1/D3/D6; approved redesign lines23–59,194–202
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an actual repository contribution is introduced
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Keep comfortable name-plus-activity rows and preserve rich tree behavior
- **Question:** layout-style and information-density: row form, metadata priority, narrowing, grouping and activity source
- **Options:** flat single-line tree; expansive cards; shared two-line rows with secondary controls
- **Chose:** comfortable name/activity rows, canonical session activity/idle, shared status/count; retain nesting, groups, metadata, contextual actions and drag/reorder
- **Why:** parent explicitly requires name plus activity; presentation migration cannot remove shipped organization flows
- **Evidence:** approved redesign lines61–75; m1-worktrees D30–D35; Tree.tsx; useWorktreeAttention.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual narrow-panel smoke clips required actions
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D3: Use shared explicit empty/loading/error/form states
- **Question:** selected gray areas: loading pattern, empty state, error state and disabled actions
- **Options:** local decorative panels; hide absent/error data; shared components with preserved retry/cancel/error behavior
- **Chose:** shared components and tokens, Add project empty action, readable real loading/error states, unchanged cancel/trust/destructive semantics
- **Why:** approved design forbids bespoke plugin CSS and feature-behavior changes
- **Evidence:** parent lines83–119,149–164,194–202; shared design-system contracts.ts; existing dialog callbacks
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** shared components cannot represent an existing safety boundary
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D4: Preserve custom identity data while using semantic presentation colors
- **Question:** visual identity and theme behavior: status/project stored colors versus approved fixed palette
- **Options:** remove stored color feature; paint arbitrary values; retain editable identity data and render semantic token accents
- **Chose:** retain labels, icons/emoji, stored values and settings; use shared token colors for visual chrome/status semantics
- **Why:** avoids data loss while honoring the newer approved no-custom-themes/no-raw-colors presentation contract
- **Evidence:** Tree.tsx dynamic identity/status colors; StatusSettingsDialog.tsx; parent lines67–75,85,198–200
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** approved final review explicitly asks to render arbitrary identity colors
- **Source:** assumed — autonomous

## D5: Preserve host framing and existing interaction authority
- **Question:** interaction-style: panel frame, low-frequency options, menus, dialogs and focus
- **Options:** second nested frame; global buttons; existing host frame and shared in-panel controls
- **Chose:** existing frame/IDs/default slot, collapsible low-frequency controls, shared menus/dialogs; retain canonical API callbacks and stacked dialog/focus semantics
- **Why:** only the host places tools and owns layout; no new feature or shortcut is authorized
- **Evidence:** ui-shell-slots D3/D5/D6/D11; parent lines23–59,194–202; worktree Dialog.tsx
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** changed-surface smoke reveals an unreachable existing action
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D6: Use the explicit build-first override and three disjoint implementers
- **Question:** execution preflight, research/review, contracts/spec and verification
- **Options:** ordinary test/review campaign; item-specific build-first with minimum runtime proof
- **Chose:** one combined spec committed before implementation; existing shared signatures unchanged; three OpenAI task workers in isolated external worktrees, no worker checks/commits. Parent shared-style integration, scope audit, canonical UI lint/typecheck and minimum actual browser smoke. No test suites, formal review/backend probes or screenshot-model campaign.
- **Why:** item title explicitly selects build-first, matching authoritative LOOP; developer coding contract still requires real changed-surface proof. Capture-only is not visual sign-off.
- **Evidence:** authoritative LOOP Build first section; claimed queue title; ui-shell-slots D7/D12; ui-tokens-and-components D6/D9
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator changes item verification policy
- **Source:** locked by docs/loop/LOOP.md

## D7: Keep macOS proof and user-state boundaries explicit
- **Question:** platform scope and inherited untracked metadata
- **Options:** ambient profiles; isolated home/process scope; infer all-platform support
- **Chose:** fresh HOME/QUIRKY_HOME and owned browser/processes only; `.serena/` untouched. No native UI additions. Linux/Windows focus/context-menu/layout acceptance remains unverified.
- **Why:** hard loop isolation/platform rules; initial checkout contained only inherited untracked metadata
- **Evidence:** initial git status; LOOP hard rules/platform policy; scripts/ui-review/fixtures.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported platform policy expands
- **Source:** deferred: platform

## Progress
Design/spec/contracts ready for commit. No source implementation yet. Existing public API/component signatures remain authoritative; parent will add only shared generic layout where needed. Next: commit spec/contracts, create three isolated component worktrees, dispatch disjoint tree/dialog/panel slices, integrate at barrier and run typecheck plus minimal real-surface smoke. No suites/reviews are claimed.
