# Screens (mock v1)

## Chat visual panel (`chat-panel`)

Show one visual at full width beside the transcript, with tabs to switch between the plan and the session's pane visuals.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | overflow |  |
| state | steering |  |
| state | done |  |
| state | empty |  |
| state | collapsed |  |
| skipped state | loading | the visual list comes back from a local call before first paint; today's panel has no loading state either |
| skipped state | error | a render failure is shown inside the visual by ViewCard, unchanged by this work |
| element | Tab row (`tab-row`) | Tabs (underline) |
| element | Plan tab (`tab-plan`) | Tabs (underline) |
| element | Tab close x on hover (`tab-close`) | gap |
| element | New or updated dot on a tab (`tab-dot`) | gap |
| element | Dimmed done tab (`tab-done`) | gap |
| element | +N overflow menu with Closed section (`overflow-menu`) | Menu |
| element | Slim row: version stepper and menu (`slim-row`) | IconButton |
| element | Sandbox shield icon (`sandbox-icon`) | ControlIcon |
| element | Card ... menu (Expand, Pop out, Move inline, Mark done, Close) (`card-menu`) | Menu |
| element | Visual content (`visual-body`) | ViewCard |
| element | Sideways scroll with edge fade (`hscroll`) | gap |
| element | Collapsed rail with N new badge (`rail`) | IconButton + Badge |

## Inline card in the transcript (`inline-card`)

Show a visual inside the conversation without pushing the rest of the chat off screen.

| Kind | Name | Notes |
|---|---|---|
| state | capped | default |
| state | short |  |
| state | expanded |  |
| skipped state | empty | an inline card always has a visual |
| skipped state | loading | unchanged: the card renders with the message |
| skipped state | error | unchanged: ViewCard's render-failure notice |
| element | Title (`inline-title`) | ViewCard header |
| element | Version stepper (`inline-stepper`) | IconButton |
| element | ... menu (Expand, Pop out, Move to pane, Mark done, Close) (`inline-menu`) | Menu |
| element | Height cap fade (`inline-fade`) | gap |
| element | Show more (`show-more`) | LinkButton |

## Standalone Views pane (`views-pane`)

The same visual deck outside the chat, without the plan tab.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| skipped state | empty | unchanged: today's EmptyState |
| skipped state | loading | unchanged |
| skipped state | error | unchanged: today's InlineError |
| element | Tab row (same deck) (`vp-tabs`) | Tabs (underline) |
| element | Slim row (`vp-slim-row`) | IconButton |

## Gaps

- Chat visual panel / Tab close x on hover (`tab-close`)
- Chat visual panel / New or updated dot on a tab (`tab-dot`)
- Chat visual panel / Dimmed done tab (`tab-done`)
- Chat visual panel / Sideways scroll with edge fade (`hscroll`)
- Inline card in the transcript / Height cap fade (`inline-fade`)
