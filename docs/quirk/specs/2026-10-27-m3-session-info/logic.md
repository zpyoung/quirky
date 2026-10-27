# Session Info panel

## Status & amendments
Status: Approved autonomously under LOOP.md; tech spec required (public launch contract and daemon/UI boundaries).

**Amendments:** 2026-10-27 — Initial specification. The roadmap's per-launch statusline rule takes precedence over Orca's global settings mutation; consent applies to subsequent launches.

**Amendments:** 2026-10-27 — Accepted spec-review F1/F2/A1: publish main/floating focus authority; include user CLI --settings files/JSON in launch and resume precedence/consent; add the missing public resume-command projection in session-info.

**Amendments:** 2026-10-27 — Integration anchoring: SC-7 needs a new exact-pane focus command; SC-32 needs a public operation that places the already-resumed session into terminal layout without spawning a second process. These fill missing API prerequisites without changing the visible flows.

## Conceptual model
Session Info inspects the agent in the focused terminal pane. The daemon joins session identity and live agent status with optional, session-correlated Claude telemetry. The UI and scripts consume the same projection. A shell pane, non-terminal view, missing pane or missing agent yields an explicit empty state rather than the last inspected agent.

A provider-neutral identity and live activity are always available for an agent. Usage, context and files are optional capabilities. Hook/MCP inspection is on demand. A provider session is the agent CLI's conversation ID, distinct from Quirky's session ID. Changing the provider session invalidates the old conversation's telemetry.

## Data flow
Terminal focus/layout and session/status events identify the current agent. Claude receives a per-launch statusline command via --settings; its stdin JSON is sent through the authenticated loopback hook transport into the session-info plugin. Turn completion triggers bounded transcript usage scanning. Snapshot changes are published as plugin events. Open accordion sections and custom-statusline consent persist in the plugin store; telemetry does not persist.

## Key decisions & rationale
Use a built-in plugin and the existing right-column panel, not feature-specific kernel code or a UI-only scanner. Kernel growth is limited to composing JSON-valued launch arguments shared by the existing hook installer and this feature. Existing public APIs own terminal focus, sessions, status, opening paths and UI routing.

The three approaches considered were plugin-owned projection (chosen), a core aggregate (violates plugin ownership), and UI-only scanning (violates scriptability/shared state). A per-launch wrapper preserves the user's statusline command after consent; no user settings are rewritten. A running Claude cannot adopt a new startup overlay, so enable/disable clearly says it takes effect on the next launch.

## Decisions locked
- Layout/density: existing Session Info panel toggle, no shortcut; compact rows, scrollable; native accessible accordion buttons; multiple sections open.
- Interaction/persistence: only Live activity open initially; daemon-backed section state survives restarts and is readable/scriptable.
- Loading/empty/errors: no focused agent gives “No agent session” and focus guidance; unsupported fields are absent, not zero; waiting and stale are visible; Retry reloads inspection/usage.
- Identity: provider model display name, then live status model, then transcript model; show provider ID and Quirky ID without conflating them.
- Telemetry consent: preserve all custom statusLine fields, stdin and successful stdout; no custom command executes without consent to chaining; edits revoke command-specific consent; next-launch effect is explicit.
- Correlation: accept Claude-only local telemetry for the active provider ID, discard late scans/ticks, reset on replacement; cap snapshots at 256 sessions.
- Plan windows: display only windows from that same accepted live session payload; no unrelated account fallback.
- CLI/API: schema-declared session-info group, JSON conventions and existing error codes/auth; every view action is a routed command or public API method.
- Platform: macOS local behavior; remote/WSL telemetry remains hidden until remote execution exists. Native Finder/OS clipboard effects are handed to the nightly run.
- No human questions; recommended defaults adopted under LOOP.md. See the numbered decision log for their evidence.

## Behavior & scenarios
Each scenario is an acceptance criterion and gets a CLI/daemon API test. UI-visible scenarios additionally get unattended web exercise; native-only effects are pending nightly scenarios.

