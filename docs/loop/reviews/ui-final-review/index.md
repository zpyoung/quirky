# Quirky desktop: before and after

Compare every redesign rollout area in dark and light. Click an image for the original 1340 × 600 screenshot; this page is visual evidence, not behavioral sign-off.

| Capture point | Source revision | What it represents |
|---|---|---|
| Before | `98dff3dcb07443154170ccf6cda583c5b0f0c060` | Historical app before the six-slot shell and area restyles, recaptured from Git. |
| After (other areas) | `89321c1eebecd5ebed5888d9bfd0378a22573fd2` | All twelve area restyles integrated, at the immutable capture revision. |
| After (Add project button) | `e39e47881d3139ed7a3475e4e594f1829c7b82b8` | Only the shell and Worktrees pairs refreshed: plain Worktrees list, Add project and options in the header, quiet stripes and neutral Primary badge. |

The images are unaltered real-renderer captures from disposable local workspaces. Fixtures, selected tabs and panel sizes are not identical across revisions; this is not a pixel-diff baseline. [Image provenance and SHA-256 manifest](manifest.json).

Design references only: [approved dark golden](../../../quirk/specs/2026-10-28-ui-redesign/img/golden-dark.png) · [approved light golden](../../../quirk/specs/2026-10-28-ui-redesign/img/golden-light.png). Neither is used as an app screenshot below.

## Areas

