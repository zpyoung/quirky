# Screens (mock v1)

## Chat with plan panel (`chat-plan`)

Read Claude's plan beside the conversation, keep talking about it, and approve it with one of three exits.

| Kind | Name | Notes |
|---|---|---|
| state | waiting | default |
| state | planning |  |
| state | keep-planning |  |
| state | revised |  |
| state | approved |  |
| state | not-answered |  |
| skipped state | empty | the panel only opens once a plan exists; before that the chat looks as it does today, plus the Plan badge |
| skipped state | error | a plan that can't be read shows as a transcript error row, not a panel state |
| element | Plan chip in the chat header (`header-plan-chip`) | gap |
| element | One-line plan row in the transcript (`transcript-plan-row`) | gap |
| element | Mode badge in the composer (`mode-badge`) | ModeBadges |
| element | Composer (`composer`) | Composer |
| element | Plan panel (`panel`) | gap |
| element | Version and status marker (`panel-version`) | gap |
| element | Rendered plan (`panel-body`) | Prose |
| element | Open file link (`panel-file-link`) | gap |
| element | Approve, auto mode (`approve-auto`) | gap |
| element | Approve, review edits (`approve-review`) | gap |
| element | Keep planning (`keep-planning`) | gap |
| element | Keep planning feedback box (`feedback-box`) | gap |
| element | Earlier versions collapsed as Revised (`revised-rows`) | gap |
| element | Not answered notice after resume (`not-answered-note`) | gap |

## Mode picker (`mode-picker`)

Pick one permission mode, Plan included, from the composer's settings popover; Shift+Tab cycles the same list.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | auto-unavailable |  |
| skipped state | empty | Claude always reports at least Ask, Accept edits and Plan |
| skipped state | loading | modes come from capabilities already loaded with the chat |
| skipped state | error | a failed switch reverts the pick, as the popover does today |
| element | Settings chip (`settings-chip`) | SettingsChip |
| element | Mode list (`mode-list`) | SettingsChip |
| element | Auto option (`mode-auto`) | SettingsChip |
| element | Shift+Tab hint (`shift-tab-hint`) | gap |

## Narrow window (`narrow`)

Keep the plan reachable when the chat is too narrow for a side panel.

| Kind | Name | Notes |
|---|---|---|
| state | drawer-open | default |
| state | drawer-closed |  |
| skipped state | empty | same as the wide layout |
| skipped state | error | same as the wide layout |
| element | Plan drawer (`drawer`) | gap |
| element | Plan chip in the chat header (`header-plan-chip`) | gap |

## Gaps

- Chat with plan panel / Plan chip in the chat header (`header-plan-chip`)
- Chat with plan panel / One-line plan row in the transcript (`transcript-plan-row`)
- Chat with plan panel / Plan panel (`panel`)
- Chat with plan panel / Version and status marker (`panel-version`)
- Chat with plan panel / Open file link (`panel-file-link`)
- Chat with plan panel / Approve, auto mode (`approve-auto`)
- Chat with plan panel / Approve, review edits (`approve-review`)
- Chat with plan panel / Keep planning (`keep-planning`)
- Chat with plan panel / Keep planning feedback box (`feedback-box`)
- Chat with plan panel / Earlier versions collapsed as Revised (`revised-rows`)
- Chat with plan panel / Not answered notice after resume (`not-answered-note`)
- Mode picker / Shift+Tab hint (`shift-tab-hint`)
- Narrow window / Plan drawer (`drawer`)
- Narrow window / Plan chip in the chat header (`header-plan-chip`)