| ID | Given / data before | When / walkthrough | Then / data after |
| --- | --- | --- | --- |
| SC-1 | Plain shell pane or non-terminal view focused | Open Session Info through UI/API | Panel title and “No agent session” guidance, no stale agent data |
| SC-2 | Claude A and Codex B in different panes/workspaces | Focus A, then B through terminal API/UI | Panel follows exact active pane; B has Identity, Live activity, MCP capability, no Claude metrics |
| SC-3 | Fresh preferences | Read state, open Identity and Context, restart daemon | Only Live activity initially; saved open set survives restart; multiple sections coexist |
| SC-4 | Agent with ID/model/worktree/title/timestamps/transcript | Expand Identity | Labels show known values only; model fallback order respected; unknown model omitted |
| SC-5 | Session with provider ID | Copy ID via routed UI command | Clipboard contains provider ID; “Copied” appears for 1.5 s then resets; native clipboard delivery checked nightly |
| SC-6 | Focused agent | Open Vault | Session history view opens with the provider ID prefilled and matching session listed; no full-text indexing |
| SC-7 | Known session pane in another tab/group | Focus pane via command | Correct tab/group/pane active; terminal-focused view opens; output bottom/focus request observable in UI state |
| SC-8 | Local readable transcript | Open transcript | App shows read-only transcript content; missing/unreadable file gives actionable error rather than blank success |
| SC-9 | Local transcript path | Reveal transcript | Existing public openExternal reveal API receives validated path; Finder effect pending native test |
| SC-10 | Working, blocked, waiting, done status and active tool/children | Read Live activity through get/UI | Correct display label, tool name/input preview and subagent count; input remains bounded |
| SC-11 | Ctrl+C interrupted agent whose coarse state is done | Read Live activity | Interrupted outcome is not mislabeled as successful Done (recorded Orca defect) |
| SC-12 | Claude with no completed turn/statusline | Open Usage and Context | Waiting for first completed turn / statusline; no invented counts; Files touched absent |
| SC-13 | Claude transcript with two session-matching assistant turns, another session and sidechain data | Deliver lead Stop hook | Usage fills without a statusline: sums input/output/cache read/cache write, total and turn count; only active-session lead turns count (prevents recorded endless waiting defect) |
| SC-14 | Prior good usage | Stop scan encounters missing/unreadable/oversized transcript | Retain good numbers with Stale, timestamp and bounded error; next Stop or Retry can recover; no polling timer |
| SC-15 | Claude context_window 81%, remaining 19%, size 200000 plus file totals +12/-4 | Post accepted statusline | Header 81% context used, red fill, As of; Context Used/Remaining/Window; Files touched +12/−4 |
| SC-16 | Context at 59%, 60%, 79%, 80% | Read projections/render | Thresholds muted below 60, strong 60–79, destructive at 80+; percentages rounded/clamped; zero is not missing |
| SC-17 | Partial later telemetry contains model but no context/files | Post update | Prior valid context/files retained; absent fields never erase earlier observations |
| SC-18 | Statusline from old provider ID A, active provider changes to B | Post late A tick or let old A scan finish | No A numbers visible on B; B waiting until its own data arrives |
| SC-19 | Codex/Claude-shaped other provider | Post Claude statusline payload | Rich Claude fields never attach to unsupported provider |
| SC-20 | Payload with nulls, controls, invalid/negative/nonfinite values | Post telemetry | Invalid fields rejected/omitted; valid siblings survive; no fabricated zeroes; session_id ≤512, paths ≤32768, errors ≤500 |
| SC-21 | Same accepted Claude payload has five_hour/seven_day limits | Inspect Context | Correct percentages and reset times for this session only; missing/reset window is absent; no cross-session/account reuse |
| SC-22 | No custom statusline | Launch Claude | One effective --settings JSON argument includes version-gated agent hooks plus telemetry statusLine; ~/.claude unchanged byte-for-byte |
| SC-23 | Custom user statusLine command with extra formatting keys | Inspect, then launch before consent | Card says Custom statusline detected, preserves command; launch does not replace/run a chained command without consent |
| SC-24 | Same custom statusline, explicit Enable session telemetry | Enable then launch | State Chained/next launch; wrapper forwards identical stdin, successful stdout unchanged, original object keys preserved; global settings untouched |
| SC-25 | Consented command subsequently edited or telemetry disabled | Inspect then launch | Drift/custom-command consent required again, or disabled; user's command remains intact; no old command silently restored |
| SC-26 | Chained command fails, recurses or hangs | Invoke wrapper | Telemetry path is bounded/nonblocking; no failed command output leaks; descendant watchdog prevents hung chain; no recursive chain |
| SC-27 | Multiple valid payloads within 15 s of elapsed duration | Run managed wrapper | At most one post per session per 15 s; context-only payloads accepted; CLAUDE_JOB_DIR suppresses telemetry; stdout reserved for user display |
| SC-28 | Hooks & MCP closed then opened | Inspect lazily, Retry | Hook status and detail, statusline consent/status, deduplicated configured MCP names/transport/enabled/disabled/invalid appear; one failed inspection preserves other results with an error |
| SC-29 | Workspace and user MCP config overlap | Inspect MCP | First scope wins by server name; project/locally configured servers reported, disabled and invalid entries not falsely healthy; empty list says No configured servers found |
| SC-30 | Telemetry for >256 sessions; session exits/removes | Read snapshots | Bounded cache; oldest evicted; removal/exit clears data and stale scans cannot resurrect it |
| SC-31 | Window closes/unsubscribes while updates arrive | Deliver telemetry/status | No delivery exception blocks status; UI mount/dispose releases subscriptions; pull/push race never regresses newer state |
| SC-32 | Historical resumable agent | Open history, Resume/Fork or Copy resume command | Existing session resume API used; new session opens; copy command uses public session-info/resumeCommand; failures visible |
| SC-33 | Different user global/project settings and earlier launch hooks | Launch/resume Claude with telemetry | Effective settings retain other hook contributions and custom statusLine fields; repeated launch/resume never edits user config |
| SC-34 | Main and floating terminal agents visible together | Focus floating, then main, then Session Info | Daemon focus-context API identifies the last focused terminal workspace; opening the panel does not switch the inspected agent |
| SC-35 | Custom statusLine supplied by user --settings JSON/file (including --settings=value) | Inspect, launch and resume before/after consent | Custom CLI statusline respected and consented; one effective --settings contains user values plus managed hooks/telemetry; malformed file fails visibly without altering it |

