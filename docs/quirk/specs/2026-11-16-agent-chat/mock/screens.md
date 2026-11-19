# Screens (mock v2)

## Chat session (Claude Code) (`chat`)

Run a session: send a prompt, watch the turn as grouped activity and host-drawn cards, then see what changed.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | working |  |
| state | empty |  |
| state | error |  |
| skipped state | loading | the transcript loads from the local journal; the working state covers streaming |
| element | Session tabs with backend names (`session-tabs`) | Tabs |
| element | Session header: backend, model, needs-you count (`session-header`) | SectionHeader |
| element | Your message (`user-message`) | gap |
| element | Agent prose (markdown) (`agent-prose`) | gap |
| element | Folded tool activity (`activity-group`) | gap |
| element | File change card (`file-change-card`) | gap |
| element | Test results card (`test-card`) | gap |
| element | Steps card (agent todo list) (`steps-card`) | gap |
| element | End-of-turn changes card (`changes-card`) | ReviewCard |
| element | Composer (`composer`) | TextArea |
| element | Backend chip, model, mode, attach (`composer-controls`) | SelectField |
| element | Stop the turn (`stop-button`) | Button |
| element | Queued message with Steer now (`queued-message`) | gap |
| element | Pick a backend for a new chat (`agent-picker`) | gap |
| element | Backend exited row (`backend-error`) | InlineError |

## Approvals and questions (Codex) (`needs-you`)

Answer what an agent is waiting on without leaving the transcript.

| Kind | Name | Notes |
|---|---|---|
| state | approval | default |
| state | question |  |
| state | answered |  |
| skipped state | empty | with nothing waiting, nothing renders here; the chat screen covers it |
| element | Needs-you count in the header (`needs-you-badge`) | Badge |
| element | Approval card (`approval-card`) | AskCard |
| element | Allow once, Allow for session, Deny (`approval-actions`) | SplitButton |
| element | Deny reason field (`deny-reason`) | TextField |
| element | Question form from the agent (`question-card`) | AskCard |
| element | Question fields (`question-fields`) | QuestionField |
| element | Answered record (`answered-record`) | gap |
| element | Also in the Questions panel (`questions-panel-link`) | gap |

## Agent-drawn views (omp) (`agent-view`)

Show UI the agent built with quirky view, inline or in the Views pane as the agent chooses, let you move it either way, and fail visibly when a view is invalid.

| Kind | Name | Notes |
|---|---|---|
| state | inline | default |
| state | pane |  |
| state | invalid |  |
| skipped state | loading | views render only after the whole spec validates, so there is no partial state |
| element | Agent view card (`view-card`) | gap |
| element | By-agent marker (`view-author`) | Badge |
| element | Stat tiles (`view-stats`) | gap |
| element | Bar chart (`view-chart`) | gap |
| element | Table (`view-table`) | gap |
| element | Buttons that send actions to the agent (`view-actions`) | Button |
| element | Move to pane (`pin-to-pane`) | IconButton |
| element | Views pane (`views-pane`) | ToolPanelFrame |
| element | Transcript record of a view the agent opened in the pane (`placement-record`) | ListRow |
| element | Tabs for several views (`views-tabs`) | ToolPanelTabs |
| element | Updated N times marker (`view-updated`) | gap |
| element | View failed to render (`view-error`) | InlineError |
| element | Show source (`view-source`) | gap |

## Reviewing a turn (Claude Code) (`turn-review`)

Look at what one turn changed and send line notes back to the agent.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | commenting |  |
| state | sent |  |
| skipped state | empty | a turn with no file changes shows no changes card |
| element | Changed files (`changes-files`) | ListRow |
| element | Inline diff (`inline-diff`) | DiffPane |
| element | Line comment box (`line-comment`) | NoteCards |
| element | Notes count (`notes-pill`) | NotesPill |
| element | Send notes to the agent (`send-notes`) | SendMenu |
| element | Open in Changes panel (`open-changes-panel`) | Button |

## Composer across backends (pi) (`composer`)

Show how controls change per backend and how unsupported ones explain themselves.

| Kind | Name | Notes |
|---|---|---|
| state | pi | default |
| state | claude-code |  |
| state | mention |  |
| skipped state | error | send errors keep your text and show a toast, as today |
| element | Backend chip (`backend-chip`) | ScopeChip |
| element | Model picker (`model-picker`) | SelectField |
| element | Permission mode (`mode-picker`) | SelectField |
| element | Plan mode toggle (`plan-toggle`) | gap |
| element | Why a control is off (`disabled-reason`) | gap |
| element | Attach files or images (`attach`) | IconButton |
| element | @file mention list (`mention-popover`) | Menu |

## Gaps

- Chat session (Claude Code) / Your message (`user-message`)
- Chat session (Claude Code) / Agent prose (markdown) (`agent-prose`)
- Chat session (Claude Code) / Folded tool activity (`activity-group`)
- Chat session (Claude Code) / File change card (`file-change-card`)
- Chat session (Claude Code) / Test results card (`test-card`)
- Chat session (Claude Code) / Steps card (agent todo list) (`steps-card`)
- Chat session (Claude Code) / Queued message with Steer now (`queued-message`)
- Chat session (Claude Code) / Pick a backend for a new chat (`agent-picker`)
- Approvals and questions (Codex) / Answered record (`answered-record`)
- Approvals and questions (Codex) / Also in the Questions panel (`questions-panel-link`)
- Agent-drawn views (omp) / Agent view card (`view-card`)
- Agent-drawn views (omp) / Stat tiles (`view-stats`)
- Agent-drawn views (omp) / Bar chart (`view-chart`)
- Agent-drawn views (omp) / Table (`view-table`)
- Agent-drawn views (omp) / Updated N times marker (`view-updated`)
- Agent-drawn views (omp) / Show source (`view-source`)
- Composer across backends (pi) / Plan mode toggle (`plan-toggle`)
- Composer across backends (pi) / Why a control is off (`disabled-reason`)
