# m1-agent-status tech spec

**Status:** Draft for build. **Logic spec:** [logic.md](logic.md). **Decisions:** [m1-agent-status.md](../../../loop/decisions/m1-agent-status.md).

All paths are relative to the repo root unless they start with `/`. Orca's source, the reference
implementation for every per-agent value, is at `/Users/zpyoung/PycharmProjects/orca` (written
`ORCA/` below); port its values, never its structure. The tier gate fired on three criteria: the
work crosses the PTY host, kernel and plugin boundaries, touches far more than three files, and the
logic spec's Status records "Tech spec: requested".

## Architecture

Five layers change ([Data flow](logic.md#data-flow)):

1. **Protocol** (`packages/protocol/src`): `PtyFact` gains `prompt` and `program-status`;
   `PluginPty` gains `onInput`; the `hook.received` event gains the agent's process identity;
   `Session` gains `agentStatus`.
2. **PTY host** (`packages/pty-host/src`): the scanner reports OSC 7501 bodies; the session emits
   prompt marks instead of swallowing them and answers the OSC 7501 probe.
3. **Kernel** (`packages/daemon/src`): `pty-api.ts` fans out input; `server.ts` passes the agent
   process identity; `launch.ts` rewrites the `quirky-hook` shim.
4. **quirky.session / quirky.worktree / quirky.terminal**: `setStatus` takes and stores the summary;
   both dots draw it; `factEvent` ignores the new fact kinds.
5. **quirky.agent-status**: rebuilt as small modules under `src/`: model and display, normalizers,
   the apply pipeline, fallbacks, inference, presence, spool, installers, CLI.

No new runtime dependencies. TOML and YAML edits are line-based on Quirky-marked blocks, not full
parsers (see [Installer contract](#installer-contract)).

## Code references

### Protocol (`packages/protocol/src`)

| File | Change |
|---|---|
| `pty.ts:19-23` `PtyFact` | add `{ kind: 'prompt' }` and `{ kind: 'program-status'; body: string }`. `PTY_PROTOCOL_VERSION` stays 2 ([D34](../../../loop/decisions/m1-agent-status.md)). |
| `plugins.ts:81-123` `PluginPty` | add `onInput(listener: (sessionId: string, data: string) => void): () => void` beside `onFact` (l.121) |
| `rpc.ts:143` `hook.received` | add optional `agentPid: number`, `agentStart: string`, `event: string` |
| `kernel-schemas.ts` (the `hook.received` schema) | the three new optional properties |
| `model.ts:61-86` `Session` | add `agentStatus?: AgentStatusSummary \| null`; export `AgentStatusSummary` and `AgentDisplayState` |

### PTY host (`packages/pty-host/src`)

| File | Change |
|---|---|
| `scanner.ts:2-9` `ScanFact` | add `{ kind: 'program-status'; body: string }` |
| `scanner.ts:206` `reportOsc` | `code === '7501'` → emit `program-status` with `rest` (the text after `7501;`) |
| `session.ts:573-589` `applyFact` | `prompt` is emitted (still not `command-start`); `program-status` is emitted, and when `body.trim() === '?'` the host also writes the reply through `session.barrier.input` |
| `history/restore.ts:51-89` | unchanged: its own scanner and `seeding` keep replays from replying |

### Kernel (`packages/daemon/src`)

| File | Change |
|---|---|
| `plugins/pty-api.ts:29-56` `Fanout`, `:112-115` `write` | an `input` listener set; `write` calls `input` listeners after `pty.sendData` succeeds, with the data decoded as UTF-8 (lossy) |
| `plugins/pty-api.ts:85,190` `listen`/`revoke` | `onInput` registered and revoked like `onFact` |
| `server.ts:33-55` `handleHook` | read `pid` (digits only), `pstart` (≤64 printable chars) and `event` (`[A-Za-z0-9_.-]{1,64}`) query params into the event; malformed values are dropped, not rejected |
| `launch.ts:101-121` `QUIRKY_HOOK_SCRIPT` | rewritten per [Shim contract](#shim-contract) |

### Plugins

| File | Change |
|---|---|
| `plugins/quirky.terminal/src/terminal.ts:37-49` `factEvent` | return `null` for `prompt` and `program-status`; `main.ts:28-31` skips `null` |
| `plugins/quirky.session/src/sessions.ts:307-318` `setStatus` | accept `agentStatus` (object or null, omitted = unchanged); emit `changed` when status or summary differ; `finish` (`:322-333`) clears it |
| `plugins/quirky.session/src/records.ts:103-143` | migration 5 adds `agent_status TEXT`; `Row`, `toSession`, `insert`, `update` carry it as JSON |
| `plugins/quirky.session/quirky-plugin.json` | `setStatus.params.agentStatus` (untyped node, description only); `agentStatus` beside `resumedFrom` in the 9 Session schemas (lines 99, 202, 337, 450, 560, 678, 779, 922, 1013) |
| `plugins/quirky.session/src/window/{StatusDot.tsx,status.ts,SessionTabs.tsx}` | draw the glyph and label from `session.agentStatus` when present, else from `status` as today |
| `plugins/quirky.worktree/src/{StatusDot.tsx,status.ts,WorktreesSection.tsx,report.ts}` | same glyphs; urgency per [Worktree priority](#worktree-priority) |
| `packages/ui/src/styles.css:173-205` | glyph classes (spinner, question, dashed, ring) and a `prefers-reduced-motion` rule |
| `plugins/quirky.agent-status/**` | rebuilt, see [Plugin layout](#plugin-layout) |
| `plugins/quirky.agent-status/test/fakes/quirky.session/*` | `setStatus` accepts `agentStatus`; add `setProviderSession`, `get` returns stored provider session |

## Contracts & interfaces

### Plugin layout

`plugins/quirky.agent-status/` ([Conceptual model](logic.md#conceptual-model)):

| Module | Owns |
|---|---|
| `main.ts` | wiring only: store, subscriptions, provides, startup install, spool drain |
| `cli.ts` | `hooks status`, `hooks setup`, `hooks remove` printers |
| `src/model.ts` | `AgentRow`, `AgentState`, `Outcome`, display derivation, labels, field caps |
| `src/normalize/index.ts` + `src/normalize/<family>.ts` | `normalize(source, payload, cache) → Normalized \| null` per source |
| `src/apply.ts` | the pipeline in [Apply order](#apply-order) |
| `src/fold.ts` | the lead/children fold |
| `src/identity.ts` | lead and nested-agent rules |
| `src/capture.ts` | provider session extraction per source |
| `src/program-status.ts` | OSC 7501 body parser, per-session record set, root projection |
| `src/title.ts` | title classifier |
| `src/inference.ts` | interrupt and question-answered inference |
| `src/presence.ts` | PID probe |
| `src/spool.ts` | spool reader and drain |
| `src/store.ts` | migrations and row persistence |
| `src/install/registry.ts` | the per-agent installer table |
| `src/install/{claude-json,hooks-json,cursor,toml-block,yaml-block,kiro,files}.ts` | one module per config format |
| `src/install/sources/{opencode.js.ts,pi.ts.ts,amp.ts.ts,hermes.py.ts}` | generated plugin file text |
| `src/claude-settings.ts` | the per-launch Claude settings file and the version gate |

### Row and summary

`SCHEMA:` the stored row (JSON in the store, one per session)

```
AgentRow {
  sessionId: string; agent: string            // the hook source, e.g. 'claude', 'qwen-code'
  state: 'working'|'waiting'|'blocked'|'done'
  workingMode?: 'monitoring'
  outcome?: 'success'|'cancellation'|'failure'; interrupted?: boolean; sessionBoundary?: boolean
  prompt: string (≤200, one line); toolName?: string (≤60); toolInput?: string (≤160)
  lastAssistantMessage?: string (≤8000); question?: string (≤16000, JSON of the ask input)
  model?: string (≤120); detail: string        // readable, never a JSON object (SC-32)
  lead: { providerSession: string|null; agentPid: number|null; agentStart: string|null; ended: boolean }
  children: { id: string; kind: 'agent'|'shell'|'cron'; state: 'working'|'waiting'|'done' }[] (≤64)
  heldPermission?: { toolUseId: string|null; toolName: string; input: string; childId: string|null }
  stashedState?: AgentState                    // lead state saved while a child asks
  stateStartedAt: number; evidenceAt: number; turnStartedAt: number|null
  source: 'hook'|'replay'|'title'|'program-status'|'inference'
  restoredUnconfirmed?: boolean
  programStatus?: { state: string; kind?: string; progress?: number; msg?: string; app?: string } // facet
}
```

`SCHEMA:` the summary on the session (`Session.agentStatus`), also the `list` entry shape plus
`sessionId`, `agent`:

```
AgentStatusSummary {
  state: AgentState; display: AgentDisplayState; label: string; detail: string
  progress: number|null; stateStartedAt: number; evidenceAt: number; restoredUnconfirmed: boolean
}
AgentDisplayState = 'working'|'monitoring'|'waiting'|'permission'|'blocked'|'failed'
                  | 'interrupted'|'done'|'unverifiable'|'idle'|'unconfirmed'
```

`CONTRACT:` `displayOf(row, now: number, sessionRunning: boolean) → { display, label, detail }`,
pure, used by the plugin and copied into both window plugins (the windows can't import plugin
code; the copies share a test table). Rules ([logic table](logic.md#conceptual-model)):
`restoredUnconfirmed` and not done → unconfirmed; not done and `now - evidenceAt > 30 min` →
unverifiable if `sessionRunning` else idle, detail `No update in <N>m`; source title/program-status
with a needs-user signal and no hook → permission; else by state/outcome/mode. Done never decays.

`CONTRACT:` coarse status: working|monitoring → `working`; waiting|blocked|permission → `waiting`;
done|failed|interrupted → `done`; no row → `running` (or untouched when the session already exited).

### Normalizer contract

`CONTRACT:` `normalize(source, payload, cache) → Normalized | null`. `null` = "no status" (the
doc's "ignored"). `Normalized`:

```
{ eventName: string; state: AgentState|null; newTurn: boolean; sessionBoundary?: boolean
  outcome?: Outcome; interrupted?: boolean; fields: Partial<row text fields>
  childOps?: { op: 'start'|'stop'|'state'; id: string; kind: 'agent'|'shell'|'cron'; state? }[]
  inventory?: { tasks: {id, kind, running}[]; complete: boolean }   // Claude background_tasks, Grok tasks
  providerSession?: { id: string; transcriptPath: string|null }
  agentId?: string                                                   // event is from a child
  endsProcess?: boolean                                              // Claude SessionEnd rule
  cacheReset?: boolean }
```

Event-name extraction: `hook_event_name | hookEventName | hook_type | hookType`, jcode `event`,
Grok snake-cased, Copilot via Orca's `normalizeCopilotEventName`. Per-source rules are the logic
spec's [SC-8 table](logic.md#the-state-machine) and agent-status.md "Exact hook-to-state mapping";
port each from the Orca file named in [Orca map](#orca-map). Source IDs accepted: the 28 in the doc
plus `openclaude`; `claude-agent-teams` sessions post as `claude`. Unknown source → ignored.

### Apply order

`CONTRACT:` `apply(sessionId, normalized, evidence: { kind, at, agentPid?, agentStart?, replay })`.
Per session, events are applied strictly in arrival order through one promise queue (as today,
`main.ts:195-201`), extended to every producer (hooks, replay, facts, inference, presence). Steps:

1. Session lookup (`quirky.session/get`); ignore unknown, exited (except replay of a Stop), and
   `kind !== 'terminal'`.
2. Identity ([Identity rules](#identity-rules)); a rejected event changes nothing.
3. Capture: when `providerSession` differs from the session's, call
   `quirky.session/setProviderSession`; skip ids failing `providerSessionIdProblem`.
4. Children ops / inventory, then the fold ([D14](../../../loop/decisions/m1-agent-status.md)):
   port `ORCA/src/shared/agent-lead-status-fold.ts:35-54`. Inventory kinds follow
   `ORCA/src/shared/claude-background-task-inventory.ts:42-100` (agent → agent child; any other
   running type → shell; `session_crons` non-empty → cron). A child's question stashes the lead
   state and restores it on that child's next tool event, stop or idle.
5. Holds: Claude permission hold per `ORCA/src/main/agent-hooks/server/server-claude-status-rules.ts:57-102`.
6. Timing: `stateStartedAt` changes only when the folded state changes; `evidenceAt = at`;
   `turnStartedAt` set on a lead's `newTurn`.
7. Write row; `setStatus {session, status: coarse, agentStatus: summary}` only when either
   changed; emit `quirky.agent-status/changed {sessionId, row}`; notify per D27 (not on
   `sessionBoundary`, not on `replay`, not on `title`/`program-status` sources, only on a change
   into done/waiting/blocked).

Late-event rules ported as-is: Grok stale turn end (`server-grok-status-rules.ts:5-27`), Amp tool
events after `agent.end` (per thread, ≤32 threads), Antigravity events after a fully idle Stop,
Codex auto-review (`codex-events.ts:117-143`, read `approvals_reviewer` from the payload; no
rollout reads, D15).

### Identity rules

`CONTRACT:` ([D11](../../../loop/decisions/m1-agent-status.md)). A row's lead is
`{agent, providerSession}` from its first accepted event. An event is foreign, and ignored, when
the row is fresh (`displayOf` not unverifiable/idle/unconfirmed), not `lead.ended`, and either
(a) its source differs from `row.agent` (qwen-code and claude are different kinds; openclaude and
claude too), or (b) both have provider sessions and they differ — except a SessionStart whose
`source` is `clear` or `resume` (Claude, Codex `resume`/`clear`, qoder family `clear`/`resume`),
which moves the lead. `lead.ended` is set by `endsProcess`, the presence probe, or session exit;
an ended or stale row is replaced by the next event's agent as a new row.

### Shim contract

`CONFIG:` the `quirky-hook <source>` script (POSIX sh, `launch.ts`), in order:

1. Print the agent's answer to stdout first: `claude|openclaude|qoder|qoder-cn|qwen-code|codebuddy|droid|devin|muse|zcode|kimi|command-code` → `{}`;
   `cursor` → `{"permission":"allow"}` for `preToolUse|beforeShellExecution|beforeMCPExecution`,
   `{"continue":true}` for `beforeSubmitPrompt`, `{}` otherwise; `antigravity` → `{"decision":"ask"}`
   for PreToolUse, `{"decision":""}` for Stop, `{}` otherwise; others nothing. The event for these
   answers comes from `QUIRKY_HOOK_EVENT`, which the installed command sets (cursor, antigravity,
   copilot), as Orca does (`ORCA/src/main/cursor/hook-events.ts:15-24`,
   `ORCA/src/main/antigravity/hook-script.ts:19-31`).
2. Payload: stdin, or the last argument for `codex` notify. Grok and Antigravity don't close stdin,
   so for them read the first complete JSON value with a 5 s first-byte and 1.5 s idle bound (port
   `POSIX_HOOK_JSON_STDIN`, `ORCA/src/main/agent-hooks/hook-stdin-contract.ts:19-20,86-117`;
   with `python3`; when `python3` is missing, exit 0 without posting).
3. Exit 0 with no post when `QUIRKY_SESSION_ID` is empty or `CLAUDE_JOB_DIR` is set.
4. URL from `$QUIRKY_HOME/runtime.json` port (as today), else `QUIRKY_HOOK_URL`.
5. `curl -s --connect-timeout 0.5 -m 1.5 --noproxy 127.0.0.1 -o /dev/null -X POST` to
   `<url>/<source>?session=<id>&pid=<QUIRKY_HOOK_AGENT_PID>&pstart=<urlencoded lstart>&event=<QUIRKY_HOOK_EVENT>`;
   on failure, spool (below). `pstart` from `TZ=UTC0 LC_ALL=C /bin/ps -p $pid -o lstart=`; each
   param omitted when empty. The server passes `event` to plugins, and normalizers use it when the
   payload carries no event name (Copilot, Antigravity, Cursor).
6. Always `exit 0`.

`CONFIG:` spool: append one line `<source> <pid> <pstart-base64> <payload-base64>` to
`$QUIRKY_HOME/hook-spool/<session>.jsonl` (dir 0700, file 0600) unless the payload's event is a
tool event (`REGEX:` `"(hook_event_name|hookEventName)"[[:space:]]*:[[:space:]]*"(PreToolUse|PostToolUse|PostToolUseFailure)"`),
or the file exceeds 5,242,880 bytes. Drain (`src/spool.ts`) at activation before subscribing: skip
files older than 7 days, at most 1,024 files, apply records as `replay`, delete each file after.

`CONFIG:` the installed hook command for every global installer ([D32](../../../loop/decisions/m1-agent-status.md)):

```
[ -n "${QUIRKY_SESSION_ID-}" ] && [ -x "${QUIRKY_HOME-}/bin/quirky-hook" ] && QUIRKY_HOOK_AGENT_PID="${PPID-}" [QUIRKY_HOOK_EVENT=<Event>] "$QUIRKY_HOME/bin/quirky-hook" <source>; exit 0
```

`QUIRKY_HOOK_EVENT=<Event>` appears only for cursor, antigravity and copilot. jcode tokenizes its
value shell-style, so its value is `sh -c '<the command above>'`. Removal identifies Quirky's
entries by the substring `/bin/quirky-hook"` in the command, never by event name. Claude's
per-launch settings file uses the same command form.

### Installer contract

`CONTRACT:` each registry entry ([D6](../../../loop/decisions/m1-agent-status.md),
[D8](../../../loop/decisions/m1-agent-status.md), [D24](../../../loop/decisions/m1-agent-status.md),
[D25](../../../loop/decisions/m1-agent-status.md)):

```
Installer { agent: string; source: string
  files(home, env) → string[]                      // absolute paths it may touch
  install(home, env) → { changed: string[]; note?: string } // throws InstallError(message) on unparseable
  remove(home, env) → { changed: string[] }
  status(home, env) → 'installed'|'not-installed'|{ error: string } }
```

Invariants (tested once per format, then per agent by table):
- Merge only Quirky's entries; other keys, other tools' hooks and key order are kept; JSON written
  with 2-space indent and a trailing newline; a second `install` returns `changed: []` and leaves
  the bytes identical (compare normalized EOL before deciding to write).
- Unparseable file → `InstallError("Could not parse <path with ~>")`, file untouched.
- Writes are atomic (temp file in the same dir + rename), creating parent dirs 0700 as needed;
  files Quirky created and that become empty of anything but Quirky's entries are deleted on remove.
- Home: `process.env.HOME || homedir()`; per-agent env homes (`GROK_HOME`, `COPILOT_HOME`,
  `HERMES_HOME`, `KIMI_CODE_HOME`, `XDG_CONFIG_HOME`, `DSH_HOME`, `JCODE_HOME`, `KIRO_HOME`) read from
  the env passed in. Guard: when `NODE_ENV === 'test'` and home equals `homedir()`, every
  write is skipped and logged (copy of `plugins/quirky.agents/src/service.ts:454-466`).
- Hook entries carry Orca's timeouts: 10 s (`timeout: 10`) for the Claude-shaped, Codex, Cursor,
  Droid, Command Code, Grok, Devin, Zcode, Muse, dsh and Kimi formats; Gemini `10000` (ms); Kiro
  `timeout_ms: 10000`; Copilot `timeoutSec: 5`.
- Kimi: Quirky owns a block between `# >>> quirky-managed-kimi-hooks` and
  `# <<< quirky-managed-kimi-hooks` of `[[hooks]]` tables (`event`, `command`, `timeout`); install
  replaces the block, remove deletes it.
- jcode: the `[hooks]` table's scalar keys `<event> = '<command>'`; Quirky owns a key whose value
  contains the shim; a key the user owns is kept and reported in `message`; a `[hooks]` table is
  created at the end of the file when absent. Line-based edit only inside `[hooks]`.
- dsh: a marked YAML region (`# >>> quirky-managed-dsh-hooks` … `# <<<`) in `cordis.patch.yml`
  holding an `insert` entry (id `quirky-agent-hooks`) whose `configPath` points at
  `$QUIRKY_HOME/agent-hooks/dsh-hooks.json`, a Quirky-owned Claude-shaped hooks file.
- Muse: `settings.json` gets `managed_hooks_path` = `$QUIRKY_HOME/agent-hooks/muse-hooks.json`
  (Quirky-owned, Claude-shaped, 11 events) and an env allowlist entry for `QUIRKY_SESSION_ID`,
  `QUIRKY_HOME`, `QUIRKY_HOOK_URL`, `QUIRKY_HOOK_TOKEN` (Muse filters hook env; port
  `ORCA/src/main/muse/hook-config-json.ts:6-17`).
- Kiro: patch each `*.json` in the agents dir whose content parses and isn't Quirky-created; no
  agents dir → `not-installed` with note "no Kiro agents to patch".
- Hermes: `plugins/quirky-status/{plugin.yaml,__init__.py}`; `config.yaml` gets `quirky-status` in
  `plugins.enabled` and out of `plugins.disabled`, edited line-wise; an unparseable layout →
  `error`.
- Copilot: `{version:1, hooks:{Event:[{type:'command', bash:<command>, timeoutSec:5}]}}`.
- Cursor: `{version:1, hooks:{event:[{command, timeout}]}}`.
- Antigravity: top-level key `quirky-status` in `~/.gemini/config/hooks.json`; direct events as
  `{type,command,timeout}`, tool events as `{matcher:'*', hooks:[…]}`.
- Zcode: `hooks: {enabled: true, events: {Event: [{hooks: […]}]}}` (`enabled` set only when absent).
- OpenCode family: `quirky-<agent>-status.js` in `$OPENCODE_CONFIG_DIR` when set, else
  `$XDG_CONFIG_HOME/opencode/plugins/` (opencode2 the same dir with its own file); mimo-code in
  `$MIMOCODE_HOME/config/plugins/` or `~/.config/mimocode/plugins/` ([D38](../../../loop/decisions/m1-agent-status.md)).
- Pi family: `quirky-agent-status.ts` in `<agent dir>/extensions/`, agent dir from
  `PI_CODING_AGENT_DIR` (pi, omp) or `PRIME_AGENT_CODING_AGENT_DIR`, else `~/.pi/agent`,
  `~/.omp/agent`, `~/.prime/agent`.
- Plugin-file sources post `{hook_event_name, ...payload}` JSON to
  `<url>/<agent>?session=<QUIRKY_SESSION_ID>` with the token header, reading the port from
  `$QUIRKY_HOME/runtime.json` like the shim, with a ≤1 s abort; they do nothing when
  `QUIRKY_SESSION_ID` is unset. Port event selection from Orca's generators ([Orca map](#orca-map));
  drop Orca's pane/launch-token metadata.
- Codex: `~/.codex/hooks.json` (`$CODEX_HOME` when set); `note` = "Codex asks you to review these
  hooks once (/hooks)".

`CONTRACT:` methods (manifest `method` entries with schemas; [D30](../../../loop/decisions/m1-agent-status.md)):

```
list { worktree?: string } → (AgentStatusSummary & { sessionId, agent })[]
get { session: string, at?: number } → AgentRow & { display, label } | null   // at: compute display at this time
hooksStatus {} → { agent, status, files: string[], message?: string }[]        // every registry agent
hooksSetup { agent?: string } → { agent, status, changed: string[], note?, message? }[]
hooksRemove { agent?: string } → { agent, changed: string[], message? }[]
```

`hooksSetup` refuses with `failed-precondition` "Agent status hooks are turned off" while the
setting is off; an unknown `agent` is `invalid-params`. Status values: `installed`,
`not-installed`, `agent_disabled`, `cli_not_found`, `hooks_disabled`, `error`. Detection and
enablement come from `quirky.agents/list` (`installed`, `enabled`).

`CONFIG:` CLI (`cli-command` ids → words): `hooks-status` → `hooks status`, `hooks-setup` →
`hooks setup [agent]`, `hooks-remove` → `hooks remove [agent]`; text output is one
`changed <path>` line per file then `<agent>: <status>[ — note]`; `--json` prints the method
result. `list` and `get` stay generated.

`CONFIG:` setting `hooks`: boolean, default `true`, title "Agent status hooks", description per
D26. On `setting.changed` for `setting:quirky.agent-status/hooks`: false → run every remover; true →
install for detected+enabled agents. At activation, when true: install for detected+enabled agents
after refreshing existing Quirky entries; never remove.

### Claude per-launch settings

`CONTRACT:` the launch hook (`launch-hook:quirky.agent-status/agent-hooks`, agents `claude`,
`claude-agent-teams`, `codex`) writes `<dataDir>/claude-settings-<version-key>.json` once per
event set and returns `--settings <file>`. Event set from `CLAUDE_HOOK_EVENT_FIRST_VERSIONS`
(`ORCA/src/main/claude/claude-hook-event-versions.ts:9-23`), SessionEnd only from `2.1.261`,
unresolved → as `1.0.64`; never PreCompact. Version from `<command> --version` per the
`plugins/quirky.ask/suppression.ts` pattern (`ClaudeVersionGate` `:21`, `commandProbe` `:76`, 3 s
timeout, failure cached 30 min), command from `quirky.agents/get {agent:'claude'}`. Matchers: `*`
on tool and permission events. Codex keeps `-c notify=[...]` as today.

### OSC 7501

`CONTRACT:` `parseProgramStatusBody(body) → {type:'query'} | {type:'report', report} | null` with
rev 0.4's rules (port `ORCA/src/shared/program-status/protocol.ts:1-190`); record set with
replace-on-report, subtree `clear`, ≤256 records LRU, `endProgram()` on a `prompt` fact
(`ORCA/src/shared/program-status/records.ts`). Root projection: working → working; blocked with
kind permission/question → waiting, other → blocked; done → done success; error → done failure;
idle → done; no root → remove the program-status row. Precedence ([D22](../../../loop/decisions/m1-agent-status.md)):
apply the projection only when there is no hook row, the hooks setting is off, or the last hook
evidence is older than `HOOK_SILENCE_MS = 120_000` and the projection differs from the row's state.

`CONFIG:` host reply bytes: `ESC ] 7501 ; ? : states=idle,working,done,blocked,error : kinds=permission,question,auth ESC \`
(no spaces), written whenever a `?` body is seen on a live session, through the barrier.

### Title fallback

`CONTRACT:` `classifyTitle(title) → 'working'|'permission'|'idle'|null`, a port of
`ORCA/src/shared/agent-title-status.ts:226-326` with its helpers (`agent-title-core.ts`,
`agent-title-glyphs.ts`, `agent-name-token-match.ts`, the dsh/qoder/pi/opencode title helpers).
Applied from `quirky.terminal/title` events only when the session has no fresh hook row: working →
working, permission → waiting with display permission, idle → done.

### Inference

`CONTRACT:` from `onInput`: a write equal to `\x03` is ctrl-c, `\x1b` alone is plain-escape, a
write containing `\r` is Enter. Interrupt: record the baseline (prompt, evidenceAt,
stateStartedAt) and after `SETTLE_MS = 500` (scaled) apply done+interrupted+cancellation only if
unchanged, working, lead working, not restored, `now - evidenceAt ≤ 30 min`, and the agent rules of
`ORCA/src/shared/agent-interrupt-intent.ts` allow it (double-Escape agents need a second Esc while
`turnStartedAt` is unchanged). Question answered: Claude row waiting with `question` set, Enter →
restore the stashed state, else working.

### Presence

`CONFIG:` job `presence`, interval `10s`, initialDelay `10s`. For each row not done and not ended
with `lead.agentPid`: `process.kill(pid, 0)` fails, or `ps -o lstart=` (UTC) no longer equals
`lead.agentStart` → mark `lead.ended`, delete the row, coarse status `running`. Session exit
(`quirky.session/changed` with status exited, or `removed`) deletes the row.

### Timing for tests

`CONFIG:` `QUIRKY_TEST_AGENT_STATUS_TIME_SCALE` (positive number, default 1) multiplies
`SETTLE_MS`, `HOOK_SILENCE_MS` and the shim-independent waits; freshness and hydration ages are
tested through `get {at}` and seeded stores, never by scaling.

### Store

`SCHEMA:` `src/store.ts` migrations, appended after the existing first migration:

```
2: CREATE TABLE rows (session_id TEXT PRIMARY KEY, row TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE program_status (session_id TEXT PRIMARY KEY, records TEXT NOT NULL);
```

The existing `hooks` table is dropped from use (kept; `list` no longer reads it). Hydration at
activation: drop rows with `updated_at` older than 7 days or whose session is gone; set
`restoredUnconfirmed` on rows not done; push each surviving summary through `setStatus`.

### Worktree priority

`CONTRACT:` most urgent first: waiting, permission, blocked, failed, working, monitoring,
unconfirmed, unverifiable, interrupted, done, idle, then the coarse `running`, `exited`. Sessions
without `agentStatus` rank by their coarse status as today.

## DO-NOT-CHANGE fences

- `packages/pty-host/src/scanner.ts` marker handling (`MARKER`, `matchesMarkerPrefix`,
  `releaseHeld`, `finishOsc` order): the shell-ready barrier and the held-OSC ordering fix depend on
  it; add the 7501 branch only inside `reportOsc`.
- `PTY_PROTOCOL_VERSION` (`pty.ts:10`): a bump retires running hosts and their sessions (D34).
- `packages/pty-host/src/history/restore.ts`: replays must never write replies.
- `quirky.session/setStatus`'s `exited` → `finish` path: process exit stays authoritative.
- The hook HTTP route's token check and 400/200 answers (`server.ts:33-55`): other clients rely on
  them; only add query params.
- `plugins/quirky.ask` launch hook and its `--disallowedTools` args: both hooks run for claude;
  agent-status's args must not reorder or replace them.

## Always / Ask / Never

- **Always:** every test that writes agent configs uses a temporary `HOME` (unit: pass `home`;
  e2e: `startAgentsE2E`-style subprocess); every new method and event declares a schema; run
  `bun run test`, `bun test scripts` and `bun run typecheck` in each task's acceptance.
- **Ask (record a decision):** any per-agent value that Orca's source and agent-status.md disagree
  on (follow the doc, log it); any installer whose real config path can't be confirmed from Orca.
- **Never:** write the real `~/.claude`, `~/.codex` or any real agent config; parse transcripts or
  rollouts (D15); send notifications for replays or boundaries; block or slow a hook on daemon work.

## Cross-cutting

- **Security:** hook endpoint stays token-guarded; spool files 0600 in a 0700 dir; OSC 7501
  `msg`/`title` decoded with control characters rejected and capped; installed commands quote the
  shim path and never interpolate payload data.
- **Performance and memory:** the input fan-out is a synchronous call per write with no allocation
  beyond decoding; per-session caches are capped (children ≤64, program-status ≤256 records, Amp
  threads ≤32); rows are one SQLite row per session. No helper processes (architecture.md memory
  rules); the presence probe spawns `ps` only for rows with a PID, at most once per 10 s each.
- **Migration:** session store migration 5 is additive; agent-status migration 2 is additive.
  Rollback = older build ignores the column/tables.
- **Platform:** the shim's `ps -o lstart` and the installers' paths are macOS/Linux; Windows
  launchers are out (D29, `deferred: platform`).

## Testing strategy

| Area | Test file | Must cover |
|---|---|---|
| Scanner | `packages/pty-host/test/scanner.test.ts` | 7501 bodies incl. split chunks and byte-at-a-time; `?`; over-cap ignored |
| Host reply + prompt fact | `packages/pty-host/test/manager.test.ts`, `host.test.ts` (pattern: `askForDeviceStatus`) | reply bytes reach the program; no reply on restore replay; `prompt` fact emitted |
| Input fan-out | `packages/daemon/test/pty-client.test.ts` | every plugin's `write` reaches `onInput` listeners; revoked listeners stop |
| Hook route | `packages/daemon/test/...` existing hook tests | `pid`/`pstart` pass through; malformed values dropped |
| Shim | new `packages/daemon/test/hook-shim.test.ts` | SC-30 and SC-18's shim half, run with `/bin/sh` against a local HTTP stub and a closed port |
| Session summary | `plugins/quirky.session/test/{records,sessions}.test.ts` | migration 5; `setStatus` with summary emits `changed`; exit clears |
| Normalizers | `plugins/quirky.agent-status/test/normalize.test.ts` | the SC-8 table row by row, plus SC-1..SC-7, SC-9, SC-10 |
| Apply/identity/fold | `.../test/apply.test.ts` (in-process harness with fakes) | SC-1..SC-5, SC-11, SC-13..SC-15, SC-27's notification rules, SC-32 |
| Freshness/hydration | `.../test/freshness.test.ts` | SC-16 via `get {at}`; SC-17 via a seeded store and daemon restart |
| Fallbacks | `.../test/fallbacks.test.ts` | SC-21, SC-22 (facts injected with `FakePtyHost.fact`, replies via `inputs`), SC-23 with time scale |
| Inference | `.../test/inference.test.ts` | SC-20 table via `quirky.terminal/write` or `context.pty.write` |
| Installers | `.../test/install.test.ts` | per-format invariants; SC-24, SC-25 table, SC-26 against temp homes |
| Plugin sources | `.../test/plugin-sources.test.ts` | SC-31: load generated JS/TS with a stand-in host (bun), Hermes with `python3 -I` and a stand-in module |
| End to end | `.../test/e2e/*.e2e.test.ts` on `startAgentsE2E` | SC-12 (resume uses captured id), SC-19 (real fake-agent PID killed), SC-27 (setting off/restart/on), SC-28 (fake claude versions), SC-29, SC-33 — all through the `quirky` CLI |
| Window | `plugins/quirky.session/test/ui.test.ts`, `plugins/quirky.worktree/test/ui.test.ts` | glyph classes and labels per display state; worktree priority; progress ring |
| UI pass | `quirk:using-apps-like-a-user` | SC-34..SC-37 |

The acceptance bar is every SC in the logic spec mapped to at least one named test, and the full
gate green.

## Orca map

`S` = `/Users/zpyoung/PycharmProjects/orca/src`. Read these for exact values; don't copy structure.

- **Shared installer helpers:** `S/main/agent-hooks/installer-utils.ts` (types 24-47, ownership
  matcher 73-93, `removeManagedCommands` 176, `writeHooksJson` 296); registry
  `S/main/agent-hooks/managed-agent-hook-registry.ts:48-100`.
- **Claude-shaped:** `S/main/claude/hook-settings.ts` (`applyManagedHooks` 217, `removeManagedHooks`
  304), `S/main/claude/claude-managed-hook-events.ts`, `S/main/claude/claude-hook-event-versions.ts`;
  variants `S/main/{openclaude,qoder,qwen-code,codebuddy}/hook-service.ts`.
- **Codex:** `S/main/codex/codex-hook-definition.ts:19-29` (events), `codex-real-home-hooks-json.ts`.
- **Gemini** `S/main/gemini/hook-service.ts:34,194`; **Antigravity** `S/main/antigravity/{hook-service,hooks-json-bundle,hook-events,hook-script}.ts`;
  **Cursor** `S/main/cursor/{hook-service,hook-events,hook-script}.ts`; **Droid** `S/main/droid/hook-service.ts:36-61`;
  **Command Code** `S/main/command-code/hook-service.ts:25-86`; **Grok** `S/main/grok/{hook-service,grok-hook-config}.ts`, `S/shared/grok-session-paths.ts:43`;
  **Copilot** `S/main/copilot/{hook-service,copilot-managed-hook-definitions}.ts`; **Devin** `S/main/devin/{hook-settings,hook-config-json}.ts`;
  **Kiro** `S/main/kiro/hook-settings.ts`, `S/shared/kiro-home.ts`; **Zcode** `S/main/zcode/hook-settings.ts:42-137`;
  **Muse** `S/main/muse/{hook-settings,hook-config-json}.ts`; **Kimi** `S/main/kimi/kimi-hook-config-toml.ts`;
  **jcode** `S/main/jcode/{hook-settings,hook-config}.ts`; **dsh** `S/main/dsh/{hook-settings,dsh-home-patch}.ts`;
  **Hermes** `S/main/hermes/{hermes-managed-plugin-source,hermes-config-yaml,hermes-home-filesystem}.ts`.
- **Plugin sources:** Amp `S/main/amp/agent-status-plugin-source.ts`; OpenCode family
  `S/main/opencode/status-plugin-factory-source.ts:6-300`, `status-plugin-post-source.ts`,
  `S/main/mimo/hook-service.ts`; Pi family `S/main/pi/agent-status-*-source.ts`,
  `S/shared/pi-agent-kind.ts:15-35`.
- **Shim:** `S/main/claude/hook-script.ts:28-100`, `S/main/agent-hooks/hook-post-command.ts`,
  `S/main/agent-hooks/hook-stdin-contract.ts`, `S/main/agent-hooks/hook-process-capture.ts`.
- **Normalizers:** `S/shared/agent-hook-listener.ts:40-335`, `S/shared/agent-hook-listener/provider-dispatch.ts`,
  `provider-event-routing.ts` (`isNewTurnEvent`), and one file per source in
  `S/shared/agent-hook-listener/providers/` (`compatible-lifecycle-events.ts` serves qoder,
  qoder-cn, codebuddy; `opencode-family-events.ts` and `pi-family-events.ts` serve their families);
  tool fields in the matching `*-tool-fields.ts`; caps in `S/shared/agent-status-field-normalization.ts`.
- **Provider capture:** `S/shared/agent-session-resume.ts:196-289`.
- **Fold and children:** `S/shared/agent-lead-status-fold.ts`, `S/shared/agent-status-child-work-liveness.ts:48-60`,
  `S/shared/claude-background-task-inventory.ts:42`, `S/shared/agent-hook-listener/providers/claude-events.ts:68-153`,
  `claude-lifecycle-events.ts`, `S/shared/claude-subagent-roster.ts`.
- **Rules:** `S/shared/agent-interrupt-intent.ts`, `S/main/agent-hooks/server/server-status-inference.ts:74-302`,
  `server-claude-status-rules.ts:62-96`, `server-grok-status-rules.ts:5-27`,
  `S/shared/agent-hook-listener/providers/codex-events.ts:117-143`.
- **OSC 7501:** `S/shared/program-status/{protocol,records,agent-status-projector}.ts`,
  `S/main/agent-hooks/server/program-status/hook-precedence.ts`.
- **Titles:** `S/shared/agent-title-status.ts` and its imports listed in [Title fallback](#title-fallback).

Codex's auto-review flag is read from the hook payload's `approvals_reviewer` when present; Orca
reads it from the rollout, which this item doesn't (D15), so without the payload field a
PermissionRequest is waiting.

## Non-goals

As the logic spec's [Scope and non-goals](logic.md#scope-and-non-goals). Additionally: no change to
`SessionStatus`, the dock badge or `quirky.terminal`'s events; no new PTY protocol version; no
TOML/YAML parser dependency.
