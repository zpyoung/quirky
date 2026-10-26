# Rest of M0: CLI core, UI bridge, v1 as built-in plugins, distros and safety

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m0-core.md](../../../loop/decisions/m0-core.md)). Tech spec: requested; authored as [tech.md](tech.md) (gate: requested, crosses subsystems).

**Amendments:**
- 2026-10-26, tech-spec authoring: SC-23 keeps v1's rule that the setting gates only the OS notification; packaging the built-ins into the desktop bundle is in scope, since the packaged app has no features without them.

## Conceptual model

M0 ends with the plugin kernel carrying all of v1
([roadmap.md](../../../roadmap.md#m0-plugin-kernel-with-v1-moved-onto-it)). Earlier items built the
registry, the daemon and UI plugin APIs and the scripting surface. This item finishes M0 in four
parts that share one exit test.

**1. CLI core.** The `quirky` CLI reaches the daemon over a unix socket and authenticates with the
runtime token ([D16](../../../loop/decisions/m0-core.md)). It prints its own version offline
([D18](../../../loop/decisions/m0-core.md)). Repo and worktree arguments are **selectors** such as
`name:api` or `branch:fix-login`, resolved by the daemon with the caller's cwd and session identity
([D10](../../../loop/decisions/m0-core.md)). Every mutating call carries a **request ID**, so a retry
after a lost reply returns the first outcome instead of doing the work twice
([D19](../../../loop/decisions/m0-core.md)).

**2. UI bridge.** The daemon owns the window's **layout**: which view is open and with what input,
which panel is open, whether the sidebar shows, and where focus is
([D21](../../../loop/decisions/m0-core.md)). The window renders that layout, and layout changes are
daemon methods anyone can call. Each mounted plugin slot can **report** a JSON summary of what it
shows ([D22](../../../loop/decisions/m0-core.md)). `quirky ui state` returns all of it. A plugin's UI
command, whose code lives in the window, is run through the API by routing it to one open window
([D23](../../../loop/decisions/m0-core.md)).

**3. v1 as built-ins.** v1's features leave the daemon core and become eight built-in plugins, each
with its namespaced methods, events, CLI command group and UI contributions
([D5](../../../loop/decisions/m0-core.md), [D24](../../../loop/decisions/m0-core.md)):

| Plugin | Feature | CLI group | UI contribution | Depends on |
|---|---|---|---|---|
| `quirky.repo` | repos | `repo` | (inside the worktree sidebar) | |
| `quirky.worktree` | worktrees | `worktree`, alias `wt` | sidebar section `worktrees` | repo |
| `quirky.session` | session records, agent launch | `session` | view `worktree` (session tabs, terminal, transcript) | worktree |
| `quirky.terminal` | terminal input and output | `terminal`, alias `term` | | session |
| `quirky.agent-status` | hooks, status changes, finish notifications | `agent-status` | | session |
| `quirky.git` | source control | `git` | panel `source-control` | worktree |
| `quirky.ask` | asks | `ask` | panel `questions` | |
| `quirky.structured` | structured background sessions | `structured` | | session, ask |

The plugins use only the public plugin API, which grows here so they need nothing private
([D11](../../../loop/decisions/m0-core.md), [D31](../../../loop/decisions/m0-core.md)): PTY sessions,
the kernel's notification service, the launch environment and launch-hook pipeline, the state
directory, and binary streams for connection-bound methods. Plugins also gain **CLI commands**,
declared in the manifest and run either generically against a method or by code from a plugin CLI
module ([D9](../../../loop/decisions/m0-core.md)), and extra group words through `cliAliases`
([D8](../../../loop/decisions/m0-core.md)).

v1's wire names move into the plugins' namespaces (`repo.list` becomes `quirky.repo/list`), its
events become plugin events, its three settings become plugin settings, and the protocol version
goes to 2 ([D6](../../../loop/decisions/m0-core.md), [D7](../../../loop/decisions/m0-core.md),
[D13](../../../loop/decisions/m0-core.md)). v1's CLI words, positionals and text output stay
([D34](../../../loop/decisions/m0-core.md)), and a v1 home's data carries over
([D14](../../../loop/decisions/m0-core.md)).

**4. Distros and safety.** A **distro** is a manifest naming plugins, settings, keybindings, a theme
and the IDs it turns off. Installing it adds a layer under the user's own choices, and removing it
takes the layer away ([D26](../../../loop/decisions/m0-core.md)). Methods marked **destructive**
(removing a worktree, installing or uninstalling a plugin or distro) confirm through an ask unless
the call passes `yes` ([D20](../../../loop/decisions/m0-core.md)). The install confirmation lists
every contribution, and that card is the install screen
([D27](../../../loop/decisions/m0-core.md)). Quirky never updates plugin code by itself
([D28](../../../loop/decisions/m0-core.md)), and **safe mode** (`--disable-plugins`) runs stock
Quirky for one daemon run ([D29](../../../loop/decisions/m0-core.md)).

The kernel after this item is the PTY host connection, the transports and dispatcher, the plugin
host, scheduler and stores, the UI model and layout, settings and themes, notifications, the hook
endpoint, confirmations, request IDs, distros and the scripting surface. Every v1 feature is a
plugin.

## Data flow

**A CLI call.** The CLI reads `runtime.json`, connects to the socket it names, and sends
`client.hello` with the token, its cwd and any `QUIRKY_SESSION_ID` and `QUIRKY_WORKTREE_ID` from
its env. It routes the command line to a kernel command, a plugin's declared CLI command, or a
generated command, as m0-scripting set out. Each call gets a fresh request ID unless
`--retry-request` names one. If the connection drops before the reply, the CLI reconnects and
sends the same request again with the same ID, up to two more times.

**Dispatch.** The dispatcher finds the method and checks its params. For a destructive method it
then checks for `yes` or a usable confirmation, and otherwise starts a confirmation (below). For a
call with a request ID to a method not declared read-only, it looks the ID up first: a recorded
outcome is returned as is, a running one is waited for, and a new one runs and is recorded. A
plugin method's handler sees its caller: role, client name, cwd, session and worktree.

**Selectors.** A plugin method that takes a `repo` or `worktree` param resolves it through the
repo or worktree plugin's matcher, using the caller's cwd and identity for `current`.

**Confirmation.** The kernel creates a one-question confirm ask through `quirky.ask/create`, whose
text is the method's `confirm` text with the params filled in, and fails the call with
ConfirmationRequired naming the ask. The window shows the card. The CLI prints the action and the
ask ID to stderr, waits for the answer, and repeats the call with `confirmation` set to the ask ID.
The kernel runs it only if that ask was answered Yes, for the same method and params, and wasn't
used before.

**Layout.** The window reads the layout at connect and on each `ui.state.changed` event, and
renders the open view, panel and sidebar from it. Clicking a worktree in the sidebar calls
`ui.view.open` for the session view with that worktree as input. An agent calling the same method
changes what the window shows. A mounted slot's report goes to the daemon, which keeps the latest
per slot.

**A routed UI command.** `ui.command.run` checks the args, picks the target window and sends it the
command. The window runs it through its plugin host and replies with the result or error, which the
daemon returns to the caller.

**Sessions and agents.** `quirky.session/create` resolves the worktree, asks the kernel for the
launch environment, runs the launch hooks (among them agent-status's, which adds Claude's settings
file and Codex's notify argument), and spawns the PTY through `context.pty`. An agent hook POST
reaches the kernel's hook endpoint, which checks the hook token and delivers a `hook.received`
event to plugins. `quirky.agent-status` maps it to a status, sets it through
`quirky.session/setStatus`, and notifies through the kernel on done or waiting.

**Distro install.** `distro.inspect` reads the manifest and the plugins it bundles, with no code
run. `distro.install` confirms with that listing, copies the plugins into `<home>/plugins/`,
records the distro, and broadcasts `plugin.changed`, so the registry, UI model and CLI pick up the
change live. `distro.remove` reverses it.

## Key decisions

- **Real port, not facades** ([D31](../../../loop/decisions/m0-core.md)): feature code moves into
  the plugins, and the public context grows by the six members D11 lists.
- **Renamed wire names, protocol 2** ([D6](../../../loop/decisions/m0-core.md)): all clients are in
  this repo, so no aliases are kept.
- **Selectors resolve in the daemon** ([D10](../../../loop/decisions/m0-core.md)), so generated
  commands and API callers get them free.
- **Confirmations are a two-step call** ([D20](../../../loop/decisions/m0-core.md)): a person
  answering an ask is the gate, and `yes` is the explicit skip.
- **The layout lives in the daemon** ([D21](../../../loop/decisions/m0-core.md)); the window renders
  it, and slots report their own content.
- **Distros are an overlay** ([D26](../../../loop/decisions/m0-core.md)), so removing one restores
  everything it changed without bookkeeping.

## Behavior & scenarios

Fixtures are illustrative. Every scenario runs against a fresh temporary `QUIRKY_HOME`, with a real
`quirkyd`, the built-in plugins from `plugins/`, and a fake or real PTY host as each needs. Each is
driven through the `quirky` CLI or the daemon API, as it says. Repos are temporary git repositories.

Most scenarios use repo **api** at `/tmp/w/api` with worktrees **main** (branch `main`) and
**fix-login** (branch `fix-login`, at `/tmp/w/worktrees/api/fix-login`).

### CLI core

1. **SC-1: the CLI reaches the daemon over the unix socket** (CLI)
   - **Given** a running daemon
   - **When** the agent runs `quirky repo list`
   - **Then** the CLI connected through the socket named in `runtime.json`, and `status.get` lists the client with role `cli`. The socket file is mode 0600.
   - **Data before:** **runtime.json**: socket `<home>/quirkyd.sock`
   - **Walkthrough:**
     1. The CLI reads `runtime.json` and connects to the socket
     2. It sends `client.hello` with the token, then `quirky.repo/list`
   - **Data after:** **Output**: ✓ the repo table; **Socket**: ✓ mode 0600

2. **SC-2: a wrong token is refused** (API)
   - **Given** a running daemon
   - **When** a client connects to the socket and sends `client.hello` with a wrong token, or sends any other method first
   - **Then** the daemon answers Unauthorized and closes the connection, and no method runs

3. **SC-3: a long home puts the sockets in a short private directory** (CLI)
   - **Given** a `QUIRKY_HOME` whose `quirkyd.sock` path would be longer than 100 bytes
   - **When** the daemon starts and the agent runs `quirky status`
   - **Then** the daemon and PTY host sockets are under `/tmp/quirky-<uid>/` (a mode 0700 directory owned by the user), `runtime.json` names the daemon's, and the command works. Two such homes get different socket paths.

4. **SC-4: a stale socket file is replaced** (API)
   - **Given** a socket file left in place by a daemon that was killed
   - **When** a new daemon starts on the same home
   - **Then** it removes the stale file, listens on the same path, and the CLI connects

5. **SC-5: socket connections can't stream terminal output** (API)
   - **Given** a client connected over the socket
   - **When** it calls `quirky.terminal/attach`
   - **Then** the call fails with InvalidParams saying the method needs the WebSocket transport

6. **SC-6: `--version` works from a source checkout without the daemon** (CLI; Orca defect)
   - **Given** no daemon running, the CLI run from source with `bun packages/cli/src/main.ts`
   - **When** the agent runs `quirky --version`, `quirky -v` and `quirky --version --json`
   - **Then** the first two print `quirky <version>` from the CLI's package.json and exit 0, the third prints `{"version":"<version>"}`, and no daemon is started
   - **Data before:** **packages/cli/package.json**: version `0.1.0*`
   - **Walkthrough:**
     1. The agent runs `quirky --version`
   - **Data after:** **Output**: ✓ `quirky 0.1.0*`; **Daemon**: ✓ still not running

7. **SC-7: a worktree selector resolves by each form** (CLI, API)
   - **Given** repo **api** with worktrees **main** and **fix-login**, and the agent's cwd inside `/tmp/w/worktrees/api/fix-login/src`
   - **When** the agent runs `quirky git status --worktree <selector>` with each selector below
   - **Then** each resolves to the worktree shown
   - **Resolution:**

     | Selector | Resolves to |
     |---|---|
     | `id:<fix-login's id>` | fix-login |
     | `<fix-login's id>` (bare) | fix-login |
     | `name:main` | main |
     | `main` (bare, not an ID) | main, by name |
     | `branch:fix-login` | fix-login |
     | `path:/tmp/w/worktrees/api/fix-login/src` | fix-login (the worktree containing the path) |
     | `current` and `active` | fix-login (the cwd) |
     | no `--worktree` | fix-login (`current`) |

8. **SC-8: `current` prefers the session's worktree over the cwd** (CLI)
   - **Given** a terminal session in worktree **main** whose env has `QUIRKY_WORKTREE_ID` set to main's ID, and the shell's cwd moved into fix-login
   - **When** the agent runs `quirky git status` there
   - **Then** it reports **main**

9. **SC-9: no match and several matches** (CLI, API)
   - **Given** repos **api** and **web**, each with a worktree named **main**
   - **When** the agent runs `quirky git status --worktree name:nope --json`, then `quirky git status --worktree main --json`
   - **Then** the first fails with code `not-found`, exit 1, and a message naming `name:nope` and the selector forms; the second fails with code `conflict`, exit 1, and lists both matches as `id:<id>` selectors
   - **Data after:** **Output 1**: ✗ `no worktree matches name:nope; use id:, name:, branch:, path: or current`; **Output 2**: ✗ `main matches 2 worktrees: id:<api main>, id:<web main>`

10. **SC-10: repo selectors** (CLI)
    - **Given** repo **api** at `/tmp/w/api`
    - **When** the agent runs `quirky wt create name:api feature-x`, `quirky wt create path:/tmp/w/api feature-y` and `quirky wt create <api's id> feature-z`
    - **Then** all three create worktrees in **api**; `quirky wt create name:nope x` fails with `not-found` and exit 1

11. **SC-11: a retried call returns the first outcome** (API)
    - **Given** a client
    - **When** it calls `quirky.worktree/create` for `feature-x` with request ID `r-1`, then calls it again with `r-1` and the same params
    - **Then** both return the same worktree, only one worktree and branch exist, and `quirky.worktree/changed` was emitted once
    - **Data before:** **Worktrees**: main, fix-login
    - **Walkthrough:**
      1. Call 1 with `r-1` creates feature-x and is recorded
      2. Call 2 with `r-1` finds the record and returns it without running
    - **Data after:** **Worktrees**: ✓ main, fix-login, feature-x (once); **Call 2**: ✓ same result as call 1

12. **SC-12: a reused request ID with different params is refused** (API)
    - **Given** request ID `r-1` already used for creating `feature-x`
    - **When** a client calls `quirky.worktree/create` for `feature-y` with `r-1`
    - **Then** it fails with Conflict "request ID reused with different params" and creates nothing

13. **SC-13: a retry while the first call still runs waits for it** (API)
    - **Given** a plugin method that takes a second to finish
    - **When** two connections send it with the same request ID and params at once
    - **Then** the handler runs once, and both get the same result

14. **SC-14: read-only calls are not recorded, and records survive a restart** (API)
    - **Given** request ID `r-2` used for `quirky.repo/list` and `r-3` for `quirky.repo/add`
    - **When** the daemon restarts and a client repeats both
    - **Then** the `r-2` repeat runs again (read-only methods are never recorded), and the `r-3` repeat returns the recorded repo without adding again. A record older than 24 hours is gone, and its ID can be used afresh.

15. **SC-15: the CLI retries a lost reply with the same request ID** (CLI)
    - **Given** a daemon that drops the connection after running the first `quirky.repo/add` call but before replying
    - **When** the agent runs `quirky repo add /tmp/w/web`
    - **Then** the CLI reconnects, repeats the call with the same ID, prints the repo, exits 0, and exactly one repo **web** exists. If all three attempts lose the connection, the CLI exits 1 and the error names the request ID and `--retry-request`.

16. **SC-16: `--retry-request` reissues a command with a given ID** (CLI)
    - **Given** a `quirky wt create api feature-x` whose reply was lost, with request ID `r-9`
    - **When** the agent runs `quirky wt create api feature-x --retry-request r-9`
    - **Then** it prints the worktree created the first time and creates nothing new

### v1 as built-in plugins

17. **SC-17: the eight built-ins are plugins with namespaced methods and CLI groups** (CLI, API)
    - **Given** a fresh home
    - **When** the agent runs `quirky plugin list --json` and `quirky api --json`
    - **Then** the eight plugins of the table above are listed as built-ins with their dependencies; the catalog lists their methods under `quirky.<feature>/` names with schemas, their CLI commands (with `wt` and `term` aliases) and their events; and none of v1's old names (`repo.list`, `session.create`, `git.status`, `ask.create`, `settings.get` and the rest) exists. Calling an old name is MethodNotFound.

18. **SC-18: renamed methods** (API)
    - **Given** a fresh home
    - **When** a client calls each new name below
    - **Then** each behaves as its v1 method did, with `repo` and `worktree` params taking selectors
    - **Method names:**

      | v1 | Now |
      |---|---|
      | `repo.list`, `repo.add`, `repo.remove` | `quirky.repo/list`, `/add`, `/remove`; new `/resolve` |
      | `worktree.list`, `worktree.create`, `worktree.remove` | `quirky.worktree/list`, `/create`, `/remove`; new `/resolve` |
      | `session.list`, `session.create`, `session.close` | `quirky.session/list`, `/create`, `/close`; new `/get`, `/setStatus` |
      | `session.createStructured`, `structured.messages`, `structured.send` | `quirky.structured/create`, `/messages`, `/send` |
      | `terminal.attach`, `detach`, `write`, `resize`, `send`, `read` | `quirky.terminal/attach`, `/detach`, `/write`, `/resize`, `/send`, `/read` |
      | `git.status`, `diff`, `stage`, `unstage`, `commit` | `quirky.git/status`, `/diff`, `/stage`, `/unstage`, `/commit` |
      | `ask.create`, `wait`, `answer`, `cancel`, `list` | `quirky.ask/create`, `/wait`, `/answer`, `/cancel`, `/list` |
      | (none) | `quirky.agent-status/list` |
      | `settings.get`, `settings.set` | removed; `setting.*` with the plugin settings of SC-25 |

19. **SC-19: an old client is told the protocol changed** (API)
    - **Given** a running daemon
    - **When** a client sends `client.hello` with protocol version 1
    - **Then** it fails with Conflict naming versions 2 and 1

20. **SC-20: v1's CLI commands behave as they do today** (CLI)
    - **Given** a fresh home and repo **api**
    - **When** the agent runs v1's commands: `repo add`, `repo list`, `wt create api feature-x --base main`, `wt list --repo api`, `session new --agent shell`, `session list`, `term send <id> "echo hi" --enter`, `term read <id> --lines 5`, `session close <id>`, `wt rm feature-x --yes`, `repo rm api`
    - **Then** each succeeds with v1's text output (tables and records) and `--json` output, and positionals are where v1 had them. Repo and worktree positionals and flags take selectors, and v1's plain IDs still work. `quirky worktree list` and `quirky terminal read` are the same commands as `wt list` and `term read`.

21. **SC-21: session and terminal commands default from the session's env** (CLI)
    - **Given** a shell session in worktree **main**, with `QUIRKY_SESSION_ID` and `QUIRKY_WORKTREE_ID` in its env
    - **When** the agent runs `quirky term read --lines 3` and `quirky session new --agent shell` inside it
    - **Then** the first reads that session, and the second starts a shell in **main**

22. **SC-22: sessions run under the login shell with the launch environment** (API)
    - **Given** an installed launch-hook plugin that adds `FOO=1`, and a fake PTY host recording spawns
    - **When** a client creates a Claude session in **main** with prompt "hi"
    - **Then** the spawn runs `$SHELL -l -c 'exec claude --settings <agent-status's settings file> hi'` in main's path, its env has `QUIRKY_HOME`, `QUIRKY_SESSION_ID`, `QUIRKY_WORKTREE_ID`, `QUIRKY_HOOK_URL`, `QUIRKY_HOOK_TOKEN`, Quirky's `bin` first on `PATH`, and `FOO=1`; a Codex session gets `-c 'notify=[...]'`
    - **Data before:** **Launch hooks**: agent-status (Claude settings, Codex notify), acme `FOO=1*`
    - **Walkthrough:**
      1. `quirky.session/create` asks the kernel for the launch environment
      2. It runs the launch hooks in ID order
      3. It spawns through `context.pty`
    - **Data after:** **Spawn**: ✓ argv with `--settings`; ✓ env with the kernel's `QUIRKY_*`, `PATH` and `FOO=1*`

23. **SC-23: agent hooks drive status and notifications** (API)
    - **Given** a Claude session in **main**, and no desktop client connected
    - **When** the hook script POSTs `UserPromptSubmit`, then `Notification`, then `Stop`
    - **Then** the session goes working, waiting, done; `quirky.session/changed` is emitted each time; waiting and done each emit `notify` titled with the worktree name ("Claude needs input", "Claude finished") and show an osascript notification. With `setting:quirky.agent-status/notifications` false, the `notify` event still reaches the window as a toast, but no OS notification is shown, as in v1. A POST with a wrong hook token is refused with 401 and changes nothing.

24. **SC-24: plugin code uses only the public API** (API)
    - **Given** the built-in plugins' source
    - **When** the test suite scans each plugin directory's imports
    - **Then** no plugin imports from `packages/daemon`, and each imports only `@quirky/protocol`, its own files, the runtime (Bun and Node built-ins) and third-party packages. Everything else it uses comes through its context.

25. **SC-25: v1's settings are plugin settings** (CLI)
    - **Given** a fresh home
    - **When** the agent runs `quirky setting list`, then `quirky setting set quirky.terminal/scrollback 5000`
    - **Then** the list has `quirky.worktree/worktreesRoot` (default `~/quirky/workspaces`, with `~` expanded when read, as v1 does), `quirky.terminal/scrollback` (default 2000, 500 to 10000) and `quirky.agent-status/notifications` (default true); the set succeeds; a value of 100 is refused with InvalidParams

26. **SC-26: a v1 home's data carries over** (API)
    - **Given** a home written by v1: repo **api**, a running shell session in **main**, one pending ask, `terminalScrollback` 4000
    - **When** this build's daemon starts on it
    - **Then** `quirky.repo/list` has **api**, `quirky.session/list` has the session (still attachable, since the PTY host kept it), `quirky.ask/list` has the pending ask, and `quirky.terminal/scrollback` reads 4000. A second start copies nothing again.

27. **SC-27: disabling a built-in takes its dependents and their surfaces with it** (CLI)
    - **Given** a fresh home with a session running
    - **When** the agent runs `quirky plugin disable quirky.session`
    - **Then** `quirky.session`, `quirky.terminal`, `quirky.agent-status` and `quirky.structured` are disabled; their methods are MethodNotFound; `quirky session list` and `quirky term read` are unknown commands with suggestions; the session view leaves `ui.state`, which shows the main area empty; the PTY session keeps running. `quirky plugin enable quirky.session` brings them back, and the session is listed again.

28. **SC-28: asks keep v1's CLI shape** (CLI)
    - **Given** the window is connected
    - **When** an agent runs `quirky ask --spec '<one select question>'`, and the person answers in the Questions panel
    - **Then** the CLI prints `{"status":"registered","askId":"ask_..."}`, then the answered envelope as one JSON line, and exits 0. `quirky ask wait --id <id>` on the answered ask prints the same envelope at once, and `quirky ask cancel --id <id>` on a pending ask prints `declined`. A partial answer (one question skipped) prints `partial`.

29. **SC-29: a second pending ask is shown and resolves** (API; Orca defect)
    - **Given** two asks registered from the same session, **Ask 1** then **Ask 2**
    - **When** the person answers Ask 1
    - **Then** `quirky.ask/list` still has Ask 2 pending, the Questions panel's reported state lists Ask 2, and answering Ask 2 resolves the `quirky ask` process waiting on it
    - **Data before:** **Ask 1**: pending; **Ask 2**: pending
    - **Walkthrough:**
      1. The person answers Ask 1
      2. `quirky.ask/resolved` is emitted for Ask 1 only
      3. The panel reports `pending: [Ask 2]`
      4. The person answers Ask 2
    - **Data after:** **Ask 1**: ✓ answered; **Ask 2**: ✓ answered, its waiter printed the envelope

30. **SC-30: a pending ask survives a daemon restart** (CLI)
    - **Given** a pending ask with a `quirky ask wait` running
    - **When** the daemon restarts
    - **Then** the wait reconnects and keeps waiting, the panel shows the ask again, and answering it resolves the wait

31. **SC-31: the Questions panel opens itself** (API)
    - **Given** the window is connected with no panel open
    - **When** an agent creates an ask
    - **Then** `ui.state` shows `panel:quirky.ask/questions` open, and a `notify` event announces the ask. With another panel already open, the panel stays as it is, and the panel toggle shows a pending count.

32. **SC-32: structured sessions run as a plugin** (API)
    - **Given** a fake Claude runner
    - **When** a client calls `quirky.structured/create` in **main** with prompt "fix it", the runner asks permission for a tool, and the person answers allow
    - **Then** a session of kind `structured` is listed by `quirky.session/list`, every runner message is journaled and emitted as `quirky.structured/message`, the permission request is an ask with allow, deny and always-allow options, the status goes working then done, and `quirky.structured/send` adds a user turn. `quirky session new --agent claude --prompt "fix it" --background` does the same from the CLI.

33. **SC-33: source control runs as a plugin** (CLI)
    - **Given** worktree **main** with one modified file
    - **When** the agent runs `quirky git status`, `quirky git stage --paths a.txt`, `quirky git commit --message "edit"`
    - **Then** the status lists the file unstaged, then staged, and the commit prints its sha; `quirky.git/changed` is emitted after stage and commit

34. **SC-34: agent status is listed through its own group** (CLI)
    - **Given** two Claude sessions, one working and one done
    - **When** the agent runs `quirky agent-status list --json`
    - **Then** it lists both sessions with their status and the time of their last hook

### UI bridge

35. **SC-35: `quirky ui state` returns the layout and what each slot shows** (CLI)
    - **Given** the window is connected, worktree **main** is selected and its shell session is the active tab
    - **When** the agent runs `quirky ui state --json`
    - **Then** it shows one window connected; the open view `view:quirky.session/worktree` with input naming main and the session; no panel open; the sidebar shown; focus on the view; the sidebar section `sidebar-section:quirky.worktree/worktrees` reporting repos and worktrees with status; and the session view reporting its tabs and the active one
    - **Data before:** **Window**: connected; **Layout**: view session view (main, shell 1)
    - **Walkthrough:**
      1. The agent runs `quirky ui state --json`
    - **Data after:** **Output**: ✓ windows 1; ✓ view `view:quirky.session/worktree`, input `{worktree: main's id, session: shell 1's id}`; ✓ panel none; ✓ sidebar shown; ✓ focus view; ✓ slot reports for the sidebar and the session view

36. **SC-36: an agent changes the view, and the window follows** (CLI)
    - **Given** the window is connected showing worktree **main**
    - **When** the agent runs `quirky ui open-view view:quirky.session/worktree --input '{"worktree":"fix-login"}'`, then `quirky ui open-panel panel:quirky.git/source-control`, then `quirky ui focus panel`
    - **Then** after each, `quirky ui state` shows the change, the window's session view shows fix-login with its sidebar row selected, the source-control panel is open for fix-login, and focus is on the panel. `quirky ui close-panel` closes it.

37. **SC-37: a person's clicks change the daemon's layout** (API)
    - **Given** the window is connected
    - **When** the person clicks worktree **fix-login** in the sidebar and then a session tab
    - **Then** `ui.state` shows the session view with fix-login and that session as input, and `ui.state.changed` was broadcast for each click

38. **SC-38: the layout survives a restart** (API)
    - **Given** the session view open on **fix-login** with the source-control panel open
    - **When** the daemon restarts and the window reconnects
    - **Then** the window shows the same view, input and panel. A layout naming a contribution that is no longer in effect drops that part and shows the main area empty or no panel.

39. **SC-39: layout methods refuse unknown targets** (API)
    - **Given** a running daemon
    - **When** a client opens view `view:acme.x/missing`, opens a sidebar section as a panel, or focuses `nowhere`
    - **Then** each fails: NotFound for the unknown view, InvalidParams for the wrong kind and for the unknown focus target, and the layout is unchanged

40. **SC-40: a plugin UI command runs in the window** (CLI)
    - **Given** an installed plugin with UI command `command:acme.tools/greet` whose args are `{ name: string }`, required, and whose code returns `"hello <name>"`
    - **When** the agent runs `quirky ui run command:acme.tools/greet --args '{"name":"zed"}'`
    - **Then** the window runs it and the CLI prints `hello zed`. Args `{}` fail with InvalidParams before reaching the window. A command whose code throws fails with the thrown message.

41. **SC-41: a UI command with no window, or with two** (API)
    - **Given** no window connected
    - **When** a client calls `ui.command.run`
    - **Then** it fails with Conflict "no Quirky window is open"; with two windows connected, the command runs in the one that last reported focus, once

42. **SC-42: a slot's report is replaced, capped and cleared** (API)
    - **Given** a mounted plugin panel
    - **When** it reports twice, then reports 100 KiB, then unmounts
    - **Then** `ui.state` shows the second report, then the report refused as too large (the previous one stays and the panel's plugin gets a warning), then no report

### Confirmations

43. **SC-43: removing a worktree asks first** (CLI)
    - **Given** the window is connected and worktree **feature-x** exists
    - **When** the agent runs `quirky wt rm feature-x`
    - **Then** the CLI prints to stderr `confirm in Quirky: Remove worktree feature-x? (ask ask_...); or rerun with --yes`, the Questions panel shows the confirm card, and (a) on Yes the worktree is removed and the CLI prints `removed <id>` and exits 0; (b) on No it is kept and the CLI exits 1 with `declined`
    - **Data before:** **Worktrees**: main, feature-x
    - **Walkthrough:**
      1. The CLI calls `quirky.worktree/remove` without `yes`
      2. The kernel creates the confirm ask and fails the call with ConfirmationRequired
      3. The CLI waits on the ask
      4. The person answers (a) Yes; (b) No
      5. (a) The CLI calls again with the confirmation; (b) the CLI stops
    - **Data after:** **Worktrees**: (a) ✓ main; (b) ✓ main, feature-x; **Exit**: (a) 0; (b) ✗ 1, `declined`

44. **SC-44: `--yes` skips the confirmation** (CLI)
    - **Given** worktree **feature-x**
    - **When** the agent runs `quirky wt rm feature-x --yes`
    - **Then** it is removed at once, and no ask is created

45. **SC-45: a confirmation can't be reused or moved to other params** (API)
    - **Given** a confirm ask answered Yes for removing **feature-x**
    - **When** a client calls `quirky.worktree/remove` for **fix-login** with that confirmation, and then for **feature-x** twice
    - **Then** the fix-login call fails with Conflict naming the mismatch; the first feature-x call runs; the second fails with Conflict "confirmation already used"

46. **SC-46: with asks switched off, a destructive call says to pass yes** (CLI)
    - **Given** `quirky.ask` disabled
    - **When** the agent runs `quirky wt rm feature-x`
    - **Then** it fails with exit 1 and a message saying the action needs confirmation and asks are off, so pass `--yes`

47. **SC-47: the window's own confirm dialog passes yes** (API)
    - **Given** the window is connected
    - **When** the person removes a worktree from the sidebar and confirms the dialog
    - **Then** the window calls `quirky.worktree/remove` with `yes`, and no ask card appears

48. **SC-48: plugins declare destructive methods** (API)
    - **Given** an installed plugin whose method `wipe` declares `destructive: true` and `confirm: "Wipe {target}?"`
    - **When** a client calls it with `{ target: "cache" }` and no `yes`
    - **Then** the confirm ask's question reads "Wipe cache?", and the call fails with ConfirmationRequired. `quirky api --json` shows the method as destructive, and its generated CLI command accepts `--yes`.

### Plugins, distros and safety

49. **SC-49: inspecting a plugin lists its contributions without running it** (CLI)
    - **Given** a plugin directory `acme.tools` with a method, a panel, a keybinding and an override of `panel:quirky.git/source-control`, whose `main` would write a marker file when loaded
    - **When** the agent runs `quirky plugin inspect ./acme.tools`
    - **Then** it prints the ID, name, version and every contribution by kind and full ID, marking the override and naming what it replaces; no marker file exists
    - **Install screen:**

      ```
      acme.tools 1.0.0 (Acme tools)
      method     method:acme.tools/greet
      panel      panel:acme.tools/notes
      keybinding keybinding:acme.tools/open  mod+shift+n
      override   panel:quirky.git/source-control (replaces quirky.git's)
      ```

50. **SC-50: installing a plugin confirms with that listing** (CLI)
    - **Given** the window is connected
    - **When** the agent runs `quirky plugin install ./acme.tools`
    - **Then** the CLI prints the listing, the confirm card's question carries the same listing, and on Yes the plugin is copied to `<home>/plugins/acme.tools`, appears in `quirky plugin list`, and its contributions take effect without a restart. With `--yes` it installs at once.

51. **SC-51: reinstalling shows what changed** (CLI)
    - **Given** `acme.tools` 1.0.0 installed
    - **When** the agent runs `quirky plugin install ./acme.tools` with version 1.1.0, which adds a method
    - **Then** the confirmation says `acme.tools 1.0.0 → 1.1.0` and lists the added method, and nothing changes until it is answered Yes

52. **SC-52: Quirky never changes installed plugin code by itself** (API)
    - **Given** `acme.tools` installed from `./acme.tools`
    - **When** the source directory's code changes and the daemon restarts
    - **Then** the installed copy and the running code are unchanged, and nothing in the daemon reads the source directory again

53. **SC-53: uninstalling removes the plugin and its data** (CLI)
    - **Given** `acme.tools` installed with data in `<home>/plugin-data/acme.tools`
    - **When** the agent runs `quirky plugin uninstall acme.tools --yes`
    - **Then** the plugin directory and its data are gone, its contributions leave the registry live, and uninstalling a built-in fails with InvalidParams saying built-ins can be disabled but not removed

54. **SC-54: installing a distro applies its layer** (CLI)
    - **Given** a distro **night** with plugin `night.extras` (a theme `dusk` and a panel), `disable: ["quirky.git"]`, `settings: {"quirky.terminal/scrollback": 6000}`, `theme: "theme:night.extras/dusk"` and `keybindings: {"mod+shift+p": "command:night.extras/palette"}`
    - **When** the agent runs `quirky distro install ./night --yes`
    - **Then** `night.extras` is installed, `quirky.git` is disabled (by the distro), scrollback reads 6000, the active theme is dusk, mod+shift+p runs the distro's command over any built-in binding, and `quirky distro list` shows **night**
    - **Data before:** **Settings**: scrollback 2000 (default); **Theme**: default; **quirky.git**: on
    - **Walkthrough:**
      1. The agent installs **night** with `--yes`
      2. The kernel copies `night.extras` and records the distro's layer
    - **Data after:** **Settings**: ✓ scrollback 6000 (from night); **Theme**: ✓ dusk (from night); **quirky.git**: ✓ off (by night); **Distros**: ✓ night

55. **SC-55: the user's own choices win over the distro, and removing it restores the rest** (CLI)
    - **Given** distro **night** installed as in SC-54
    - **When** the agent runs `quirky setting set quirky.terminal/scrollback 8000`, then `quirky distro remove night --yes`
    - **Then** while night is installed scrollback reads 8000; after removal scrollback still reads 8000 (the user's), the theme is the default again, `quirky.git` is on again, `night.extras` and its data are gone, and the keybinding is the built-in one again
    - **Data before:** **Settings**: scrollback 6000 (from night); **Theme**: dusk (from night)
    - **Walkthrough:**
      1. The user sets scrollback 8000
      2. The agent removes night
    - **Data after:** **Settings**: ✓ scrollback 8000 (the user's); **Theme**: ✓ default; **quirky.git**: ✓ on; **night.extras**: ✓ gone

56. **SC-56: distro install refusals** (CLI)
    - **Given** distro **night** installed
    - **When** the agent installs another distro **day**; or installs a distro whose plugin ID is already installed on its own; or a distro whose manifest is malformed or names a setting value its declaration refuses
    - **Then** each fails, with Conflict for the first two and InvalidParams naming each problem for the third, and changes nothing

57. **SC-57: distro inspect lists everything it would change** (CLI)
    - **Given** distro **night**
    - **When** the agent runs `quirky distro inspect ./night`
    - **Then** it prints each plugin with its contributions (as in SC-49), the IDs it turns off, each setting with its current and new value, the theme and the keybindings, and installs nothing. The install confirmation carries the same listing.

58. **SC-58: safe mode runs stock Quirky for one run** (CLI)
    - **Given** distro **night** installed, `acme.tools` installed, and the user has disabled `quirky.structured`
    - **When** the agent runs `quirky daemon restart --disable-plugins`, then `quirky status --json` and `quirky plugin list --json`
    - **Then** status shows `safeMode: true`; every built-in is active or lazy and in effect, including `quirky.structured` and `quirky.git`; `night.extras` and `acme.tools` are listed as disabled with reason "safe mode"; settings and theme read without the distro's layer. Sessions are still listed and attachable. `quirky daemon restart` without the flag brings everything back as it was, and nothing was written by the safe-mode run.

### Exit test

59. **SC-59: the M0 exit test, through the CLI only** (CLI)
    - **Given** a fresh home with repo **api**, a shell session in **main**, and the window connected
    - **When** an agent runs, only through `quirky`: `distro install distros/sample --yes`, `ui state --json`, `git status`, then `distro remove sample --yes` and `ui state --json`
    - **Then** after install, `ui state` shows the sidebar section `sidebar-section:quirky.worktree/worktrees` owned by `sample.sidebar` and reporting its flat worktree list, no source-control panel in the panel list, and `quirky git status` is an unknown command; after removal, `ui state` shows the stock sidebar from `quirky.worktree`, the source-control panel is available, and `quirky git status` works. The session kept running throughout.
    - **Data before:** **Sidebar**: quirky.worktree's; **quirky.git**: on
    - **Walkthrough:**
      1. The agent installs the sample distro
      2. `ui state` shows sample.sidebar's sidebar and no source control
      3. The agent removes the distro
      4. `ui state` shows the stock sidebar and source control
    - **Data after:** **Sidebar**: ✓ quirky.worktree's again; **quirky.git**: ✓ on; **Session**: ✓ still running

60. **SC-60: v1 behaves as it does today** (CLI, API)
    - **Given** the v1 scenarios the existing test suite drives (repos, worktrees, sessions, terminals, hooks, git, asks, structured sessions, the desktop shell's badge and notifications)
    - **When** they run against the built-ins under the new names
    - **Then** each passes with the same observable results, apart from the renames, the selectors, the confirmation on `wt rm` without `--yes`, and ask cards moving into the Questions panel

## Scope & non-goals

In scope: the four parts above and the flows of cli.md and ask.md that
[D32](../../../loop/decisions/m0-core.md) lists. Out of scope:

- **From cli.md:** remote runtimes (`--environment`, `--pairing-code`, `--host`), `serve`, saved
  environments, `agent-context` (`quirky api --json` covers it), the command groups of M1 and later
  features, the installed shell command card in Settings, Windows named pipes and WSL path mapping
  (logged as `deferred: platform`).
- **From ask.md (M2's ask parity):** number and date questions, defaults, timeouts that fall back
  to defaults and drafts, credential refusal, draft persistence, option previews, hand-off to an
  orchestration coordinator, pane liveness, the wait concurrency cap, the 3-minute notification,
  Claude's AskUserQuestion suppression flags, and a fresh sequence number for a queued ask (SC-29
  covers the observable defect).
- **Layout beyond one view and one panel:** tabs as a kernel model, splits and tab groups (M1's
  terminal panes).
- **Several distros at once**, a distro registry or download, and plugin signing.
- **A safe-mode switch in the desktop shell**: the CLI's `daemon restart --disable-plugins` is the
  way in.

## Decisions Locked

**Organization**
- Eight built-in plugins, one per v1 feature ([D5](../../../loop/decisions/m0-core.md)).
- Wire names renamed to the plugin namespace, protocol 2, no aliases ([D6](../../../loop/decisions/m0-core.md)); events too ([D7](../../../loop/decisions/m0-core.md)).
- v1's CLI words kept, with `wt` and `term` as `cliAliases` ([D8](../../../loop/decisions/m0-core.md)).
- v1's settings become plugin settings ([D13](../../../loop/decisions/m0-core.md)); v1 data carries over ([D14](../../../loop/decisions/m0-core.md)).
- A disabled built-in cascades to its dependents ([D15](../../../loop/decisions/m0-core.md)).

**API**
- Six new public context members ([D11](../../../loop/decisions/m0-core.md)); notifications as a kernel service ([D12](../../../loop/decisions/m0-core.md)).
- Request IDs with recorded outcomes for 24 hours ([D19](../../../loop/decisions/m0-core.md)).
- Two-step confirmations through an ask, `yes` to skip ([D20](../../../loop/decisions/m0-core.md)).

**CLI**
- Plugin CLI commands as `cli-command` contributions with an optional CLI module ([D9](../../../loop/decisions/m0-core.md)).
- Selectors resolved in the daemon ([D10](../../../loop/decisions/m0-core.md)).
- The unix socket with the token in `client.hello` ([D16](../../../loop/decisions/m0-core.md)), and the short-path rule for both sockets ([D17](../../../loop/decisions/m0-core.md)).
- `--version` offline from the CLI's package.json ([D18](../../../loop/decisions/m0-core.md)).
- v1's text output and exit codes kept ([D34](../../../loop/decisions/m0-core.md)).

**Visual**
- The daemon owns layout, focus and the visible view ([D21](../../../loop/decisions/m0-core.md)); slots report their content ([D22](../../../loop/decisions/m0-core.md)); UI commands route to one window ([D23](../../../loop/decisions/m0-core.md)).
- v1's surfaces become the built-ins' contributions ([D24](../../../loop/decisions/m0-core.md)); ask cards move into a Questions panel ([D25](../../../loop/decisions/m0-core.md)).

**Distros and safety**
- Distros as an overlay, one at a time ([D26](../../../loop/decisions/m0-core.md)); install lists contributions and confirms ([D27](../../../loop/decisions/m0-core.md)); no updater ([D28](../../../loop/decisions/m0-core.md)); launch-scoped safe mode ([D29](../../../loop/decisions/m0-core.md)); the sample distro ([D30](../../../loop/decisions/m0-core.md)).

## Industry Insights

- Revert by removing an overlay, not by restoring copied values: VS Code profiles fall back to the
  default for anything they omit, and LazyVim disables a default with `enabled = false` in the
  user's spec ([profiles](https://code.visualstudio.com/docs/configure/profiles),
  [LazyVim](https://www.lazyvim.org/configuration/plugins)).
- Safe mode should be launch-scoped and write no state, as `code --disable-extensions` is
  ([VS Code CLI](https://code.visualstudio.com/docs/configure/command-line)).
- Automatic extension updates are a supply-chain path: the May 2026 Nx Console compromise reached
  users within an 11-minute window through VS Code's auto-update
  ([StepSecurity](https://www.stepsecurity.io/blog/nx-console-vs-code-extension-compromised),
  [CISA](https://www.cisa.gov/news-events/alerts/2026/05/28/supply-chain-compromises-impact-nx-console-and-github-repositories)).
- Consent should show what is being granted, and an update that adds capabilities should prompt
  again ([Chrome permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)).
- Idempotency keys: store the first response, reject reuse with different parameters, prune after
  24 hours ([Stripe](https://docs.stripe.com/api/idempotent_requests)).
- Agents in a PTY can answer a TTY prompt themselves, so `--yes` and a TTY check aren't a real gate;
  fail closed and name the flag ([git_flash #42](https://github.com/Kleanthismits/git_flash/issues/42),
  [langstar #739](https://github.com/codekiln/langstar/pull/739)).
- macOS `sun_path` holds 104 bytes, and a long path fails with a misleading error, so sockets need a
  short directory ([kontroll #27](https://github.com/zsa/kontroll/issues/27),
  [workmux #293](https://github.com/raine/workmux/issues/293)).
- Privileged-only APIs for built-ins leave third parties unable to match or replace them (VS Code
  proposed APIs, Firefox experiments, Chrome component extensions)
  ([VS Code](https://code.visualstudio.com/api/advanced-topics/using-proposed-api),
  [Firefox](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/basics.html)).
- A daemon that owns sessions and layout, with the GUI as a thin client, is the pattern Contour's
  control API follows ([Contour #2176](https://github.com/contour-terminal/contour/pull/2176)).

## Deferred Ideas

- `[tech-spec]` Whether the daemon bundles built-in plugins' UI modules on request or a build step
  writes them.
- `[tech-spec]` Where request records and the layout are stored, and how the 24-hour pruning runs.
- `[tech-spec]` How a routed UI command's reply travels back from the window.
- `[tech-spec]` How the distro layer plugs into settings, themes, keybindings and the disabled set.
- Several distros layered at once ([D26](../../../loop/decisions/m0-core.md) revisit).
- A desktop-shell switch for safe mode.

## Glossary

- **Built-in plugin:** a plugin shipped in `plugins/`, with an ID starting `quirky.`; it can be
  disabled but not uninstalled.
- **Selector:** a string naming a repo or worktree by ID, name, branch, path or `current`.
- **Caller:** who invoked a method: the client's role and name, and for a CLI its cwd and session
  identity.
- **Request ID:** a client-chosen string on a call; a repeat with the same ID gets the first outcome.
- **Destructive method:** one declared `destructive`, which runs only with `yes` or a confirmation.
- **Confirmation:** a confirm ask answered Yes for one call's method and params, used once.
- **Layout:** the daemon's record of the open view and its input, the open panel, whether the
  sidebar shows, and focus.
- **Slot report:** the JSON a mounted slot sends to describe what it shows.
- **Distro:** a manifest of plugins, settings, keybindings, a theme and IDs to turn off, installed
  as a removable layer.
- **Safe mode:** a daemon run with only built-ins and no stored disables or distro layer.