- [Window shell and tool slots](#shell)
- [Terminal and terminal dock](#terminal)
- [Editor and Files](#editor)
- [Changes, reviews and checks](#git)
- [Browser](#browser)
- [Worktrees and repositories](#worktrees)
- [Agents, activity and session information](#agents)
- [Orchestration, Heimdall, handoff and loops](#orchestration)
- [Tasks and automations](#tasks)
- [Ledger](#ledger)
- [Accounts and Vault](#accounts)
- [Ask, notifications and Structured sessions](#ask)
- [Settings, Mobile, CLI, palette and workspace extras](#settings)

<a id="shell"></a>

## Window shell and tool slots

Actual host window before and after the six-slot layout; synthetic repository and worktrees. The after pair is the Add project button revision above; other area images retain their earlier capture points. Header options are closed so the list is first. These are actual 1340 × 600 captures, not edited goldens.

### Window shell

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Window shell — dark](images/before/shell/host-shell-dark.png)](images/before/shell/host-shell-dark.png) | [![After — Window shell — dark](images/after/shell/host-shell-dark.png)](images/after/shell/host-shell-dark.png) |
| Light | [![Before — Window shell — light](images/before/shell/host-shell-light.png)](images/before/shell/host-shell-light.png) | [![After — Window shell — light](images/after/shell/host-shell-light.png)](images/after/shell/host-shell-light.png) |

<a id="terminal"></a>

## Terminal and terminal dock

The terminal plugin owns the normal Session worktree view. PTY captures use the public GPU-acceleration off preference to obtain real DOM-rendered text in headless Chromium; composer shown without launching an agent.

The historical supplemental terminal image also contains the isolated Accounts setup card. It is part of the captured app state, not a retouched screenshot.

### Terminal with real PTY output

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Terminal with real PTY output — dark](images/before/terminal/view-quirky-session-worktree-dark.png)](images/before/terminal/view-quirky-session-worktree-dark.png) | [![After — Terminal with real PTY output — dark](images/after/terminal/view-quirky-session-worktree-dark.png)](images/after/terminal/view-quirky-session-worktree-dark.png) |
| Light | [![Before — Terminal with real PTY output — light](images/before/terminal/view-quirky-session-worktree-light.png)](images/before/terminal/view-quirky-session-worktree-light.png) | [![After — Terminal with real PTY output — light](images/after/terminal/view-quirky-session-worktree-light.png)](images/after/terminal/view-quirky-session-worktree-light.png) |

### Terminal Sessions

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Terminal Sessions — dark](images/before/terminal/panel-quirky-terminal-sessions-dark.png)](images/before/terminal/panel-quirky-terminal-sessions-dark.png) | [![After — Terminal Sessions — dark](images/after/terminal/panel-quirky-terminal-sessions-dark.png)](images/after/terminal/panel-quirky-terminal-sessions-dark.png) |
| Light | [![Before — Terminal Sessions — light](images/before/terminal/panel-quirky-terminal-sessions-light.png)](images/before/terminal/panel-quirky-terminal-sessions-light.png) | [![After — Terminal Sessions — light](images/after/terminal/panel-quirky-terminal-sessions-light.png)](images/after/terminal/panel-quirky-terminal-sessions-light.png) |

### Quick Commands

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Quick Commands — dark](images/before/terminal/panel-quirky-terminal-quick-commands-dark.png)](images/before/terminal/panel-quirky-terminal-quick-commands-dark.png) | [![After — Quick Commands — dark](images/after/terminal/panel-quirky-terminal-quick-commands-dark.png)](images/after/terminal/panel-quirky-terminal-quick-commands-dark.png) |
| Light | [![Before — Quick Commands — light](images/before/terminal/panel-quirky-terminal-quick-commands-light.png)](images/before/terminal/panel-quirky-terminal-quick-commands-light.png) | [![After — Quick Commands — light](images/after/terminal/panel-quirky-terminal-quick-commands-light.png)](images/after/terminal/panel-quirky-terminal-quick-commands-light.png) |

### Terminal Dock Composer

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Terminal Dock Composer — dark](images/before/terminal/view-quirky-terminal-dock-composer-dark.png)](images/before/terminal/view-quirky-terminal-dock-composer-dark.png) | [![After — Terminal Dock Composer — dark](images/after/terminal/view-quirky-terminal-dock-composer-dark.png)](images/after/terminal/view-quirky-terminal-dock-composer-dark.png) |
| Light | [![Before — Terminal Dock Composer — light](images/before/terminal/view-quirky-terminal-dock-composer-light.png)](images/before/terminal/view-quirky-terminal-dock-composer-light.png) | [![After — Terminal Dock Composer — light](images/after/terminal/view-quirky-terminal-dock-composer-light.png)](images/after/terminal/view-quirky-terminal-dock-composer-light.png) |

<a id="editor"></a>

## Editor and Files

Real fixture source buffer and repository files; no file from a personal workspace.

### Editor Document

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Editor Document — dark](images/before/editor/view-quirky-editor-document-dark.png)](images/before/editor/view-quirky-editor-document-dark.png) | [![After — Editor Document — dark](images/after/editor/view-quirky-editor-document-dark.png)](images/after/editor/view-quirky-editor-document-dark.png) |
| Light | [![Before — Editor Document — light](images/before/editor/view-quirky-editor-document-light.png)](images/before/editor/view-quirky-editor-document-light.png) | [![After — Editor Document — light](images/after/editor/view-quirky-editor-document-light.png)](images/after/editor/view-quirky-editor-document-light.png) |

### Explorer

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Explorer — dark](images/before/editor/panel-quirky-editor-explorer-dark.png)](images/before/editor/panel-quirky-editor-explorer-dark.png) | [![After — Explorer — dark](images/after/editor/panel-quirky-editor-explorer-dark.png)](images/after/editor/panel-quirky-editor-explorer-dark.png) |
| Light | [![Before — Explorer — light](images/before/editor/panel-quirky-editor-explorer-light.png)](images/before/editor/panel-quirky-editor-explorer-light.png) | [![After — Explorer — light](images/after/editor/panel-quirky-editor-explorer-light.png)](images/after/editor/panel-quirky-editor-explorer-light.png) |

<a id="git"></a>

## Changes, reviews and checks

Changes and diffs use the local fixture repository. Checks and Pull request are contributions of quirky.reviews; no real hosted review is modified.

The no-origin hosted-lookup message is an intentional fixture limitation; local changed and untracked files are real.

### Source control

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Source control — dark](images/before/git/panel-quirky-git-source-control-dark.png)](images/before/git/panel-quirky-git-source-control-dark.png) | [![After — Source control — dark](images/after/git/panel-quirky-git-source-control-dark.png)](images/after/git/panel-quirky-git-source-control-dark.png) |
| Light | [![Before — Source control — light](images/before/git/panel-quirky-git-source-control-light.png)](images/before/git/panel-quirky-git-source-control-light.png) | [![After — Source control — light](images/after/git/panel-quirky-git-source-control-light.png)](images/after/git/panel-quirky-git-source-control-light.png) |

