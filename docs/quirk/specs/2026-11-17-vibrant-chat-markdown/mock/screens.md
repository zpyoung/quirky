# Screens (mock v1)

## Chat transcript (`transcript`)

An agent reply that uses every supported block, finished, mid-stream, scrolled up, with render errors, and in light theme.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | streaming |  |
| state | scrolled-up |  |
| state | render-error |  |
| state | light |  |
| skipped state | empty | an empty chat has no prose; the empty transcript is unchanged by this work |
| skipped state | loading | loading before the first token is the existing turn spinner; streaming covers the rest |
| element | User bubble (unchanged) (`user-bubble`) | Turn (renderUserMarkdown) |
| element | Heading 1 (`h1`) | Streamdown components map |
| element | Heading 2 (`h2`) | Streamdown components map |
| element | Heading 3 (`h3`) | Streamdown components map |
| element | Paragraph with chips (`para-chips`) | Streamdown components map |
| element | File path chip (`path-chip`) | gap |
| element | Inline code (`inline-code`) | Streamdown components map |
| element | Link (`link`) | Prose openLink + context.confirm |
| element | Warning alert (`alert-warning`) | gap |
| element | Tip alert with kbd (`alert-tip`) | gap |
| element | Task list (`task-list`) | Streamdown components map |
| element | Code block with line numbers (`code-block`) | @streamdown/code (Shiki) |
| element | Code header filename (`code-header`) | @streamdown/code (Shiki) |
| element | Copy button (`copy-btn`) | @streamdown/code (Shiki) |
| element | Diff fence (`diff-block`) | gap |
| element | Collapsed long block (`long-code`) | gap |
| element | Show all bar (`show-all`) | gap |
| element | Zebra table (`table`) | Streamdown components map |
| element | Mermaid diagram (`mermaid`) | @streamdown/mermaid |
| element | Diagram source toggle (`mermaid-source`) | gap |
| element | Inline math (`math-inline`) | @streamdown/math (KaTeX) |
| element | Block math (`math-block`) | @streamdown/math (KaTeX) |
| element | Collapsible section (`details`) | gap |
| element | CSV fence as table (`csv-fence`) | gap |
| element | JSON tree (`json-fence`) | gap |
| element | Chart fence (`chart-fence`) | quirky.view render/charts.tsx |
| element | Worktree image (`local-image`) | Streamdown components map |
| element | Remote image as link chip (`remote-image`) | gap |
| element | Footnotes (`footnotes`) | Streamdown components map |
| element | Repaired partial bold (`repaired-bold`) | Streamdown (remend) |
| element | Open fence while streaming (`open-fence`) | Streamdown (remend) |
| element | Streaming caret (`caret`) | Prose caret |
| element | Jump to latest (`jump-pill`) | gap |
| element | Diagram render error (`mermaid-error`) | gap |
| element | Math render error (`math-error`) | gap |
| element | Open link prompt (`link-confirm`) | context.confirm |

## Agent-drawn view (`view-card`)

A quirky.view markdown node rendered by the same renderer with chat's strict rules.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| skipped state | empty | an empty markdown node renders nothing, as today |
| skipped state | loading | view nodes arrive whole, not streamed |
| skipped state | error | block errors look the same as in the transcript's render-error state |
| element | View card (`view-card`) | ViewCard |
| element | Important alert (`view-alert`) | gap |
| element | Escaped raw HTML (`view-html-escaped`) | Streamdown (skipHtml / allowedTags) |

## Editor preview (`editor-preview`)

The editor's markdown preview for a file you opened, same look, with cleaned raw HTML allowed.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| skipped state | empty | an empty file previews as an empty pane, as today |
| skipped state | loading | the preview renders synchronously from the open buffer |
| skipped state | error | block errors look the same as in the transcript's render-error state |
| element | Source pane (`editor-source`) | MarkdownSurface |
| element | Preview pane (`editor-output`) | preview.tsx |
| element | Raw HTML from file (`editor-raw-html`) | Streamdown raw + DOMPurify |

## Gaps

- Chat transcript / File path chip (`path-chip`)
- Chat transcript / Warning alert (`alert-warning`)
- Chat transcript / Tip alert with kbd (`alert-tip`)
- Chat transcript / Diff fence (`diff-block`)
- Chat transcript / Collapsed long block (`long-code`)
- Chat transcript / Show all bar (`show-all`)
- Chat transcript / Diagram source toggle (`mermaid-source`)
- Chat transcript / Collapsible section (`details`)
- Chat transcript / CSV fence as table (`csv-fence`)
- Chat transcript / JSON tree (`json-fence`)
- Chat transcript / Remote image as link chip (`remote-image`)
- Chat transcript / Jump to latest (`jump-pill`)
- Chat transcript / Diagram render error (`mermaid-error`)
- Chat transcript / Math render error (`math-error`)
- Agent-drawn view / Important alert (`view-alert`)