## Scope & non-goals
All local flows in the feature doc and session-history UI delegated by m1-providers D35 are included. Global statusline install/restore is intentionally replaced by the roadmap's per-launch overlay. No global ~/.claude writes. Account switching/meters independent of session payloads, vault scanning/indexing/full-text search, remote execution transport, WSL and Windows launchers, native chat, and a new activity-bar shell are excluded. Existing native APIs are reused, not replaced.

## Industry insights
- Claude statusline input is best-effort JSON with missing/null fields, debounced/cancelled invocations and a stable session_id; preserve stdout and collect only the fields needed: https://code.claude.com/docs/en/statusline.
- --settings is a per-session overlay, not permission to rewrite global settings; managed policy may prevent execution: https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/cli-reference.
- Accessible accordion headings/buttons expose aria-expanded/aria-controls and normal keyboard operation: https://www.w3.org/WAI/ARIA/apg/patterns/accordion/.
- Distinguish event/observation time and correlate entity identity: https://opentelemetry.io/docs/specs/otel/logs/data-model/.
- Plugin replaceability needs declared stable contributions: https://backstage.io/docs/frontend-system/architecture/extension-overrides.

## Deferred ideas
None beyond the explicitly named adjacent features/platform transports above. [tech-spec] Resolve JSON-valued launch-argument composition once in the public launch pipeline; do not rely on duplicate --settings flags.

## Glossary
- Quirky session: the daemon/PTY record addressed by session APIs.
- Provider session: the agent CLI conversation ID used for telemetry and resume.
- Snapshot: bounded transient, correlated session metadata projection.
- Chained: a per-launch wrapper collects telemetry and preserves a consented user statusline command.
- Stale: last successful usage retained after a failed refresh; not current telemetry.