### Diff

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Diff — dark](images/before/git/view-quirky-git-diff-dark.png)](images/before/git/view-quirky-git-diff-dark.png) | [![After — Diff — dark](images/after/git/view-quirky-git-diff-dark.png)](images/after/git/view-quirky-git-diff-dark.png) |
| Light | [![Before — Diff — light](images/before/git/view-quirky-git-diff-light.png)](images/before/git/view-quirky-git-diff-light.png) | [![After — Diff — light](images/after/git/view-quirky-git-diff-light.png)](images/after/git/view-quirky-git-diff-light.png) |

### Checks

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Checks — dark](images/before/git/panel-quirky-reviews-checks-dark.png)](images/before/git/panel-quirky-reviews-checks-dark.png) | [![After — Checks — dark](images/after/git/panel-quirky-reviews-checks-dark.png)](images/after/git/panel-quirky-reviews-checks-dark.png) |
| Light | [![Before — Checks — light](images/before/git/panel-quirky-reviews-checks-light.png)](images/before/git/panel-quirky-reviews-checks-light.png) | [![After — Checks — light](images/after/git/panel-quirky-reviews-checks-light.png)](images/after/git/panel-quirky-reviews-checks-light.png) |

### Pull request

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Pull request — dark](images/before/git/view-quirky-reviews-review-dark.png)](images/before/git/view-quirky-reviews-review-dark.png) | [![After — Pull request — dark](images/after/git/view-quirky-reviews-review-dark.png)](images/after/git/view-quirky-reviews-review-dark.png) |
| Light | [![Before — Pull request — light](images/before/git/view-quirky-reviews-review-light.png)](images/before/git/view-quirky-reviews-review-light.png) | [![After — Pull request — light](images/after/git/view-quirky-reviews-review-light.png)](images/after/git/view-quirky-reviews-review-light.png) |

<a id="browser"></a>

## Browser

Real Browser Watch toolbar and JPEG stream from an owned loopback /review page, not a native WKWebView screenshot or a copied browser component.

### Browser Watch

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Browser Watch — dark](images/before/browser/view-quirky-browser-page-dark.png)](images/before/browser/view-quirky-browser-page-dark.png) | [![After — Browser Watch — dark](images/after/browser/view-quirky-browser-page-dark.png)](images/after/browser/view-quirky-browser-page-dark.png) |
| Light | [![Before — Browser Watch — light](images/before/browser/view-quirky-browser-page-light.png)](images/before/browser/view-quirky-browser-page-light.png) | [![After — Browser Watch — light](images/after/browser/view-quirky-browser-page-light.png)](images/after/browser/view-quirky-browser-page-light.png) |

<a id="worktrees"></a>

## Worktrees and repositories

Repository and three real Git worktrees registered through public APIs. Repository presentation is in Worktrees, not a separate invented repo panel. The after pair is the Add project button revision above, with Changes minimized.

### Repository and worktree rows

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Repository and worktree rows — dark](images/before/worktrees/sidebar-section-quirky-worktree-worktrees-dark.png)](images/before/worktrees/sidebar-section-quirky-worktree-worktrees-dark.png) | [![After — Repository and worktree rows — dark](images/after/worktrees/sidebar-section-quirky-worktree-worktrees-dark.png)](images/after/worktrees/sidebar-section-quirky-worktree-worktrees-dark.png) |
| Light | [![Before — Repository and worktree rows — light](images/before/worktrees/sidebar-section-quirky-worktree-worktrees-light.png)](images/before/worktrees/sidebar-section-quirky-worktree-worktrees-light.png) | [![After — Repository and worktree rows — light](images/after/worktrees/sidebar-section-quirky-worktree-worktrees-light.png)](images/after/worktrees/sidebar-section-quirky-worktree-worktrees-light.png) |

<a id="agents"></a>

## Agents, activity and session information

Agents settings, Activity, Dashboard, Session info and local history. Normal session terminal pixels are under Terminal; Structured session rendering is under Ask and notifications, without duplicate screenshots.

