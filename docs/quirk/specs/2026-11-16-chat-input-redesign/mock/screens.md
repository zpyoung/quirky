# Screens (mock v1)

## Composer, idle (`composer`)

Write and send a message to the agent: text with live markdown, @ pills, attachments, and the settings chip.

| Kind | Name | Notes |
|---|---|---|
| state | empty | default |
| state | draft |  |
| state | failed |  |
| skipped state | loading | the composer renders with the session; agent options load into the chip without blocking typing |
| element | Composer card (`card`) | gap |
| element | Message editor (markdown styling, pills) (`editor`) | gap |
| element | Agent chip (`agent-chip`) | AgentIcon |
| element | Settings chip (model · effort) (`settings-chip`) | Button |
| element | Attach (+) file picker (`attach`) | IconButton |
| element | Send button (`send`) | IconButton |
| element | @ mention pill (`mention-pill`) | TagChip |
| element | Image attachment chip (`image-chip`) | ScopeChip |
| element | Long-paste file chip (`paste-chip`) | ScopeChip |
| element | Inline send error with Retry (`send-error`) | InlineError |

## Composer, agent working (`working`)

See that the agent is working, stop it, and queue or steer follow-ups.

| Kind | Name | Notes |
|---|---|---|
| state | running | default |
| state | queued |  |
| element | Working indicator and elapsed time (`elapsed`) | StatusDot |
| element | Stop button (`stop`) | IconButton |
| element | Send (queue) button (`send`) | IconButton |
| element | Queued message row (`queue-row`) | ListRow |
| element | Steered row waiting for next tool call (`steer-pending`) | ListRow |
| element | Drag handle to reorder (`drag-handle`) | gap |

## Suggestion list (`suggestions`)

Pick a file with @ or a command or skill with /.

| Kind | Name | Notes |
|---|---|---|
| state | mention | default |
| state | slash |  |
| state | no-match |  |
| element | Suggestion list above the card (`suggest-list`) | Menu |
| element | Group header (Quirky, Claude, Skills) (`suggest-group`) | SectionHeader |
| element | Suggestion row (`suggest-row`) | ListRow |

## Settings chip (`settings`)

Change model, effort, permission mode and plan for the next turn, and see non-default modes at a glance.

| Kind | Name | Notes |
|---|---|---|
| state | popover | default |
| state | badges |  |
| element | Settings popover (`popover`) | Popover |
| element | Model list (`model-list`) | ListRow |
| element | Effort segmented control (`effort-seg`) | gap |
| element | Permission mode list (`mode-list`) | ListRow |
| element | Plan mode switch (`plan-switch`) | gap |
| element | Unsupported row (reason on hover) (`disabled-row`) | ListRow |
| element | Non-default mode badge (`mode-badge`) | Badge |

## Session ended (`ended`)

Resume the session or start a new chat; see what was still queued.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Ended card (`ended-card`) | EmptyState |
| element | Resume button (`resume`) | Button |
| element | New chat button (`new-chat`) | Button |
| element | Read-only queued row (`readonly-row`) | ListRow |

## Gaps

- Composer, idle / Composer card (`card`)
- Composer, idle / Message editor (markdown styling, pills) (`editor`)
- Composer, agent working / Drag handle to reorder (`drag-handle`)
- Settings chip / Effort segmented control (`effort-seg`)
- Settings chip / Plan mode switch (`plan-switch`)
