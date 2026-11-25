# Screens (mock v1)

## Chat tab (`chat`)

v1's chat view inside Quirky's workspace shell, fed by Orca's engine, with the Orca-only features you kept (rewind, compact, background tasks, find).

| Kind          | Name                                                              | Notes                                                                                                           |
| ------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| state         | default                                                           | default                                                                                                         |
| state         | working                                                           |                                                                                                                 |
| state         | reattached                                                        |                                                                                                                 |
| state         | rewind                                                            |                                                                                                                 |
| state         | background-tasks                                                  |                                                                                                                 |
| state         | find                                                              |                                                                                                                 |
| skipped state | empty                                                             | a new chat opens with the composer focused and nothing else, unchanged from v1's agent-chat mock                |
| skipped state | error                                                             | v1's error row (exited/spawn/protocol, Restart, Open in terminal) comes over unchanged; see the agent-chat mock |
| element       | Chat header: status, tokens, cache timer, rename, fork (`header`) | ChatHeader (port of v1)                                                                                         |
| element       | Your message (`user-msg`)                                         | Turn (port of v1)                                                                                               |
| element       | Rewind to here (on your message) (`rewind-btn`)                   | Button + Tooltip                                                                                                |
| element       | Rewind confirmation (`rewind-confirm`)                            | Dialog                                                                                                          |
| element       | Mode marker row (`mode-marker`)                                   | gap                                                                                                             |
| element       | Folded activity (`activity`)                                      | Activity (port of v1)                                                                                           |
| element       | Agent reply (Streamdown) (`prose`)                                | Prose (port of v1)                                                                                              |
| element       | Turn Changes card (`changes-card`)                                | Card                                                                                                            |
| element       | Test results card (`tests-card`)                                  | Card                                                                                                            |
| element       | Plan chip (`plan-chip`)                                           | PlanChip (port of v1)                                                                                           |
| element       | Visual chip (`visual-chip`)                                       | VisualChip (port of v1)                                                                                         |
| element       | Subagent dock (`dock`)                                            | AgentDock (port of v1)                                                                                          |
| element       | Background tasks panel (`bg-tasks`)                               | gap                                                                                                             |
| element       | Queued messages (`queue`)                                         | QueuedList (port of v1)                                                                                         |
| element       | Composer (CodeMirror, pills, settings chip) (`composer`)          | Composer (port of v1)                                                                                           |
| element       | Interrupted-turn row after a restart (`interrupted-row`)          | gap                                                                                                             |
| element       | Find in chat (`find-bar`)                                         | Input                                                                                                           |

## Tab menu: chat and terminal (`tab-menu`)

Move one conversation between the chat view and the agent's raw terminal, in both directions.

| Kind          | Name                                       | Notes                                                      |
| ------------- | ------------------------------------------ | ---------------------------------------------------------- |
| state         | chat-tab                                   | default                                                    |
| state         | terminal-tab                               |                                                            |
| skipped state | empty                                      | a menu always has items                                    |
| skipped state | error                                      | a failed continue opens the target tab with v1's error row |
| element       | Continue in terminal (`continue-terminal`) | ContextMenu                                                |
| element       | Continue as chat (`continue-chat`)         | ContextMenu                                                |

## New chat (`new-chat`)

Start a chat with any supported agent: v1's four plus the ACP agents. Agents without chat support aren't listed.

| Kind          | Name                                     | Notes                                                                               |
| ------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| state         | default                                  | default                                                                             |
| state         | agent-missing                            |                                                                                     |
| skipped state | empty                                    | Claude is always listed; when nothing is installed every row shows its install hint |
| element       | Agent list with readiness (`agent-list`) | Command                                                                             |
| element       | ACP agent row (`agent-row-acp`)          | Command                                                                             |
| element       | Not-installed hint (`install-hint`)      | gap                                                                                 |
| element       | Start chat (`start-btn`)                 | Button                                                                              |

## Composer over a terminal agent (`terminal-dock`)

The same v1 composer docked under a terminal agent, replacing the terminal-dock composer.

| Kind          | Name                              | Notes                                                       |
| ------------- | --------------------------------- | ----------------------------------------------------------- |
| state         | default                           | default                                                     |
| skipped state | empty                             | the dock only shows on agent terminals                      |
| skipped state | error                             | sends go to the PTY; failures are the terminal's own output |
| element       | Agent terminal (`terminal`)       | TerminalPane                                                |
| element       | Docked composer (`dock-composer`) | Composer (port of v1)                                       |

## Phone chat (`phone`)

Today's mobile chat screens fed by the same engine, with simple renderings of v1's new items, plus what an older phone app shows.

| Kind          | Name                                                 | Notes                                |
| ------------- | ---------------------------------------------------- | ------------------------------------ |
| state         | default                                              | default                              |
| state         | older-app                                            |                                      |
| skipped state | error                                                | unchanged mobile chat error handling |
| element       | Plan row on the phone (`m-plan`)                     | gap                                  |
| element       | Changes row on the phone (`m-changes`)               | gap                                  |
| element       | Visual row on the phone (`m-visual`)                 | gap                                  |
| element       | Unknown-item fallback on an older app (`m-fallback`) | gap                                  |
| element       | Phone composer (`m-composer`)                        | mobile session composer              |

## Gaps

- Chat tab / Mode marker row (`mode-marker`)
- Chat tab / Background tasks panel (`bg-tasks`)
- Chat tab / Interrupted-turn row after a restart (`interrupted-row`)
- New chat / Not-installed hint (`install-hint`)
- Phone chat / Plan row on the phone (`m-plan`)
- Phone chat / Changes row on the phone (`m-changes`)
- Phone chat / Visual row on the phone (`m-visual`)
- Phone chat / Unknown-item fallback on an older app (`m-fallback`)
