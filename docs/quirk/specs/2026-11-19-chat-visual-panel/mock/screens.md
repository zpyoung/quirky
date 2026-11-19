# Screens (mock v2)

## Chat with the visual panel (`chat`)

Native chat with the docked panel beside the transcript, showing several visuals side by side when it's wide enough.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | empty |  |
| state | building |  |
| state | broken |  |
| state | pointing |  |
| element | Transcript (`transcript`) | ChatView / Turn |
| element | Visual chip on a message (`msg-chip`) | gap |
| element | Visualize action on a message (`visualize-btn`) | gap |
| element | Composer (`composer`) | Composer |
| element | Reference chip from clicking a visual (`ref-chip`) | gap |
| element | Visual level dial (`visual-dial`) | gap |
| element | Resizable divider (`divider`) | gap |
| element | Panel header (`panel-header`) | quirky.view Pane |
| element | Collapse panel (`panel-collapse`) | gap |
| element | Plan, pinned first (`plan-card`) | PlanPanel |
| element | Visual card (`visual-card`) | quirky.view Pane |
| element | Version stepper (`version-stepper`) | gap |
| element | What changed in this version (`change-highlight`) | gap |
| element | Expand (`expand-btn`) | gap |
| element | Pop out (`popout-btn`) | gap |
| element | Diagram (`diagram`) | MermaidBlock |
| element | Bar chart (`chart`) | quirky.view bar-chart |
| element | Table (`table`) | quirky.view table |
| element | Empty panel (`empty-panel`) | gap |
| element | Visual building up (`building-card`) | gap |
| element | Didn't render badge (`broken-badge`) | ViewError |
| element | Refused update row in transcript (`refused-row`) | Activity |

## Narrow window (`narrow`)

When the panel is too narrow for side by side, one visual is big and the rest sit in a filmstrip; collapsed, it becomes a rail with a badge.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | collapsed |  |
| skipped state | empty | same empty panel as the Chat screen |
| element | Filmstrip of visuals (`filmstrip`) | gap |
| element | Focused visual (`focus-visual`) | quirky.view Pane |
| element | Collapsed rail with badge (`rail`) | gap |

## Expanded visual (`expanded`)

One visual fills the chat window; the composer stays so you can keep pointing and asking.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| skipped state | error | a broken version shows the same badge as on the Chat screen |
| element | Expanded visual (`expanded-visual`) | gap |
| element | Back to chat (`back-btn`) | gap |
| element | Pop out (`popout-btn`) | gap |
| element | Composer under the visual (`mini-composer`) | Composer |

## Prototype and live preview (`prototype`)

A clickable prototype the agent wrote, running sandboxed with no network, next to a live preview of the worktree's dev server.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| skipped state | loading | prototypes appear whole; a live preview shows the browser pane's own loading state |
| element | Sandboxed, no network tag (`sandbox-tag`) | gap |
| element | Interactive prototype (`prototype-frame`) | gap |
| element | Live preview of the dev server (`live-preview`) | quirky.browser pane |

## More kinds (`kinds`)

A tour of the visual kinds beyond diagrams, data and images, as they'd look in the panel.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Timeline (`timeline`) | gap |
| element | Board (`board`) | gap |
| element | Decision matrix (`matrix`) | gap |
| element | Annotated code (`annotated-code`) | quirky.view code |
| element | File map (`file-map`) | gap |
| element | Math plot (`plot`) | gap |
| element | Sketch (`sketch`) | gap |
| element | Worktree screenshot (`screenshot`) | ImageChip |

## Gaps

- Chat with the visual panel / Visual chip on a message (`msg-chip`)
- Chat with the visual panel / Visualize action on a message (`visualize-btn`)
- Chat with the visual panel / Reference chip from clicking a visual (`ref-chip`)
- Chat with the visual panel / Visual level dial (`visual-dial`)
- Chat with the visual panel / Resizable divider (`divider`)
- Chat with the visual panel / Collapse panel (`panel-collapse`)
- Chat with the visual panel / Version stepper (`version-stepper`)
- Chat with the visual panel / What changed in this version (`change-highlight`)
- Chat with the visual panel / Expand (`expand-btn`)
- Chat with the visual panel / Pop out (`popout-btn`)
- Chat with the visual panel / Empty panel (`empty-panel`)
- Chat with the visual panel / Visual building up (`building-card`)
- Narrow window / Filmstrip of visuals (`filmstrip`)
- Narrow window / Collapsed rail with badge (`rail`)
- Expanded visual / Expanded visual (`expanded-visual`)
- Expanded visual / Back to chat (`back-btn`)
- Expanded visual / Pop out (`popout-btn`)
- Prototype and live preview / Sandboxed, no network tag (`sandbox-tag`)
- Prototype and live preview / Interactive prototype (`prototype-frame`)
- More kinds / Timeline (`timeline`)
- More kinds / Board (`board`)
- More kinds / Decision matrix (`matrix`)
- More kinds / File map (`file-map`)
- More kinds / Math plot (`plot`)
- More kinds / Sketch (`sketch`)