### Agents

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Agents — dark](images/before/agents/view-quirky-agents-settings-dark.png)](images/before/agents/view-quirky-agents-settings-dark.png) | [![After — Agents — dark](images/after/agents/view-quirky-agents-settings-dark.png)](images/after/agents/view-quirky-agents-settings-dark.png) |
| Light | [![Before — Agents — light](images/before/agents/view-quirky-agents-settings-light.png)](images/before/agents/view-quirky-agents-settings-light.png) | [![After — Agents — light](images/after/agents/view-quirky-agents-settings-light.png)](images/after/agents/view-quirky-agents-settings-light.png) |

### Activity

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Activity — dark](images/before/agents/view-quirky-agent-status-activity-dark.png)](images/before/agents/view-quirky-agent-status-activity-dark.png) | [![After — Activity — dark](images/after/agents/view-quirky-agent-status-activity-dark.png)](images/after/agents/view-quirky-agent-status-activity-dark.png) |
| Light | [![Before — Activity — light](images/before/agents/view-quirky-agent-status-activity-light.png)](images/before/agents/view-quirky-agent-status-activity-light.png) | [![After — Activity — light](images/after/agents/view-quirky-agent-status-activity-light.png)](images/after/agents/view-quirky-agent-status-activity-light.png) |

### Agent Dashboard

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Agent Dashboard — dark](images/before/agents/view-quirky-agent-status-dashboard-dark.png)](images/before/agents/view-quirky-agent-status-dashboard-dark.png) | [![After — Agent Dashboard — dark](images/after/agents/view-quirky-agent-status-dashboard-dark.png)](images/after/agents/view-quirky-agent-status-dashboard-dark.png) |
| Light | [![Before — Agent Dashboard — light](images/before/agents/view-quirky-agent-status-dashboard-light.png)](images/before/agents/view-quirky-agent-status-dashboard-light.png) | [![After — Agent Dashboard — light](images/after/agents/view-quirky-agent-status-dashboard-light.png)](images/after/agents/view-quirky-agent-status-dashboard-light.png) |

### Session Info

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Session Info — dark](images/before/agents/panel-quirky-session-info-info-dark.png)](images/before/agents/panel-quirky-session-info-info-dark.png) | [![After — Session Info — dark](images/after/agents/panel-quirky-session-info-info-dark.png)](images/after/agents/panel-quirky-session-info-info-dark.png) |
| Light | [![Before — Session Info — light](images/before/agents/panel-quirky-session-info-info-light.png)](images/before/agents/panel-quirky-session-info-info-light.png) | [![After — Session Info — light](images/after/agents/panel-quirky-session-info-info-light.png)](images/after/agents/panel-quirky-session-info-info-light.png) |

### Session History

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Session History — dark](images/before/agents/view-quirky-session-info-history-dark.png)](images/before/agents/view-quirky-session-info-history-dark.png) | [![After — Session History — dark](images/after/agents/view-quirky-session-info-history-dark.png)](images/after/agents/view-quirky-session-info-history-dark.png) |
| Light | [![Before — Session History — light](images/before/agents/view-quirky-session-info-history-light.png)](images/before/agents/view-quirky-session-info-history-light.png) | [![After — Session History — light](images/after/agents/view-quirky-session-info-history-light.png)](images/after/agents/view-quirky-session-info-history-light.png) |

<a id="orchestration"></a>

## Orchestration, Heimdall, handoff and loops

Configuration and setup surfaces only; no real orchestration, handoff, loop or provider agent is started.

### Orchestration

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Orchestration — dark](images/before/orchestration/view-quirky-orchestration-settings-dark.png)](images/before/orchestration/view-quirky-orchestration-settings-dark.png) | [![After — Orchestration — dark](images/after/orchestration/view-quirky-orchestration-settings-dark.png)](images/after/orchestration/view-quirky-orchestration-settings-dark.png) |
| Light | [![Before — Orchestration — light](images/before/orchestration/view-quirky-orchestration-settings-light.png)](images/before/orchestration/view-quirky-orchestration-settings-light.png) | [![After — Orchestration — light](images/after/orchestration/view-quirky-orchestration-settings-light.png)](images/after/orchestration/view-quirky-orchestration-settings-light.png) |

