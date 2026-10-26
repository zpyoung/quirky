# Tech spec: m1-providers

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Decisions: [m1-providers.md](../../../loop/decisions/m1-providers.md).
Tier gate: fired on "user asks" (logic Status: Tech spec: requested), "crosses a subsystem boundary" and "≳3 source files".

Paths are relative to the repo root. `ORCA` means `~/PycharmProjects/orca/src` (read-only; port from it,
never import it). Every section names the logic-spec anchor it serves.

## Architecture

Serves [Conceptual model](logic.md#conceptual-model) and [Data flow](logic.md#data-flow).

```
quirky.session (records, spawn, session CLI)  ──depends on──►  quirky.agents (catalog, config, plans, trust, delivery)
      │ context.call('quirky.agents/pick' | 'prepareLaunch' | 'prepareResume' | 'deliver')
      │ context.pty.spawn                         quirky.agents uses context.pty.subscribe/onData/write
      ▼                                           and context.call('plugin.contributions', {kind:'agent'})
   kernel (packages/daemon)  — pty-api gains per-plugin reference-counted subscriptions
```

- **New plugin `plugins/quirky.agents/`** (activation `startup`, no dependencies, `ui: dist/ui.js`,
  `cli: cli.ts`). Pure modules under `src/core/` are ports of Orca's `src/shared/tui-agent-*` code
  operating on validated catalog entries instead of Orca's `TuiAgent` union. Runtime modules under
  `src/` hold the store, detection, trust writers and the delivery runner. `src/ui.tsx` and
  `src/window/` hold the Agents view and the agent-tab commands.
- **`plugins/quirky.session/`** drops `src/agents.ts`, gains a dependency on `quirky.agents`, three
  new record fields, two methods and two CLI commands. Its UI menu reads the catalog.
- **Kernel:** `packages/protocol/src/model.ts` widens `Session.agent`; `packages/daemon/src/plugins/pty-api.ts`
  reference-counts subscriptions per plugin. Nothing else in the kernel changes.
- No new npm dependency. Bun, `bun:sqlite`, `node:fs`, `node:path`, `node:os` only.

## Code references

Serves every scenario; anchors gathered from the tree at `cc4d534`.

### Kernel

| File | Change |
|---|---|
| `packages/protocol/src/model.ts:24-46` | `AgentKind` becomes `string` (keep the alias name, doc: "`shell` or a catalog agent ID"). Delete `AGENT_KINDS` and fix every importer. Add the `Session` fields in [Data models](#data-models--schemas). |
| `packages/daemon/src/plugins/pty-api.ts` (`createPtyApi`, `fanoutFor`) | Reference-counted subscriptions, see [PTY subscriptions](#pty-subscriptions-kernel). |
| `packages/daemon/test/` | A test for the reference counting (new file `pty-api-subscriptions.test.ts`). |

### `plugins/quirky.agents/` (new)

| File | Holds | Ported from |
|---|---|---|
| `quirky-plugin.json` | manifest: 45 `agent` entries, methods, event, settings, view, commands, keybinding, cli-commands | ORCA `shared/tui-agent-config.ts`, `tui-agent-permissions.ts:12-49`, `tui-agent-selection.ts:7-53`, `renderer/src/lib/agent-catalog-entries-primary.ts`, `-secondary.ts`, `tui-agent-display-names.ts` |
| `package.json` | copy of `plugins/quirky.session/package.json` with the name changed (required by `plugins/test/imports.test.ts:84`) | — |
| `main.ts` | `activate(context)`: open store, build catalog, detect, register methods, subscribe | — |
| `src/core/entry.ts` | `AgentEntry` type, `validateEntry(name, data)`, defaults (`launch`/`process` default to `detect`) | ORCA `shared/tui-agent-config-types.ts`, `tui-agent-config.ts:19-25` |
| `src/core/catalog.ts` | `buildCatalog(contributions)` → `{ agents, problems }` (D7, D8 rules, auto-pick ordering) | — |
| `src/core/shell.ts` | POSIX tokenizer and quoting | ORCA `shared/tui-agent-startup-shell.ts` (POSIX parts only) |
| `src/core/permissions.ts` | mode resolution, summary, apply | ORCA `shared/tui-agent-permissions.ts:51-213` |
| `src/core/select.ts` | `pickAgent` | ORCA `shared/tui-agent-selection.ts` |
| `src/core/plan.ts` | `buildLaunchPlan`, `buildResumePlan` | ORCA `shared/tui-agent-startup.ts`, `tui-agent-launch-command.ts`, `tui-agent-launch-defaults.ts`, `flag-prompt-startup.ts`, `hermes-startup-query.ts` (POSIX), `tui-agent-resume-startup.ts`, `agent-resume-launch-command.ts`, `agent-resume-argv.ts` |
| `src/core/ready.ts` | ready-signal scanners | ORCA `shared/draft-paste-ready-scanner.ts`, `draft-paste-ready-timeout.ts`, plus its tests `draft-paste-ready-scanner*.test.ts` |
| `src/core/paste.ts` | bracketed-paste encoding and Enter timing | ORCA `shared/terminal-bracketed-paste-text.ts`, `agent-prompt-injection.ts:19-109` |
| `src/store.ts` | `AgentConfigStore` over `context.openStore` | — |
| `src/detect.ts` | login-shell PATH read and filesystem walk | ORCA `main/preflight/agent-command-detection.ts`, `shared/tui-agent-detection-commands.ts` |
| `src/trust.ts` | seven trust writers | ORCA `main/agent-trust-presets.ts`, `main/agent-workspace-trust.ts`, `main/claude/claude-folder-trust-file.ts`, `main/codex/config-toml-trust.ts` |
| `src/delivery.ts` | `DeliveryRunner` (subscribe, scan, paste, Enter, outcome) | ORCA `renderer/src/lib/agent-paste-draft.ts:63-140` behavior |
| `src/service.ts` | `AgentsService`: method handlers over the pieces above | — |
| `cli.ts` | hand-written `cli-command` handlers | — |
| `src/ui.tsx`, `src/window/*.tsx` | Agents view, `open-settings`, `new-agent-tab`, `new-<id>-tab` handlers | layout from research/orca-features/img/providers/01-06 |
| `test/` | unit tests per core module, service tests, e2e tests, fixtures | ORCA tests named above |

### `plugins/quirky.session/`

| File | Change |
|---|---|
| `quirky-plugin.json` | `dependencies: ["quirky.worktree", "quirky.agents"]`. `create.params`: drop `required: ["agent"]` and the `agent` enum; add `submitPrompt` (boolean), `waitForPrompt` (boolean). New methods `resume`, `setProviderSession`. Every inlined Session schema copy (`list.items`, `get`, `create`, `register`, `setStatus`, event `changed.data.session`) drops the `agent` enum and gains the new fields. New `cli-command`s `resume`, `set-provider-session`; `new` gains flags `wait`, `draft` and loses `required` on `agent`. |
| `src/agents.ts` | delete; delete `test/agents.test.ts` (its cases move to `quirky.agents` tests) |
| `src/sessions.ts` (`create` 47-93, `register`, `newRecord`, `reconcile`) | new create flow, `resume`, `setProviderSession`, startup sweep of `pending` deliveries |
| `src/records.ts` | second migration; `Row`, `toSession`, `INSERT`, `update` cover the new columns |
| `main.ts` | register `resume`, `setProviderSession` |
| `cli.ts` | `new` (optional `--agent`, `--wait`, `--draft`, prints `prompt`), `resume`, `set-provider-session` |
| `src/window/NewSessionMenu.tsx`, `PromptDialog.tsx`, `SessionTabs.tsx`, `model.ts` | menu from `quirky.agents/list`; `AgentKind` is now `string`; "Manage agents" item; labels from the catalog |
| `test/` | update `cli.test.ts` command list and `--agent` messages, `sessions.test.ts`, `sessions-launch.test.ts` stubs (`call` must answer `quirky.agents/*`), `support.ts` (`SESSION_PLUGINS.real` adds `quirky.agents`, or a fake `quirky.agents` under `test/fakes/`) |

### Other plugins

| File | Change |
|---|---|
| `plugins/quirky.structured/quirky-plugin.json:20,32` | drop the five-value `agent` enum copies (keep the claude-only runtime check at `main.ts:133`) |
| `plugins/quirky.terminal/test/fakes/quirky.session/*`, `plugins/quirky.repo/test/fakes/quirky.session/main.ts`, `plugins/quirky.agent-status/test/fakes/quirky.session/main.ts`, `plugins/quirky.structured/test/fakes/quirky.session` | compile against the widened type; drop enum copies |
| `plugins/quirky.agent-status/quirky-plugin.json` | no change (its launch hook stays `agents: ["claude","codex"]`) |

## Contracts & interfaces

### Agent entry (manifest data)

Serves [Conceptual model](logic.md#conceptual-model), SC-1 to SC-4.

SCHEMA: one entry in `contributes.agent` (all fields optional unless marked; unknown fields are a validation error):

| Field | Type | Meaning |
|---|---|---|
| `id` | string, required | the agent ID (the contribution name) |
| `label` | string, required | display name |
| `detect` | string, required | command looked for on PATH |
| `detectAliases` | string[] | other names that also count |
| `detectRequires` | string[] | commands that must also be found |
| `launch` | string | command string typed before arguments; default `detect` |
| `process` | string | expected process name; default `detect` |
| `env` | object of strings | environment always applied (claude-agent-teams) |
| `prompt` | enum, required | `argv`, `flag-prompt`, `flag-prompt-interactive`, `flag-interactive`, `hermes-query`, `stdin-after-start` |
| `promptSeparator` | `"--"` | placed before an argv prompt |
| `draftFlag` | string | native draft flag (`--prefill`) |
| `yolo` | string | Yolo arguments text |
| `auto` | string | Auto arguments text |
| `yoloEnv` | object of strings | Yolo environment (goose) |
| `stripArgs` | string[] | tokens removed from saved arguments at launch (opencode, kilo) |
| `resume` | string[] | resume argv template after the command; placeholders `{id}`, `{transcript}`, `{transcriptOrId}` |
| `fork` | string[] | fork argv template (same placeholders) |
| `resumeStyle` | `"claude-splice"` | use the Claude selector splice (claude, claude-agent-teams per ORCA) |
| `readySignal` | enum | `render-quiet-after-bracketed-paste` (default), `render-cursor-after-bracketed-paste`, `grok-composer-prompt`, `dsh-composer-prompt`, `zcode-composer-prompt`, `codex-composer-prompt` |
| `submitSignal` | enum | the above plus `opencode-agent-row`; default `readySignal` |
| `readyTimeoutMs` | integer | default 8000 |
| `blindPaste` | boolean | default true; false for codex |
| `submitRetryMs` | integer | extra Enter delay (codex, qwen-code 1200) |
| `lineSettleMs` | integer | per-line Enter delay (antigravity 45) |
| `enterWithPaste` | boolean | omp |
| `trust` | enum | `claude`, `cursor`, `copilot`, `codex`, `antigravity`, `qoder`, `qoder-cn` |
| `homepage`, `install` | string (URL) | links for the Agents view |
| `windows` | object | Orca's Windows-only fields kept as opaque data, never read (D13) |

Invariants: `fork` without `resume` is invalid; `{transcript}` placeholders make the agent need a
transcript path to resume; values are ported verbatim from ORCA (labels, flags, timeouts, signals);
the 45 entries appear in the manifest in ORCA's `TUI_AGENT_AUTO_PICK_ORDER`, and `buildCatalog` orders
built-ins by that order, then other plugins' agents by plugin ID then name.

claude-agent-teams entry (D29): `detect: "claude"`, `launch: "claude --teammate-mode in-process"`,
`process: "claude"`, `env: {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"}`, `prompt: "stdin-after-start"`,
Claude's `yolo`/`auto`/`trust`/`resumeStyle`, no `resume` (ORCA: not resumable).

### `quirky.agents` methods

Serves SC-1 to SC-17, SC-26 to SC-29, SC-36. All params validated by schema (m0-scripting). Errors use
`context.error(kind, message)`; messages are the logic spec's exact strings.

CONTRACT:
```
list({ all?: boolean }) -> AgentListing                      readOnly
get({ agent: string }) -> AgentInfo                            readOnly; not-found "unknown agent: <id>"
refresh({}) -> AgentListing                                     re-reads login PATH, re-detects, emits changed
setEnabled({ agent, enabled: boolean }) -> AgentInfo           disabling the default sets default-agent to "auto"
setDefault({ agent: string }) -> AgentListing                  "auto" | "shell" | agent ID; unknown -> invalid-params
configure({ agent, command?: string, args?: string, env?: Record<string,string>,
            reset?: ("command"|"args"|"env")[] }) -> AgentInfo
setPermissions({ mode: "manual"|"auto"|"yolo", agent?: string, replaceCustom?: boolean })
            -> { summary: PermissionSummary, changed: string[] }
plan({ agent, prompt?, submitPrompt?: boolean, cwd?: string }) -> LaunchPlan     readOnly, no trust write, no hooks
pick({ preferred?: string, forAgentTab?: boolean }) -> { agent: string }          "shell" when nothing fits (not for forAgentTab: conflict "No installed agent is enabled.")
prepareLaunch({ agent, cwd, prompt?, submitPrompt?, hookArgs: string[], hookEnv: Record<string,string|null> }) -> LaunchPlan
            writes trust when the setting is on; refuses disabled ("agent <id> is disabled") and unknown agents
prepareResume({ agent, cwd, record: LaunchRecord|null, providerSession: ProviderSession, fork: boolean,
                hookArgs, hookEnv }) -> { command: string, env: Record<string,string|null> }
deliver({ sessionId, agent, text, submit: boolean }) -> { delivery: "pasted"|"unconfirmed"|"not-delivered" }
            resolves when settled (up to readyTimeoutMs + Enter delays)
event changed {}          after any catalog, detection, config or setting change that alters `list`
```

- `configure` semantics: `command` equal to the catalog `launch` or empty removes the override.
  `args` stores the text as given (empty string = Manual, owns the key); unbalanced quotes fail with
  "CLI arguments are invalid: <reason>" and store nothing; a command override that fails to tokenize
  fails with "Agent command override is invalid: <reason>". `env` replaces the whole override; a
  reserved name (`isReservedLaunchEnv`, `packages/protocol/src/plugins.ts`) fails invalid-params.
  `reset` removes the named overrides. A call that changes nothing emits no `changed`.
- `setPermissions` follows ORCA `applyAgentPermissionMode`; per-agent errors are SC-16's strings.
  `changed` lists agents whose stored arguments or environment actually changed; empty means no event.
- `prepareLaunch` order of the command string: `<command> <user args> <hook args> <prompt part>`,
  where `<user args>` is the saved arguments (or the Yolo default when unset) tokenized, with
  `stripArgs` removed, each token re-quoted; `<prompt part>` per mode. Environment: `entry.env`, then
  the user environment override (or `yoloEnv` when unset and the mode is Yolo), then `hookEnv`.
  `promptDelivery`: `null` without a prompt; `command-line` when the prompt rides the command;
  `pending` when `paste` is set. A prompt over 131,072 bytes (UTF-8) in a command-line mode, or a
  Hermes plan over 24,000 bytes, moves to `paste`. `submitPrompt: false` uses `draftFlag` when the
  entry has one, else `paste` with `submit: false`. A prompt containing U+0000 fails invalid-params.
- `deliver` contract: see [Delivery](#delivery).

### `quirky.session` methods (changed and new)

Serves SC-8 to SC-10, SC-18 to SC-28, SC-30 to SC-35, SC-38.

CONTRACT:
```
create({ worktree?, agent?, prompt?, submitPrompt?: boolean = true, waitForPrompt?: boolean = false,
         cols?, rows? }) -> Session
resume({ session: string, providerSession?: string, transcriptPath?: string, fork?: boolean }) -> Session
setProviderSession({ session: string, id: string, transcriptPath?: string }) -> Session
```

`create` sequence (replaces `sessions.ts:47-93`; keep its closed-while-starting checks):
1. `agent` omitted → `quirky.agents/pick({})`. `agent === "shell"` keeps today's shell path (no
   `quirky.agents` call beyond pick).
2. Title from the agent's catalog label (`quirky.agents/get`), numbered as today.
3. Insert `starting`; run `context.launch.hooks` as today.
4. `quirky.agents/prepareLaunch` with the hooks' `args`/`env` → `LaunchPlan`.
5. `pty.spawn` with `argv: context.launch.commandArgv(plan.command)`, `env: context.launch.env({..., envPatch: plan.env})`.
6. Store `launch: plan.record`, `promptDelivery: plan.promptDelivery`; set `running`.
7. If `plan.paste`: call `quirky.agents/deliver` without awaiting unless `waitForPrompt`; on settle,
   update `promptDelivery` and emit `changed`. A rejected `deliver` call records `not-delivered`.
8. `reconcile({startup:true})` also sets every `pending` delivery to `not-delivered`.

`resume`: refusal order and strings are SC-35's, then SC-25's ID rules (also for
`setProviderSession`): length 1–512, no leading `-`, no C0/C1 control characters. The new session
copies `worktreeId` and `cwd` from the old one (`existsSync(cwd)` else the folder error), runs
launch hooks for the new session ID, calls `prepareResume`, spawns, sets `resumedFrom`, and copies
`launch` from the old record. `providerSession` from params overrides the record's. Fork refusals:
"<agent> can't fork from Quirky yet" when the entry has no `fork`.

### PTY subscriptions (kernel)

Serves SC-20 to SC-28 (delivery reads output while `quirky.terminal` may also be attached).

CONTRACT: in `createPtyApi`, `subscribe(sessionId)` records `(pluginId, sessionId)` and always calls
the host (a repeat subscribe only refreshes the replay, `packages/pty-host/src/session.ts:205-215`).
`unsubscribe(sessionId)` removes this plugin's mark and calls the host only when no plugin holds the
session. A plugin subscribing twice and unsubscribing once still holds it (count per plugin).
`revoke()` drops the plugin's marks with the same rule. `onReconnect` listeners stay responsible for
re-subscribing.

### Delivery

Serves SC-20 to SC-28 and the defect SC-23.

- `DeliveryRunner.deliver(sessionId, entry, text, submit)` subscribes to the session, feeds the
  replay then live chunks to the entry's scanner (`src/core/ready.ts`), and resolves:
  - signal seen → write `encodeBracketedPaste(text)`; if `submit`, write `\r` as a separate write
    after `500 + ceil(bytes / 4096)` ms plus `lineSettleMs × lines`, or in the same write when
    `enterWithPaste`; then if `submitRetryMs`, one more `\r` after it → `pasted`;
  - deadline (`readyTimeoutMs`, or the submit signal's timeout) passes, session alive, `blindPaste`
    → same writes → `unconfirmed`; `blindPaste: false` → no write → `not-delivered`;
  - session exits, is forgotten or closed first, or the PTY reconnects mid-wait → no write →
    `not-delivered`.
- Writes after resolution never happen; timers are cleared on settle; the runner unsubscribes when
  done. Nothing is retried after the first paste write.
- CONFIG: `QUIRKY_TEST_AGENT_TIME_SCALE` (float, default 1) multiplies every delivery timer; read once
  at activation. Tests only.
- Encoding: CRLF and lone LF → CR; every ESC (0x1B) → `␛` (U+241B); wrapped in `ESC[200~` / `ESC[201~`.

### Detection

Serves SC-5 to SC-7.

- Login PATH: `Bun.spawn([context.launch.shell, '-l', '-c', 'printf %s "$PATH"'])`, 5 s timeout,
  stdout trimmed; on failure or timeout, `process.env.PATH`.
- Search list: login PATH entries, then `$QUIRKY_HOME/bin`, then the install directories:
  `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/.cargo/bin`, `~/.deno/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin`. CONFIG: `QUIRKY_AGENT_SEARCH_DIRS` (colon list) replaces the
  install directories when set (tests set it to empty or temp dirs).
- A command is found when some directory has a regular file of that name with an execute bit.
  `existsSync`/`statSync` only; never execute anything.
- Installed = (`detect` or any `detectAliases` found) and every `detectRequires` found.

### Trust

Serves SC-36. Writers take `(folder, userHome)`; `userHome` is `os.homedir()` read at call time.
Each writer preserves unrelated keys, writes atomically (temp file + rename), creates parents, and
throws on failure; `prepareLaunch` catches, logs `trust for <agent> failed: <message>` and continues.
Formats are ORCA's (`agent-trust-presets.ts`, `claude-folder-trust-file.ts:93-102`,
`config-toml-trust.ts`). The folder is canonicalized with `realpathSync` as ORCA does.

## Data models / schemas

SCHEMA (protocol `Session`, additions):
```
launch: { command: string, args: string, env: Record<string,string> } | null   // null for shell and v1 rows
providerSession: { id: string, transcriptPath: string | null } | null
promptDelivery: null | "command-line" | "pending" | "pasted" | "unconfirmed" | "not-delivered"
resumedFrom: string | null
```

SCHEMA (session store migration 2, `plugins/quirky.session/src/records.ts` `sessionMigrations`):
`ALTER TABLE sessions ADD COLUMN launch TEXT` (JSON), `provider_session TEXT` (JSON),
`prompt_delivery TEXT`, `resumed_from TEXT`. All nullable; migration 1 untouched.

SCHEMA (`quirky.agents` store, migration 1):
`agent_config(agent TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0, command TEXT, args TEXT, env TEXT)`;
NULL means "not overridden"; `args = ''` is Manual.

SCHEMA (`AgentListing`):
```
{ defaultAgent: string, workspaceTrust: boolean,
  permissions: { summary: "manual"|"auto"|"yolo"|"mixed", nonAuto: "manual"|"yolo"|"mixed" },
  agents: AgentInfo[],
  problems?: { plugin: string, id: string, status: "invalid"|"conflict", error: string }[] }   // only with all
AgentInfo = { id, label, plugin, installed: boolean, enabled: boolean, isDefault: boolean,
  promptMode, resumable: boolean, canFork: boolean, homepage: string|null, install: string|null,
  command: string, commandOverridden: boolean, args: string, argsOverridden: boolean,
  env: Record<string,string>, envOverridden: boolean, showEnv: boolean,
  permissions: { mode: "manual"|"auto"|"yolo"|"custom"|null, hasAuto: boolean } }
```
`permissions.mode` is `null` for agents with no `yolo`/`yoloEnv`; `custom` for custom arguments.
`showEnv` is true when the entry has `yoloEnv` or the user has an environment override.

SCHEMA (`LaunchPlan`):
```
{ agent: string, command: string, env: Record<string,string|null>,
  record: { command: string, args: string, env: Record<string,string> },
  promptDelivery: null | "command-line" | "pending",
  paste: { text: string, submit: boolean } | null }
```

CONFIG (settings, `quirky.agents` manifest): `default-agent` string, default `"auto"`, title
"Default agent"; `workspace-trust` boolean, default `true`, title "Trust the folder when Quirky starts
an agent".

CONFIG (UI contributions, `quirky.agents` manifest): view `settings` ("Agents"); commands
`open-settings` ("Open agent settings"), `new-agent-tab` ("New agent tab (default agent)"),
`new-<id>-tab` for each of the 45 ("New <Label> tab"); keybinding `new-agent-tab` key `mod+alt+t`.

CONFIG (CLI, `quirky.agents` `cli-command`s, words → method): `list` (`--all`), `get <agent>`,
`refresh`, `enable <agent>`, `disable <agent>`, `default <agent>`, `configure <agent>` (`--command`,
`--args`, repeatable `--env KEY=VALUE`, repeatable `--reset`), `permissions <mode>` (`--agent`,
`--replace-custom`), `plan <agent>` (`--prompt`, `--draft`). `list` prints a table with columns
ID, LABEL, INSTALLED, ENABLED, DEFAULT, PERMISSIONS, PROMPT, RESUME; `plan` prints `command`,
`prompt` and `env` records; `--json` prints the method result.

## DO-NOT-CHANGE fences

- `packages/daemon/src/launch.ts` `commandArgv`, `buildSessionEnv`: the exec-under-login-shell launch
  is a locked decision (D11) and every session depends on it.
- `packages/daemon/src/plugins/registry.ts` override and disable precedence: the catalog relies on
  the kernel's existing rules (D6); changing them changes every contribution kind.
- `plugins/quirky.agent-status/main.ts` hook logic and manifest: provider capture is m1-agent-status's
  (D26); this item only keeps its launch hook working.
- `plugins/quirky.session/src/records.ts` migration 1: stores already on disk have run it.
- `docs/loop/LOOP.md`, `scripts/build-loop/`, `docs/loop/queue.json`, `docs/loop/DECISIONS.md`: loop rules.

## Always / Ask / Never

- **Always:** port Orca values verbatim and cite the ORCA file in the commit body; validate every
  `agent` entry before use; build command strings only from tokenized, re-quoted pieces; keep
  `quirky.agents` free of imports from other plugins or `packages/*` except `@quirky/protocol`
  (SC-24 fence); give every new or changed method a schema; start test daemons with temporary
  `QUIRKY_HOME` and `HOME` and kill every process they start.
- **Ask (decide and record a decision):** helper structure inside `src/core/`; exact scanner porting
  shape; how the Agents view is split into components.
- **Never:** execute a command to detect an agent; write to the real `~/.claude.json`, `~/.codex`,
  `~/.cursor` or `~/.copilot` in a test; paste twice for one launch; type into a running agent after
  `deliver` settled; add a `quirky.session` dependency to `quirky.agents` (cycle).

## Cross-cutting

- **Security:** user arguments never reach the shell unquoted (SC-12). Trust writes only touch the
  session's own folder entry. The prompt in a Hermes plan travels in the environment and is unset
  before `hermes` runs.
- **Migration:** v1 and M0 session rows get `NULL` new columns and resume with the catalog command
  and no arguments (D24). Existing stores get migration 2 in place.
- **Behavior change:** Yolo becomes the default (D16); the CHANGELOG-free repo records it in D16 only.
- **Observability:** every skipped agent entry, trust failure and `not-delivered` outcome is a
  `context.log` line naming the agent and session.
- **Rollback:** reverting the merge leaves migration-2 columns in place; migration 1 code ignores them.

## Testing strategy

Serves [Behavior & scenarios](logic.md#behavior--scenarios). Every scenario gets a test named
`SC-<n>: ...`. Flow tests drive the daemon API (`QuirkyClient.callAny`) or the CLI (`runCli`).

- **Unit (no daemon):** `plugins/quirky.agents/test/core/*.test.ts` for entry validation (SC-4),
  catalog (SC-3, SC-4), shell tokenizing (SC-12), permissions (SC-14 to SC-17), selection (SC-8,
  SC-9), plan building (SC-14, SC-17 to SC-19, SC-26, SC-27, SC-29, SC-32 to SC-34), ready scanners
  (SC-21, port ORCA's scanner tests and trace fixtures), paste encoding and timing (SC-20, SC-25).
  A table test checks all 45 manifest entries against ORCA's values for detect, launch, prompt mode,
  resume, yolo, auto and timeouts.
- **Service (in-process daemon, fake PTY host):** `plugins/quirky.agents/test/service.test.ts` with
  `startHarness` from `packages/daemon/test/helpers.ts` for listing, config, permissions, events
  (SC-1, SC-2, SC-3, SC-10, SC-11, SC-13, SC-15, SC-16). Session changes in
  `plugins/quirky.session/test/` with the real `quirky.agents` linked into the builtin dir.
- **E2E (subprocess `quirkyd`, real PTY host, fake agents):** `plugins/quirky.agents/test/e2e/*.e2e.test.ts`
  with a shared fixture `plugins/quirky.agents/test/support/e2e.ts` that:
  - makes short temp dirs under `/tmp` (`QUIRKY_HOME` like `/tmp/qa-XXXX`, unix socket length);
  - writes fake agents into `<tmp>/fakebin/<name>`: an executable script whose shebang is
    `process.execPath` running `plugins/quirky.agents/test/support/fake-agent.ts` with a behaviour
    file `<tmp>/fakebin/<name>.json` (output steps with delays, raw mode, exit-after), recording
    argv, chosen env names, cwd and every stdin chunk with a timestamp to `<tmp>/fakebin/<name>.log.jsonl`;
  - writes a fake login shell `<tmp>/shells/sh` that drops `-l` and execs `/bin/sh` with the rest,
    so macOS `/etc/profile` (`path_helper`) can't put real agent CLIs ahead of the fakes;
  - spawns `quirkyd` (`packages/daemon/src/main.ts`) with env `QUIRKY_HOME`, `HOME=<tmp>/home`,
    `SHELL=<tmp>/shells/sh`, `PATH=<tmp>/fakebin:/usr/bin:/bin`, `QUIRKY_AGENT_SEARCH_DIRS=` (or a
    temp dir), `QUIRKY_PORT=0`, `QUIRKY_TEST_AGENT_TIME_SCALE` (0.1 for deadline tests);
  - adds a real `git init` repo as the worktree (`quirky repo add`);
  - on cleanup kills `quirkyd`, the PTY host (`status.get` → `ptyHost.pid`) and every fake, and
    removes the temp dirs.
  E2E covers SC-5 to SC-7, SC-12, SC-18 to SC-20, SC-22 to SC-28, SC-30, SC-31, SC-34 to SC-38.
- **UI:** `plugins/quirky.agents/test/ui/*.test.tsx` mount the Agents view against `packages/ui/test/mock-daemon.ts`
  or the headless window (`packages/ui/test/fixtures/headless-window.ts`) for SC-39 to SC-43; the
  loop's `quirk:using-apps-like-a-user` web pass runs the same scenarios against a built daemon.
- **Kernel:** `packages/daemon/test/pty-api-subscriptions.test.ts` for reference counting.
- **Acceptance bar:** `bun run test`, `bun test scripts`, `bun run typecheck` pass; every SC has a
  named test; e2e files finish within their per-test timeouts (Bun's default is 5 s, so pass a
  third argument).

## Non-goals

Everything in the logic spec's [Scope & non-goals](logic.md#scope--non-goals), plus: no change to the
PTY host protocol, no shell-ready barrier (m1-term-daemon), no terminal-idle signal, no Windows code
paths, no new kernel contribution-kind validation for `agent`.
