# Screens (mock v1)

## Workspace (`workspace`)

The main window: worktree sidebar with agent status, terminal tabs, status bar and the needs-you toast.

| Kind          | Name                                                  | Notes                                                                |
| ------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| state         | dark                                                  | default                                                              |
| state         | light                                                 |                                                                      |
| skipped state | empty                                                 | a recolor adds no new states; each screen is shown in dark and light |
| element       | Worktree row, working (blue, pulsing) (`row-working`) | src/renderer/src/components/sidebar + AgentStateDot                  |
| element       | Worktree row, needs you (amber) (`row-needs`)         | src/renderer/src/components/sidebar + AgentStateDot                  |
| element       | Worktree row, failing (red) (`row-failing`)           | src/renderer/src/components/sidebar + AgentStateDot                  |
| element       | Worktree row, done (green) (`row-done`)               | src/renderer/src/components/sidebar + AgentStateDot                  |
| element       | Worktree row, idle (`row-idle`)                       | src/renderer/src/components/sidebar                                  |
| element       | Primary button (teal) (`primary-btn`)                 | src/renderer/src/components/ui/button.tsx                            |
| element       | Tab bar, active tab underline (`tab-bar`)             | src/renderer/src/components/tab-bar                                  |
| element       | Terminal with Quirky Graphite palette (`terminal`)    | src/renderer/src/components/terminal-pane                            |
| element       | Needs-you toast (`toast`)                             | src/renderer/src/components/ui/sonner.tsx                            |

## Editor & diff (`editor`)

Monaco with the graphite syntax theme and a diff with v1 add/delete colors.

| Kind    | Name                                       | Notes                                               |
| ------- | ------------------------------------------ | --------------------------------------------------- |
| state   | dark                                       | default                                             |
| state   | light                                      |                                                     |
| element | Syntax colors (`editor-syntax`)            | src/renderer/src/components/editor/MonacoEditor.tsx |
| element | Selection (teal tint) (`editor-selection`) | src/renderer/src/components/editor/MonacoEditor.tsx |
| element | Diff added line (`diff-add`)               | src/renderer/src/components/editor                  |
| element | Diff deleted line (`diff-del`)             | src/renderer/src/components/editor                  |

## Chat (`chat`)

Native chat: user bubble, assistant text, inline and block code, link, composer.

| Kind    | Name                             | Notes                                     |
| ------- | -------------------------------- | ----------------------------------------- |
| state   | dark                             | default                                   |
| state   | light                            |                                           |
| element | User message (`chat-user`)       | src/renderer/src/components/native-chat   |
| element | Inline code (`chat-inline-code`) | src/renderer/src/components/native-chat   |
| element | Code block (`chat-code`)         | src/renderer/src/components/native-chat   |
| element | Link (teal) (`chat-link`)        | src/renderer/src/components/native-chat   |
| element | Composer (`composer`)            | src/renderer/src/components/native-chat   |
| element | Send button (`send-btn`)         | src/renderer/src/components/ui/button.tsx |

## Settings: Appearance (`settings`)

Theme mode, terminal theme defaults, palette preview, switch and focus ring.

| Kind    | Name                                     | Notes                                                               |
| ------- | ---------------------------------------- | ------------------------------------------------------------------- |
| state   | dark                                     | default                                                             |
| state   | light                                    |                                                                     |
| element | System / Dark / Light (`theme-toggle`)   | src/renderer/src/components/settings/AppearanceInterfaceSection.tsx |
| element | Terminal theme picker (`terminal-theme`) | src/renderer/src/components/settings/TerminalThemePicker.tsx        |
| element | ANSI palette (`ansi-swatches`)           | src/renderer/src/components/settings/TerminalThemePicker.tsx        |
| element | Switch (teal on) (`switch`)              | src/renderer/src/components/ui/switch.tsx                           |
| element | Focus ring (`focus-input`)               | src/renderer/src/components/ui/input.tsx                            |

## Trust dialog (`trust`)

Plugin consent dialog on the frozen security surface, now graphite.

| Kind    | Name                                     | Notes                                               |
| ------- | ---------------------------------------- | --------------------------------------------------- |
| state   | dark                                     | default                                             |
| state   | light                                    |                                                     |
| element | Security dialog surface (`trust-dialog`) | src/renderer/src/components/ui/security-surface.tsx |
| element | Allow (primary) (`trust-allow`)          | src/renderer/src/components/ui/button.tsx           |
| element | Don't allow (`trust-cancel`)             | src/renderer/src/components/ui/button.tsx           |

## Mobile worktrees (`mobile`)

Quirky Mobile worktree list, terminal and primary action in graphite.

| Kind          | Name                          | Notes                            |
| ------------- | ----------------------------- | -------------------------------- |
| state         | dark                          | default                          |
| skipped state | light                         | mobile stays dark only (decided) |
| element       | Worktree row (`mobile-row`)   | mobile/src/worktree              |
| element       | Terminal (`mobile-terminal`)  | mobile/src/terminal              |
| element       | Primary button (`mobile-btn`) | mobile/src/components            |

## Gaps

None.