### Heimdall Fleet

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Heimdall Fleet — dark](images/before/orchestration/view-quirky-heimdall-fleet-dark.png)](images/before/orchestration/view-quirky-heimdall-fleet-dark.png) | [![After — Heimdall Fleet — dark](images/after/orchestration/view-quirky-heimdall-fleet-dark.png)](images/after/orchestration/view-quirky-heimdall-fleet-dark.png) |
| Light | [![Before — Heimdall Fleet — light](images/before/orchestration/view-quirky-heimdall-fleet-light.png)](images/before/orchestration/view-quirky-heimdall-fleet-light.png) | [![After — Heimdall Fleet — light](images/after/orchestration/view-quirky-heimdall-fleet-light.png)](images/after/orchestration/view-quirky-heimdall-fleet-light.png) |

### Session handoff

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Session handoff — dark](images/before/orchestration/view-quirky-handoff-settings-dark.png)](images/before/orchestration/view-quirky-handoff-settings-dark.png) | [![After — Session handoff — dark](images/after/orchestration/view-quirky-handoff-settings-dark.png)](images/after/orchestration/view-quirky-handoff-settings-dark.png) |
| Light | [![Before — Session handoff — light](images/before/orchestration/view-quirky-handoff-settings-light.png)](images/before/orchestration/view-quirky-handoff-settings-light.png) | [![After — Session handoff — light](images/after/orchestration/view-quirky-handoff-settings-light.png)](images/after/orchestration/view-quirky-handoff-settings-light.png) |

### New loop setup

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — New loop setup — dark](images/before/orchestration/overlay-quirky-loops-dialogs-dark.png)](images/before/orchestration/overlay-quirky-loops-dialogs-dark.png) | [![After — New loop setup — dark](images/after/orchestration/overlay-quirky-loops-dialogs-dark.png)](images/after/orchestration/overlay-quirky-loops-dialogs-dark.png) |
| Light | [![Before — New loop setup — light](images/before/orchestration/overlay-quirky-loops-dialogs-light.png)](images/before/orchestration/overlay-quirky-loops-dialogs-light.png) | [![After — New loop setup — light](images/after/orchestration/overlay-quirky-loops-dialogs-light.png)](images/after/orchestration/overlay-quirky-loops-dialogs-light.png) |

<a id="tasks"></a>

## Tasks and automations

Real mounted workspace tools with synthetic/empty local state, not a hosted account.

### Tasks · Projects

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Tasks · Projects — dark](images/before/tasks/view-quirky-tasks-tasks-dark.png)](images/before/tasks/view-quirky-tasks-tasks-dark.png) | [![After — Tasks · Projects — dark](images/after/tasks/view-quirky-tasks-tasks-dark.png)](images/after/tasks/view-quirky-tasks-tasks-dark.png) |
| Light | [![Before — Tasks · Projects — light](images/before/tasks/view-quirky-tasks-tasks-light.png)](images/before/tasks/view-quirky-tasks-tasks-light.png) | [![After — Tasks · Projects — light](images/after/tasks/view-quirky-tasks-tasks-light.png)](images/after/tasks/view-quirky-tasks-tasks-light.png) |

### Automations

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Automations — dark](images/before/tasks/view-quirky-automations-automations-dark.png)](images/before/tasks/view-quirky-automations-automations-dark.png) | [![After — Automations — dark](images/after/tasks/view-quirky-automations-automations-dark.png)](images/after/tasks/view-quirky-automations-automations-dark.png) |
| Light | [![Before — Automations — light](images/before/tasks/view-quirky-automations-automations-light.png)](images/before/tasks/view-quirky-automations-automations-light.png) | [![After — Automations — light](images/after/tasks/view-quirky-automations-automations-light.png)](images/after/tasks/view-quirky-automations-automations-light.png) |

<a id="ledger"></a>

## Ledger

The actual Ledger view with local fixture state; no real project ledger is edited.

### Project Ledger

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Project Ledger — dark](images/before/ledger/view-quirky-ledger-ledger-dark.png)](images/before/ledger/view-quirky-ledger-ledger-dark.png) | [![After — Project Ledger — dark](images/after/ledger/view-quirky-ledger-ledger-dark.png)](images/after/ledger/view-quirky-ledger-ledger-dark.png) |
| Light | [![Before — Project Ledger — light](images/before/ledger/view-quirky-ledger-ledger-light.png)](images/before/ledger/view-quirky-ledger-ledger-light.png) | [![After — Project Ledger — light](images/after/ledger/view-quirky-ledger-ledger-light.png)](images/after/ledger/view-quirky-ledger-ledger-light.png) |

