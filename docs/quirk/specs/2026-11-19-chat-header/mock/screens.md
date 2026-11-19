# Screens (mock v2)

## Chat with header (`chat`)

Read a native chat with its status, tokens and cache timing always visible above the transcript.

| Kind | Name | Notes |
|---|---|---|
| state | working | default |
| state | idle-warm |  |
| state | cache-expiring |  |
| state | cache-cold |  |
| state | waiting |  |
| state | new-chat |  |
| state | five-only |  |
| state | codex-idle |  |
| skipped state | loading | the header renders from the session record at once; only the transcript below it loads |
| skipped state | empty | a chat always has a title and status; 'new-chat' covers the before-first-turn case |
| element | Session tabs (title shows here too) (`tabs`) | SessionTabs |
| element | Header row (`header`) | SectionHeader |
| element | Chat title (click to rename) (`title`) | gap |
| element | Status dot, label and elapsed time (`status`) | StatusDot |
| element | Session tokens (hover for breakdown) (`tokens`) | Popover |
| element | Cache countdown (`cache`) | gap |
| element | Plan chip (`plan-chip`) | PlanChip |
| element | Overflow menu button (`menu-btn`) | Menu |
| element | Transcript (starts below the header) (`transcript`) | gap |

## Ended, crashed, offline, failed (`problems`)

Show what the header says when the agent stops, the daemon disconnects or a fork fails.

| Kind | Name | Notes |
|---|---|---|
| state | ended | default |
| state | crashed |  |
| state | offline |  |
| state | fork-failed |  |
| skipped state | loading | the header renders from the session record at once |
| skipped state | empty | a chat always has a title and status |
| element | Header row (`header`) | SectionHeader |
| element | Status dot and label (`status`) | StatusDot |
| element | Cache timer (frozen when offline) (`cache`) | gap |
| element | Session tokens (`tokens`) | Popover |
| element | Overflow menu button (`menu-btn`) | Menu |
| element | Fork error row with Retry (`fork-error`) | InlineError |
| element | Session tabs (`tabs`) | SessionTabs |

## Overflow menu (`menu`)

Rename, fork, open Session info or toggle all events for this chat.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | working |  |
| state | offline |  |
| state | narrow |  |
| skipped state | empty | the menu always has its four actions |
| skipped state | loading | the menu's items are static |
| skipped state | error | a failed action reports where it happened (see problems: fork-failed, rename: failed) |
| element | Rename (`rename-item`) | Menu |
| element | Fork chat (`fork-item`) | Menu |
| element | Session info (`info-item`) | Menu |
| element | Show all events (checked item) (`events-item`) | Menu |
| element | Figures dropped from a narrow header (`dropped-figures`) | gap |

## Rename in place (`rename`)

Change the chat's title from the header; it updates the tab and everywhere else.

| Kind | Name | Notes |
|---|---|---|
| state | editing | default |
| state | saved |  |
| state | failed |  |
| skipped state | empty | an empty title is refused and the old title comes back |
| skipped state | loading | the field stays editable while the save is in flight |
| element | Title field (`title-field`) | TextField |
| element | Rename error (`rename-error`) | InlineError |
| element | Session tabs after rename (`tabs`) | SessionTabs |

## Narrow pane (`narrow`)

Show what the header keeps as the chat narrows or the plan panel opens.

| Kind | Name | Notes |
|---|---|---|
| state | wide | default |
| state | medium |  |
| state | narrow |  |
| state | narrowest |  |
| skipped state | empty | same content as the chat screen, only narrower |
| skipped state | error | states are covered on the chat screen |
| element | Header at this width (`header`) | SectionHeader |
| element | Plan panel taking width (`plan-panel`) | PlanPanel |

## Gaps

- Chat with header / Chat title (click to rename) (`title`)
- Chat with header / Cache countdown (`cache`)
- Ended, crashed, offline, failed / Cache timer (frozen when offline) (`cache`)
- Overflow menu / Figures dropped from a narrow header (`dropped-figures`)
