# Notifications (`quirky.notifications`)

The plugin owns notification decisions, unread markers, sounds, and the status badge. Producers send events; delivery uses the existing `PluginContext.notify` policy. Ask escalation does not introduce a second notification path.

## Public methods and CLI

| Method | Request | Behavior |
|---|---|---|
| `quirky.notifications/status` | `{}` | Returns badge/label, unread worktrees and sessions, surfaced pending Ask heads, and sound availability. Queued and resolved asks are excluded. |
| `quirky.notifications/send` | `{body, title?, session?, worktree?}` | Sends a program notification through normal markers and delivery gates. `body` is required; name at most one exact session or worktree. Display text is bounded to 256 characters. |
| `quirky.notifications/test` | `{}` | Sends the test notification, bypassing focus and cooldown gates. |
| `quirky.notifications/preview` | `{sound?, path?, volume?}` | Plays a sound without a banner or unread marker. Volume is 0–100. |

CLI commands are `quirky notifications status`, `send --body ... [--title ...] [--session ...|--worktree ...]`, `test`, and `preview [--sound ...|--path ...] [--volume N]`.

## Settings

The Notifications settings view uses shared graphite form controls and semantic tokens in dark and light. Dependent controls remain disabled when notification delivery is off; the menu-bar control stays independent. Sound selection, custom-path validation and range save-on-commit behavior keep the same canonical setting IDs and policy. Rendering preferences does not create notifications or unread markers.


| Setting | Default | Effect |
|---|---:|---|
| `setting:quirky.notifications/enabled` | `true` | Enables/disables notification delivery. |
| `setting:quirky.notifications/agentTaskComplete` | `true` | Agent completion notifications. |
| `setting:quirky.notifications/terminalBell` | `false` | Terminal bell notifications. |
| `setting:quirky.notifications/terminalNotifications` | `true` | OSC terminal notifications. |
| `setting:quirky.notifications/suppressWhenFocused` | `true` | Suppresses delivery when the triggering worktree is open in a focused window. |
| `setting:quirky.notifications/sound` | `system` | Chosen alert sound; enum includes bundled sounds and `custom`. |
| `setting:quirky.notifications/customSoundPath` | `""` | Absolute custom sound path. |
| `setting:quirky.notifications/volume` | `100` | Sound volume, 0–100. |
| `setting:quirky.notifications/showMenuBarIcon` | `true` | Menu-bar shortcut/activity indicator. |

The per-worktree cooldown is five seconds by default and can be overridden for a runtime with a positive integer `QUIRKY_NOTIFICATION_COOLDOWN_MS`. Ask has no separate source switch: after escalation it uses `enabled`, focus suppression, the shared cooldown, and the existing delivery/sound policy; the agent-task and terminal-program switches do not control Ask.

## Delayed Ask attention

A newly created or surfaced Ask never sends an immediate banner. Only the still-pending, non-queued FIFO head is eligible. An unattended head must remain uninterrupted for **three minutes** before the service re-reads the public `quirky.ask/list` result and rechecks the focused session. Focus of that exact session cancels the timer; leaving it starts a fresh interval. Resolution and head replacement cancel the old timer; a promoted head starts its own interval. Startup and UI reconnect/state/report changes reconcile heads from the public pending list. Shutdown clears escalation, lookup, and bell timers.

On expiry, the service uses the same policy path as other notifications. It calls the public `quirky.session/setUnread` and `quirky.worktree/set` methods when those targets are not viewed, then emits the existing public `quirky.notifications/attention` event with `source: "ask"`. The event and markers do not arise at registration. `status.pendingAsks` and the badge count surfaced heads only, never queued/resolved asks.

No new settings or private cross-plugin store writes are used for Ask attention. Native notification permission/click/dismiss behavior remains a shell capability; this plugin does not emulate it.

## Watcher transition attention

Heimdall approval requests and terminal transitions enter the same notification policy as other sources. Disabling notification delivery suppresses both the native request and its toast, but not the worktree attention marker. Repeated observations of one pending approval do not produce another notification. A terminal notification carries the watcher's final state and reason and opens that exact watcher's Fleet detail.