<a id="accounts"></a>

## Accounts and Vault

Real Accounts settings and Vault history/search-consent surfaces. Credential stores are isolated; Keychain unavailable labels reflect the fail-closed capture stub. No personal account, history or secret is shown.

### AI Provider Accounts

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — AI Provider Accounts — dark](images/before/accounts/view-quirky-accounts-settings-dark.png)](images/before/accounts/view-quirky-accounts-settings-dark.png) | [![After — AI Provider Accounts — dark](images/after/accounts/view-quirky-accounts-settings-dark.png)](images/after/accounts/view-quirky-accounts-settings-dark.png) |
| Light | [![Before — AI Provider Accounts — light](images/before/accounts/view-quirky-accounts-settings-light.png)](images/before/accounts/view-quirky-accounts-settings-light.png) | [![After — AI Provider Accounts — light](images/after/accounts/view-quirky-accounts-settings-light.png)](images/after/accounts/view-quirky-accounts-settings-light.png) |

### Agent Session History

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Agent Session History — dark](images/before/accounts/panel-quirky-vault-history-dark.png)](images/before/accounts/panel-quirky-vault-history-dark.png) | [![After — Agent Session History — dark](images/after/accounts/panel-quirky-vault-history-dark.png)](images/after/accounts/panel-quirky-vault-history-dark.png) |
| Light | [![Before — Agent Session History — light](images/before/accounts/panel-quirky-vault-history-light.png)](images/before/accounts/panel-quirky-vault-history-light.png) | [![After — Agent Session History — light](images/after/accounts/panel-quirky-vault-history-light.png)](images/after/accounts/panel-quirky-vault-history-light.png) |

### Agent Session Search

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Agent Session Search — dark](images/before/accounts/view-quirky-vault-search-settings-dark.png)](images/before/accounts/view-quirky-vault-search-settings-dark.png) | [![After — Agent Session Search — dark](images/after/accounts/view-quirky-vault-search-settings-dark.png)](images/after/accounts/view-quirky-vault-search-settings-dark.png) |
| Light | [![Before — Agent Session Search — light](images/before/accounts/view-quirky-vault-search-settings-light.png)](images/before/accounts/view-quirky-vault-search-settings-light.png) | [![After — Agent Session Search — light](images/after/accounts/view-quirky-vault-search-settings-light.png)](images/after/accounts/view-quirky-vault-search-settings-light.png) |

<a id="ask"></a>

## Ask, notifications and Structured sessions

Questions tool, notification settings and the session plugin’s Structured view. Empty/ended fixtures do not certify an actual provider approval turn or OS notification.

### Questions

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Questions — dark](images/before/ask/panel-quirky-ask-questions-dark.png)](images/before/ask/panel-quirky-ask-questions-dark.png) | [![After — Questions — dark](images/after/ask/panel-quirky-ask-questions-dark.png)](images/after/ask/panel-quirky-ask-questions-dark.png) |
| Light | [![Before — Questions — light](images/before/ask/panel-quirky-ask-questions-light.png)](images/before/ask/panel-quirky-ask-questions-light.png) | [![After — Questions — light](images/after/ask/panel-quirky-ask-questions-light.png)](images/after/ask/panel-quirky-ask-questions-light.png) |

### Notifications

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Notifications — dark](images/before/ask/view-quirky-notifications-settings-dark.png)](images/before/ask/view-quirky-notifications-settings-dark.png) | [![After — Notifications — dark](images/after/ask/view-quirky-notifications-settings-dark.png)](images/after/ask/view-quirky-notifications-settings-dark.png) |
| Light | [![Before — Notifications — light](images/before/ask/view-quirky-notifications-settings-light.png)](images/before/ask/view-quirky-notifications-settings-light.png) | [![After — Notifications — light](images/after/ask/view-quirky-notifications-settings-light.png)](images/after/ask/view-quirky-notifications-settings-light.png) |

### Structured session

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Structured session — dark](images/before/ask/view-quirky-session-structured-dark.png)](images/before/ask/view-quirky-session-structured-dark.png) | [![After — Structured session — dark](images/after/ask/view-quirky-session-structured-dark.png)](images/after/ask/view-quirky-session-structured-dark.png) |
| Light | [![Before — Structured session — light](images/before/ask/view-quirky-session-structured-light.png)](images/before/ask/view-quirky-session-structured-light.png) | [![After — Structured session — light](images/after/ask/view-quirky-session-structured-light.png)](images/after/ask/view-quirky-session-structured-light.png) |

<a id="settings"></a>

## Settings, Mobile, CLI, palette and workspace extras

Desktop contribution of Mobile only; the phone app is unchanged and pairing remains off. Sidebar extras owns the Sidebar section separators checkbox visible in Settings; its legacy Source Control activity registration is projected into Changes (shown above), and current Activity filters are shown with Worktrees. No separate legacy mount is invented.

### Settings

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Settings — dark](images/before/settings/host-settings-dark.png)](images/before/settings/host-settings-dark.png) | [![After — Settings — dark](images/after/settings/host-settings-dark.png)](images/after/settings/host-settings-dark.png) |
| Light | [![Before — Settings — light](images/before/settings/host-settings-light.png)](images/before/settings/host-settings-light.png) | [![After — Settings — light](images/after/settings/host-settings-light.png)](images/after/settings/host-settings-light.png) |

### Mobile

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Mobile — dark](images/before/settings/view-quirky-mobile-page-dark.png)](images/before/settings/view-quirky-mobile-page-dark.png) | [![After — Mobile — dark](images/after/settings/view-quirky-mobile-page-dark.png)](images/after/settings/view-quirky-mobile-page-dark.png) |
| Light | [![Before — Mobile — light](images/before/settings/view-quirky-mobile-page-light.png)](images/before/settings/view-quirky-mobile-page-light.png) | [![After — Mobile — light](images/after/settings/view-quirky-mobile-page-light.png)](images/after/settings/view-quirky-mobile-page-light.png) |

### CLI and Runtime Profiles

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — CLI and Runtime Profiles — dark](images/before/settings/view-quirky-cli-settings-dark.png)](images/before/settings/view-quirky-cli-settings-dark.png) | [![After — CLI and Runtime Profiles — dark](images/after/settings/view-quirky-cli-settings-dark.png)](images/after/settings/view-quirky-cli-settings-dark.png) |
| Light | [![Before — CLI and Runtime Profiles — light](images/before/settings/view-quirky-cli-settings-light.png)](images/before/settings/view-quirky-cli-settings-light.png) | [![After — CLI and Runtime Profiles — light](images/after/settings/view-quirky-cli-settings-light.png)](images/after/settings/view-quirky-cli-settings-light.png) |

### Command palette

| Theme | Before | After |
|---|---|---|
| Dark | [![Before — Command palette — dark](images/before/settings/host-palette-dark.png)](images/before/settings/host-palette-dark.png) | [![After — Command palette — dark](images/after/settings/host-palette-dark.png)](images/after/settings/host-palette-dark.png) |
| Light | [![Before — Command palette — light](images/before/settings/host-palette-light.png)](images/before/settings/host-palette-light.png) | [![After — Command palette — light](images/after/settings/host-palette-light.png)](images/after/settings/host-palette-light.png) |

## What these captures do not prove

- Every rollout area is represented, but not every dialog or data state. Account-switch dialogs, unsaved-close confirmation, authenticated review creation/settings, recorded transcripts, dispatch-bound remote output and running-loop details are not pictured.
- Empty states are deliberate: Tasks has no selected remote project; Ask has no pending question; Ledger and history have no personal records. Loop setup has no available provider agent and was never started.
- Some surrounding panels show background metadata loading. Those pixels are retained and are not a claim that the background operation passed. Intended-area Tasks loading skeletons and unproved GPU-auto terminal images were excluded.
- Before supplemental captures may show the Accounts setup card or Keychain unavailable. The private security stub fails closed; these labels do not report on a real account or personal Keychain.
- Browser content is a matching unstyled loopback fixture delivered by the genuine Watch stream. Native WKWebView, OS window chrome, menus, notification banners and the phone app are not represented.
- No test suite, independent golden-model score, native certification or approval on the user’s behalf is claimed. UI lint and typecheck are build gates, not visual approval.

[Implementation decisions](../../decisions/ui-final-review.md) · [Artifact scope](../../../quirk/specs/2026-10-28-ui-final-review/logic.md).
