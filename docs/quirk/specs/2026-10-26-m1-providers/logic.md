# Agent launch for all 45 CLIs: data table, detection, resume, permission modes, paste-after-ready

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m1-providers.md](../../../loop/decisions/m1-providers.md)). Tech spec: requested.

**Amendments:**
- 2026-10-26, tech-spec authoring: Claude Agent Teams launches `claude --teammate-mode in-process` with the Agent Teams environment directly, with no `quirky agents claude-teams` command, because plugin CLI commands can't pass arbitrary arguments through (SC-6, SC-37, [D29](../../../loop/decisions/m1-providers.md)). The "New <Agent> tab" commands are declared for the 45 built-in agents only, because UI commands must be declared in a manifest (SC-43, [D33](../../../loop/decisions/m1-providers.md)). `quirky agents list` returns an object holding the agent array, the default agent and the permission summary (SC-1). Resume has no `--wait`, since it carries no prompt (SC-31). A delivery still `pending` when the daemon restarts becomes `not-delivered` (SC-28).
- 2026-10-26, Codex spec review: an agent found only in an install directory launches by its absolute path ([D43](../../../loop/decisions/m1-providers.md)); the provider-session method is `quirky.session/setProviderSession` (CLI `set-provider-session`); counts and pickers include Claude Agent Teams whenever Claude is installed (SC-1, SC-39, SC-41, SC-43); a resumed session records the launch it used (SC-31).
- 2026-10-29, QA runtime smoke: explicit agent commands appear only for installed and enabled catalog agents; disabling removes an entry, and re-enabling restores it in an open palette without reloading. The generic default-agent command remains available (SC-41, SC-43).

## Conceptual model

Quirky v1 can start four agent CLIs, from a five-line switch in `quirky.session`. Orca starts 45,
and the user runs several of the others every day. This item brings Quirky to Orca's agent launch
([providers.md](../../../../research/orca-features/providers.md)): every CLI Orca knows, detected on
the machine, started with the user's saved command, arguments and environment, given its first
prompt the way that CLI accepts it, and resumed later from its provider session.

**The catalog is data.** Each agent is an `agent` contribution in a plugin manifest
([D6](../../../loop/decisions/m1-providers.md)). The new built-in plugin `quirky.agents` declares
Orca's 45, with Orca's IDs, labels and values ([D9](../../../loop/decisions/m1-providers.md)). An
entry says:

- which commands on `PATH` mean it is installed (a detect command, aliases, and commands it also
  requires);
- the command that starts it, and the process name it runs as;
- how its first prompt is delivered (one of six modes, below), with an optional `--` separator and
  an optional native draft flag;
- how to resume and fork a provider session, if it can;
- its Yolo and Auto permission flags, and any default environment;
- for prompts pasted after start: the ready signal to wait for, the deadline, and per-agent Enter
  timing;
- which workspace-trust record to pre-write, and its homepage and install links.

Behavior that data can't express is code in `quirky.agents`, chosen by a name in the entry (a
ready-signal scanner, the Claude resume splice, the Hermes query wrapper). Any plugin can add an
agent with its own `agent` contribution, replace a built-in one through `overrides`, or remove one
through `disables`, using the kernel's existing rules.

**Configuration is the user's.** For each agent the user can switch it off, replace its command,
set its arguments and set its environment. Two settings apply to all agents: the default agent and
workspace trust. A permission mode (Manual, Auto, Yolo) is a shorthand that writes an agent's
arguments, and applies to all agents at once or to one
([D14](../../../loop/decisions/m1-providers.md), [D17](../../../loop/decisions/m1-providers.md)).

**Launch is planned, then spawned.** `quirky.session` still owns session records and spawning. To
start an agent it asks `quirky.agents` for a launch plan: the command string, the environment, and
any prompt left to paste after start. It spawns the command under the user's login shell, as v1
does ([D11](../../../loop/decisions/m1-providers.md)), and records what the launch used so a later
resume replays exactly that ([D24](../../../loop/decisions/m1-providers.md)).

**The first prompt.** The six delivery modes are Orca's ([D20](../../../loop/decisions/m1-providers.md)):

| Mode | The prompt goes | Agents |
|---|---|---|
| `argv` | on the command line, after `--` where the entry says | claude, openclaude, codebuddy, codex, trae, cursor, droid, command-code, grok, pi, omp, prime-agent |
| `flag-prompt` | after `--prompt` | opencode, opencode2, mimo-code |
| `flag-prompt-interactive` | after `--prompt-interactive` | qoder, qoder-cn, gemini, antigravity |
| `flag-interactive` | after `-i` | copilot |
| `hermes-query` | through Hermes's `chat --query`, from an environment variable the wrapper unsets | hermes |
| `stdin-after-start` | pasted into the agent's input once it is ready | the other 24 |

A prompt pasted after start waits for the agent's ready signal, is written as one bracketed paste,
and is submitted with a separate Enter ([D21](../../../loop/decisions/m1-providers.md)). Every
launch with a prompt records how the prompt was delivered: on the command line, pasted,
pasted without confirmation, or not delivered ([D22](../../../loop/decisions/m1-providers.md)).
Nothing is ever pasted twice.

## Data flow

**Building the catalog.** When `quirky.agents` activates, and whenever the set of effective
contributions changes, it reads every effective `agent` contribution through the kernel, checks
each entry's fields, and keeps the valid ones. A malformed entry is left out and logged
([D7](../../../loop/decisions/m1-providers.md)). Two entries with the same name keep one: the
built-in, else the lower plugin ID ([D8](../../../loop/decisions/m1-providers.md)).

**Detecting.** At activation and on every Refresh, `quirky.agents` reads `PATH` from the user's
login shell (at most 5 seconds, falling back to the daemon's own `PATH`), adds a fixed list of
install directories, and looks for each agent's commands in those directories without running
anything ([D18](../../../loop/decisions/m1-providers.md)). The result is kept until the next
Refresh.

**Launching.** A client calls `quirky.session/create` with a worktree, an optional agent and an
optional prompt.
1. `quirky.session` asks `quirky.agents` to choose the agent when none is named: the default agent
   if it is installed and enabled, else the first installed, enabled agent in Orca's auto-pick
   order, else a plain shell ([D19](../../../loop/decisions/m1-providers.md)). A named agent that is
   disabled is refused. A named agent that is unknown is refused.
2. `quirky.session` creates the record as `starting` and runs the launch hooks, as today.
3. It asks `quirky.agents` for the plan, giving the agent, the prompt, whether to submit it, the
   folder and the hooks' extra arguments and environment. `quirky.agents` resolves the command (the
   user's override or the catalog's), tokenizes and re-quotes the user's arguments
   ([D12](../../../loop/decisions/m1-providers.md)), appends the hook arguments, and places the
   prompt by the agent's mode. It returns the command string, the environment (the agent's default
   or user environment, then the hooks'), the prompt still to paste if any, and the launch record
   (command, user arguments, user environment).
4. If workspace trust is on, `quirky.agents` writes the agent's trust record for the folder
   ([D28](../../../loop/decisions/m1-providers.md)).
5. `quirky.session` spawns the command under the login shell, stores the launch record on the
   session, and marks the session `running`.
6. If a prompt is left to paste, `quirky.agents` watches the session's output for the ready signal
   and pastes it, or gives up at the deadline. It reports the outcome to `quirky.session`, which
   stores it on the record and emits `quirky.session/changed`.

`create` returns after step 5, unless the caller asked to wait for the prompt, in which case it
returns after step 6.

**Resuming.** `quirky.session/resume` reads the old session's launch record, provider session and
folder, asks `quirky.agents` for a resume plan (the recorded command and arguments, fresh hook
additions, then the agent's resume or fork arguments), and spawns a new session in the old one's
folder ([D24](../../../loop/decisions/m1-providers.md), [D25](../../../loop/decisions/m1-providers.md)).
The provider session reaches the record through `quirky.session/setProviderSession`, which
m1-agent-status will call from agent hooks ([D26](../../../loop/decisions/m1-providers.md)).

**Configuring.** Methods on `quirky.agents` change its store (enabled, command, arguments,
environment per agent) and emit `quirky.agents/changed`. The default agent and workspace trust are
kernel settings owned by `quirky.agents`. The Agents view and the new-session menu re-read the
catalog when `quirky.agents/changed` arrives.

## Key decisions

- **A new plugin, `quirky.agents`, owns agents; `quirky.session` keeps sessions.** A distro can
  replace the agent catalog without touching session records
  ([D5](../../../loop/decisions/m1-providers.md)).
- **Agents are manifest data.** Plugins add, replace and remove agents with the kernel's override
  and disable rules ([D6](../../../loop/decisions/m1-providers.md)).
- **Orca's values and code are ported, not redesigned.** The 45 IDs, flags, signals and timings
  are Orca's ([D9](../../../loop/decisions/m1-providers.md), [D36](../../../loop/decisions/m1-providers.md)).
- **Agents start by exec under the login shell.** No shell is typed into, so the prompt can always
  ride the command line for argv-style agents up to 128 KiB
  ([D11](../../../loop/decisions/m1-providers.md)).
- **Yolo is the default permission mode,** as in Orca. This changes v1's launches of Claude, Codex,
  OpenCode and Gemini, which will start with their bypass flags
  ([D16](../../../loop/decisions/m1-providers.md)).
- **A prompt's delivery is always recorded,** so a prompt lost behind an update dialog shows as
  `not-delivered` instead of silently vanishing ([D22](../../../loop/decisions/m1-providers.md)).
- **Resume replays the launch record, in the original folder.** Never the current defaults, never
  the caller's folder ([D24](../../../loop/decisions/m1-providers.md), [D25](../../../loop/decisions/m1-providers.md)).
- **`Session.agent` becomes any agent ID.** The protocol version stays 2
  ([D10](../../../loop/decisions/m1-providers.md)).

## Behavior & scenarios

Each scenario runs against a fresh temporary `QUIRKY_HOME` and a temporary `HOME`, with a real
`quirkyd` and PTY host, and is driven through the `quirky` CLI or the daemon API as it says. Agent
CLIs are fakes: small executables in a temporary directory on the login shell's `PATH`, named like
the real ones, that print chosen terminal output and record their argv, environment and every byte
they read to a file.

Fake agents used below:

| Fake | Does |
|---|---|
| `claude`, `codex`, `grok`, `gemini`, `opencode`, `copilot`, `hermes` | record argv and environment, then wait |
| `goose` (paste fake) | enables bracketed paste (`ESC[?2004h`), prints a prompt line, goes quiet, records input |
| `qwen` (paste fake, slow) | as `goose`, after 2 seconds |
| `codex` (dialog fake) | prints an "Update available" menu and never enables bracketed paste |
| `aider` (silent fake) | never enables bracketed paste, stays running |
| `amp` (exit fake) | exits 0 after 100 ms |

### Catalog

1. **SC-1: the catalog lists the 45 built-in agents with what each can do** (CLI)
   - **Given** fakes for `claude` and `codex` on `PATH`, nothing else
   - **When** the agent runs `quirky agents list --json`
   - **Then** the result holds the default agent (`auto`), the permission summary (`yolo`) and an
     agent list with 45 entries in auto-pick order, each with its ID, label, plugin
     `quirky.agents`, installed, enabled, whether it is the default, its permission mode (or none),
     its prompt mode, whether it can resume, and its homepage and install links. `claude`,
     `claude-agent-teams` (it runs `claude`) and `codex` are installed; the other 42 are not. All are enabled. None is the default, because the
     default is `auto`.
   - **Data before:** **Default agent**: auto; **PATH**: `claude`, `codex`
   - **Walkthrough:**
     1. The agent runs `quirky agents list --json`
   - **Data after:** **Listing**: ✓ 45 entries; ✓ `claude` installed, permission mode yolo, prompt argv, resumable; ✓ `codex` installed; ✓ `aider` not installed, prompt stdin-after-start, not resumable; ✓ `opencode` permission mode none

2. **SC-2: a plugin adds an agent, and it launches** (API)
   - **Given** an installed plugin `acme.agents` declaring agent `acme-bot` (detect `acme-bot`,
     prompt mode `flag-prompt`, Yolo flag `--yes`), and a fake `acme-bot` on `PATH`
   - **When** a client lists agents, then creates a session with agent `acme-bot` and prompt
     `fix it`
   - **Then** `acme-bot` is listed as installed, from plugin `acme.agents`, and the fake's argv is
     `--yes --prompt 'fix it'` as the shell passes it: `["--yes", "--prompt", "fix it"]`
   - **Data after:** **Session**: ✓ agent `acme-bot`, running; ✓ prompt delivery `command-line`

3. **SC-3: a plugin replaces or removes a built-in agent** (API)
   - **Given** plugin `acme.override` overriding `agent:quirky.agents/codex` with launch command
     `codex --profile acme`, and plugin `acme.trim` disabling `agent:quirky.agents/aider`
   - **When** a client lists agents and asks for the plan for `codex`
   - **Then** `aider` is absent from the listing; `codex` comes from `acme.override` and its plan's
     command starts `codex --profile acme`
   - **Data after:** **Listing**: ✓ 44 entries; ✓ `codex` plugin `acme.override`; ✗ `aider` absent

4. **SC-4: a malformed or duplicate agent entry is skipped and reported** (CLI)
   - **Given** plugin `acme.bad` declaring agent `broken` with no detect command, and plugin
     `acme.dupe` declaring agent `claude`
   - **When** the agent runs `quirky agents list --all --json`
   - **Then** the plain listing still has 45 entries with `claude` from `quirky.agents`. `--all`
     adds `broken` with status `invalid` and an error naming the missing field, and `claude` from
     `acme.dupe` with status `conflict`, naming `quirky.agents` as the winner and saying to use
     `overrides` to replace a built-in agent. Every other plugin and agent works.
   - **Data after:** **Listing --all**: ✓ `broken` invalid, "detect command is required"; ✓ `acme.dupe` claude conflict

### Detection

5. **SC-5: detection finds commands on the login shell's PATH and in install directories** (CLI)
   - **Given** the daemon's own `PATH` lacks the fakes; the login shell's `PATH` has `claude`;
     `$HOME/.local/bin` has `qwen`; `$HOME/.bun/bin` has `kimi-code` (an alias of `kimi`)
   - **When** the agent runs `quirky agents list --json`
   - **Then** `claude`, `qwen-code` and `kimi` are installed, and nothing was executed to find
     them (each fake records any run, and none ran)

6. **SC-6: required commands and aliases decide "installed"** (CLI)
   - **Given** on `PATH`: `dsh-tui` without `dsh`; `qodercn` (alias of `qoder-cn`); `claude`; and
     the `quirky` shim (always present)
   - **When** the agent lists agents
   - **Then** `dsh` is not installed (it also needs `dsh`); `qoder-cn` is installed;
     `claude-agent-teams` is installed (it runs `claude`). Removing `claude` and refreshing makes
     both `claude` and `claude-agent-teams` not installed.

7. **SC-7: Refresh picks up a newly installed agent** (CLI)
   - **Given** a running daemon that detected no `gemini`
   - **When** a fake `gemini` is added to the login shell's `PATH` and the agent runs
     `quirky agents refresh`
   - **Then** `refresh` returns the new listing with `gemini` installed, and
     `quirky.agents/changed` was emitted. Before the refresh, `list` still said not installed.

### Choosing the agent

8. **SC-8: a launch without an agent uses the default, then auto-pick, then a shell** (API)
   - **Given** fakes `codex` and `gemini` on `PATH`
   - **When** a client creates sessions with no agent under each default below
   - **Then** each starts the agent in the table
   - **Choices:**

     | Default agent | Installed and enabled | Starts |
     |---|---|---|
     | `auto` | codex, gemini | `codex` (earlier in auto-pick order) |
     | `gemini` | codex, gemini | `gemini` |
     | `claude` | codex, gemini (claude not installed) | `codex` |
     | `shell` | codex, gemini | a plain shell |
     | `auto` | none | a plain shell |
     | `auto` | codex disabled, gemini | `gemini` |

9. **SC-9: "New agent tab" never opens a plain shell** (API, UI command)
   - **Given** the default agent is `shell` and fake `codex` is installed
   - **When** the window runs command `command:quirky.agents/new-agent-tab`
   - **Then** a `codex` session opens. With no agent installed, the command opens nothing and shows
     "No installed agent is enabled."

10. **SC-10: a disabled agent is hidden and can't be launched by name** (CLI)
    - **Given** fakes `claude` and `codex` installed; the default agent is `claude`
    - **When** the agent runs `quirky agents disable claude`, then `quirky session new --agent claude`
    - **Then** `disable` succeeds and the default becomes `auto`. `claude` is listed with enabled
      false, is no longer auto-picked, and is missing from the new-session menu and the "New agent
      tab" choice. `session new --agent claude` fails with "Claude is disabled. Enable it in Agent
      settings." and starts nothing. A session dialog opened before Claude was disabled stays open
      and shows the same refusal. `quirky agents enable claude` restores it, and the default stays `auto`.
    - **Data before:** **Default agent**: claude; **claude**: enabled
    - **Walkthrough:**
      1. The agent disables `claude`
      2. The agent tries to start `claude` by name
    - **Data after:** **Default agent**: ✓ auto; **claude**: ✓ disabled; ✗ session not started

### Configuring an agent

11. **SC-11: a command override replaces the whole command, and clearing it restores the default** (CLI)
    - **Given** fake `claude` on `PATH` and a script `my-claude` on `PATH`
    - **When** the agent runs `quirky agents configure claude --command my-claude`, plans a launch,
      then runs `quirky agents configure claude --command claude` and plans again
    - **Then** the first plan starts `my-claude`; the second starts `claude`, and `agents get claude`
      shows no command override (saving the catalog default or an empty value removes it).
      `--reset command` has the same effect.

12. **SC-12: arguments are tokenized and re-quoted, so they never run as shell syntax** (CLI)
    - **Given** fake `claude` on `PATH`
    - **When** the agent saves claude arguments `--model "haiku 5" $(touch /tmp/pwned) ; rm -rf x`
      and starts a claude session
    - **Then** the fake's argv is `["--model", "haiku 5", "$(touch", "/tmp/pwned)", ";", "rm", "-rf", "x"]`
      (the permission flag is gone because the arguments are custom), and no file `pwned` was
      created. Saving `--model "haiku` fails with "CLI arguments are invalid: unterminated quote"
      and leaves the saved arguments unchanged.
    - **Data before:** **claude arguments**: untouched (Yolo)
    - **Walkthrough:**
      1. The agent saves the arguments above
      2. The agent starts a claude session
    - **Data after:** **claude arguments**: ✓ custom; **Fake argv**: ✓ literal tokens; ✗ no file created

13. **SC-13: an agent's environment comes from its default or the user's override** (API)
    - **Given** fakes `goose` and `codex`
    - **When** a client starts `goose` with nothing saved, then saves codex environment
      `CODEX_HOME=/tmp/ch` and starts `codex`
    - **Then** goose's environment has `GOOSE_MODE=auto` (its Yolo default); codex's has
      `CODEX_HOME=/tmp/ch`. A saved value for a reserved name (`PATH`, `ZDOTDIR`, `QUIRKY_*`) is
      refused when saved.

### Permission modes

14. **SC-14: untouched arguments mean Yolo** (CLI)
    - **Given** nothing saved for any agent
    - **When** the agent runs `quirky agents plan <agent>` for each agent below
    - **Then** each plan's command includes its agent's Yolo flag
    - **Flags:**

      | Agent | Command starts |
      |---|---|
      | claude | `claude --dangerously-skip-permissions` |
      | codex | `codex --dangerously-bypass-approvals-and-sandbox` |
      | gemini | `gemini --yolo` |
      | aider | `aider --yes-always` |
      | devin | `devin --permission-mode bypass --respect-workspace-trust false` |
      | goose | `goose` (with `GOOSE_MODE=auto`) |
      | opencode | `opencode` (no permission control) |

15. **SC-15: bulk modes change only preset agents, and Auto only the three that have it** (CLI)
    - **Given** claude arguments saved as `--model haiku` (custom); everything else untouched
    - **When** the agent runs `quirky agents permissions auto`, then `manual`, then `manual` again
    - **Then** after `auto`: codex is `--approve-for-me`, claude-agent-teams is `--permission-mode
      auto`, claude still `--model haiku`, gemini still `--yolo`; the summary is `auto`. After
      `manual`: every preset agent has empty arguments and goose an empty environment; claude still
      `--model haiku`; the summary is `manual`. The second `manual` changes nothing and emits no
      `quirky.agents/changed`.
    - **Data before:** **claude**: `--model haiku`; **codex**: untouched; **gemini**: untouched
    - **Walkthrough:**
      1. Auto: codex and claude-agent-teams switch; gemini keeps Yolo
      2. Manual: every preset agent empties; claude keeps its custom arguments
      3. Manual again: nothing changes
    - **Data after:** **claude**: ✓ `--model haiku`; **codex**: ✓ empty; **gemini**: ✓ empty; **Summary**: ✓ manual

16. **SC-16: per-agent modes, custom rows and errors** (CLI)
    - **Given** claude arguments `--model haiku`
    - **When** the agent runs the commands below
    - **Then** each does what the table says
    - **Commands:**

      | Command | Result |
      |---|---|
      | `quirky agents permissions yolo --agent claude` | ✗ "claude has custom arguments; pass --replace-custom to replace them" |
      | `quirky agents permissions yolo --agent claude --replace-custom` | ✓ claude `--dangerously-skip-permissions` |
      | `quirky agents permissions auto --agent gemini` | ✗ "gemini has no Auto mode" |
      | `quirky agents permissions yolo --agent opencode` | ✗ "opencode has no permission modes" |
      | `quirky agents permissions yolo` (some rows yolo, some manual) before it | summary `mixed` |

17. **SC-17: opencode and kilo never receive the Claude bypass flag** (API)
    - **Given** opencode arguments saved as `--dangerously-skip-permissions --model x`
    - **When** a client plans an opencode launch
    - **Then** the command is `opencode --model x`

### Delivering the first prompt

18. **SC-18: argv agents get the prompt literally on the command line** (CLI)
    - **Given** fakes `claude`, `codex`, `grok`
    - **When** the agent runs `quirky session new --agent <agent> --prompt "<prompt>"` with each
      prompt below
    - **Then** the fake's last argv elements are exactly the prompt (after `--` for grok), the
      session's prompt delivery is `command-line`, and nothing is written to the agent's input
    - **Prompts:**

      | Agent | Prompt | Last argv |
      |---|---|---|
      | claude | `it's "done"; echo $HOME` | `["it's \"done\"; echo $HOME"]` |
      | codex | `line one` + newline + `line two` | `["line one\nline two"]` |
      | grok | `--help` | `["--", "--help"]` |

19. **SC-19: flag modes put the prompt after their flag** (API)
    - **Given** fakes `opencode`, `gemini`, `copilot`, `hermes`
    - **When** a client starts each with prompt `fix the bug`
    - **Then** opencode gets `--prompt 'fix the bug'`, gemini `--prompt-interactive 'fix the bug'`,
      copilot `-i 'fix the bug'`, and hermes runs `chat --query=fix the bug ... --tui` with the
      startup variable gone from its environment. Each records `command-line`.

20. **SC-20: a stdin-after-start agent gets one bracketed paste, then Enter** (API)
    - **Given** the `goose` paste fake
    - **When** a client starts goose with prompt `a` + CRLF + `b` + ESC + `c` and `waitForPrompt`
    - **Then** the fake's input is `ESC[200~a\rb␛cESC[201~`, then, in a separate read at least
      500 ms later, `\r`. The result's prompt delivery is `pasted`.
    - **Data before:** **Session**: none
    - **Walkthrough:**
      1. The client creates the session; the fake enables bracketed paste and goes quiet
      2. Quirky sees the ready signal and writes the paste
      3. After 500 ms + 1 ms per 4 KiB, Quirky writes Enter
    - **Data after:** **Session**: ✓ prompt delivery `pasted`; **Fake input**: ✓ one paste, then one Enter

21. **SC-21: each ready signal is recognised** (unit, ported from Orca)
    - **Given** recorded startup output for each signal
    - **When** the scanner reads it
    - **Then** it reports ready exactly where Orca's tests say: the quiet window after
      `ESC[?2004h`; a show-cursor while bracketed paste is on (opencode, mimo-code); `❯` after
      `ESC[?1049h` (grok, dsh); `╭` after it (zcode); Codex's composer frame; OpenCode's agent row
      as the submit signal. Output before the alternate screen never counts for the glyph signals.

22. **SC-22: an agent that never signals ready gets a blind paste, reported as unconfirmed** (API)
    - **Given** the `aider` silent fake
    - **When** a client starts aider with prompt `hi` and `waitForPrompt`
    - **Then** after 8 seconds the prompt is pasted and submitted anyway, and the delivery is
      `unconfirmed`

23. **SC-23: Orca defect: a prompt lost behind a dialog is reported, never silent** (CLI)
    - **Given** the `codex` dialog fake, whose prompt arrives by paste because it is a draft
    - **When** the agent runs `quirky session new --agent codex --prompt "review" --draft --wait`
    - **Then** after 20 seconds the command prints prompt delivery `not-delivered`, the fake's input
      is empty (nothing was typed into the dialog), the session is still running, and
      `quirky session list --json` shows the same delivery
    - **Data before:** **Session**: none
    - **Walkthrough:**
      1. Codex shows its update menu and never enables bracketed paste
      2. The 20-second deadline passes; Codex never pastes blind
    - **Data after:** **Session**: ✓ running; ✓ prompt delivery `not-delivered`; **Fake input**: ✓ empty

24. **SC-24: a session that ends or closes first gets nothing** (API)
    - **Given** the `amp` exit fake, and separately the `aider` silent fake
    - **When** a client starts amp with a prompt; and starts aider with a prompt, then closes it at
      once
    - **Then** both deliveries are `not-delivered` and neither fake read any input

25. **SC-25: per-agent Enter timing** (API)
    - **Given** paste fakes named `qwen`, `agy` and `omp`, and a test plugin overriding the
      antigravity and omp entries to prompt mode `stdin-after-start` (their real modes carry the
      prompt on the command line)
    - **When** a client starts each with a three-line prompt
    - **Then** qwen-code reads the paste, an Enter, and a second Enter about 1,200 ms later;
      antigravity's Enter comes at least 500 + 3 × 45 ms after its paste; omp's Enter arrives in the
      same write as the paste

26. **SC-26: a draft prompt is left in the input** (API)
    - **Given** fakes `claude` and the `goose` paste fake
    - **When** a client starts each with prompt `look at #5` and `submitPrompt: false`
    - **Then** claude's argv ends `--prefill 'look at #5'` (recorded as `command-line`); goose gets
      the bracketed paste and no Enter (recorded as `pasted`)

27. **SC-27: a prompt over 128 KiB is pasted instead of carried** (API)
    - **Given** fake `codex` as a paste fake
    - **When** a client starts codex with a 200 KiB prompt
    - **Then** the command line has no prompt and the prompt arrives as one bracketed paste

28. **SC-28: `create` returns at spawn unless asked to wait** (API)
    - **Given** the `qwen` slow paste fake
    - **When** a client creates a session with a prompt and no `waitForPrompt`
    - **Then** `create` returns with prompt delivery `pending` before the paste; later
      `quirky.session/changed` carries the session with delivery `pasted`. A prompt containing NUL
      is refused before anything starts. A delivery still `pending` when the daemon restarts is
      marked `not-delivered` at startup.

29. **SC-29: `plan` shows a launch without starting it** (CLI)
    - **When** the agent runs `quirky agents plan grok --prompt "help"`
    - **Then** it prints the command line (`grok --permission-mode bypassPermissions -- 'help'`),
      the prompt delivery (`command-line`) and the environment additions, and no session exists

### Resume and fork

30. **SC-30: the provider session is stored only if it is valid** (CLI)
    - **Given** a codex session
    - **When** the agent runs `quirky session set-provider-session <session> <id>` with each id
    - **Then** `0199a-thread` and a 512-character id are stored; an empty id, a 513-character id,
      `-x` and an id containing a newline are refused with the rule they break

31. **SC-31: resume replays the launch record, not today's defaults, in the original folder** (CLI)
    - **Given** a claude session launched with arguments `--model haiku` and given provider session
      `abc`; afterwards the claude arguments were changed back to Yolo
    - **When** the agent runs `quirky session resume <session>` from another folder
    - **Then** a new session starts in the old session's folder, running
      `claude --model haiku <hook args> --resume abc`; it has no `--dangerously-skip-permissions`.
      The new session records the launch it used (`claude`, `--model haiku`), so resuming it later
      replays the same. The old record is unchanged. A session from before this item (no launch
      record) resumes with the catalog command and no arguments, and its resumed session records
      that.
    - **Data before:** **Session 1**: claude, folder `wt-a`*, arguments `--model haiku`, provider session `abc`; **claude arguments now**: Yolo
    - **Walkthrough:**
      1. The agent resumes Session 1 from folder `elsewhere`*
      2. Quirky rebuilds the command from Session 1's record and adds `--resume abc`
    - **Data after:** **Session 2**: ✓ claude, folder `wt-a`; ✓ argv `--model haiku … --resume abc`; ✗ no bypass flag; **Session 1**: ✓ unchanged

32. **SC-32: each resumable agent gets its own resume arguments** (unit and API)
    - **Given** a session of each of the 25 resumable agents with provider session `S` (and
      transcript `T` where the agent needs it)
    - **When** each is resumed
    - **Then** the resume arguments match providers.md's Resume column (`codex resume S`,
      `copilot --resume=S`, `pi --session T`, `kiro-cli --resume-id S`, ...)

33. **SC-33: Claude's saved resume selector is replaced, not doubled** (unit)
    - **Given** recorded claude arguments `--continue --model x -- extra` and provider session `abc`
    - **When** it is resumed
    - **Then** the arguments are `--model x --resume abc -- extra`

34. **SC-34: fork opens a copy for the four agents that fork by argument** (CLI)
    - **When** the agent runs `quirky session resume <session> --fork` for claude, codex, grok and pi
      sessions with provider sessions
    - **Then** they run `claude --resume S --fork-session`, `codex fork S`,
      `grok --resume S --fork-session` and `pi --fork T`. For an opencode session `--fork` fails
      with "opencode can't fork from Quirky yet".

35. **SC-35: Orca defect: resume and fork are refused where they can't work** (CLI)
    - **When** the agent resumes each session below
    - **Then** each fails with the message in the table and starts nothing
    - **Refusals:**

      | Session | Message |
      |---|---|
      | a plain shell (Orca offers Fork on shell panes) | "session s_… is a shell, not an agent" |
      | aider (no resume) | "aider can't resume sessions" |
      | codex with no provider session and no `--provider-session` | "session s_… has no provider session; pass --provider-session" |
      | claude whose folder was deleted | "the session's folder /… no longer exists" |

### Workspace trust

36. **SC-36: trust records are pre-written before the agent starts** (API)
    - **Given** workspace trust on, a temporary `HOME`, fakes `claude`, `cursor-agent`, `copilot`,
      `codex`
    - **When** a client starts each in worktree folder `/…/wt-a`
    - **Then** before each fake ran: `$HOME/.claude.json` has `projects["/…/wt-a"].hasTrustDialogAccepted = true`
      with its other keys kept; `$HOME/.cursor/projects/<slug>/.workspace-trusted` exists;
      `$HOME/.copilot/config.json` lists the folder in `trustedFolders` with other keys kept;
      codex's `config.toml` has a `trust_level` for the project. With the setting off, none of them
      changes. An unwritable `$HOME/.claude.json` is logged and the session still starts.

### Claude Agent Teams

37. **SC-37: Claude Agent Teams runs Claude with in-process teammates** (CLI)
    - **Given** fake `claude`
    - **When** a client starts agent `claude-agent-teams` with a prompt
    - **Then** the fake `claude` ran with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and argv starting
      `--teammate-mode in-process --dangerously-skip-permissions`, and the prompt arrived by paste
      (its mode is stdin-after-start)

### Compatibility

38. **SC-38: v1 sessions and commands keep working** (CLI)
    - **Given** a v1 home with claude and codex session records
    - **When** the daemon starts and the agent runs `quirky session list` and
      `quirky session new --agent claude --prompt hi`
    - **Then** the old records list unchanged; the new claude session gets agent-status's
      `--settings` hook argument before the prompt; and `--agent` is now optional

### The window

These run in the web UI against a daemon with fakes `claude`, `codex` and `goose` installed.

39. **SC-39: the Agents view shows Orca's sections and counts** (UI)
    - **When** the person runs "Open agent settings" from the command palette
    - **Then** the Agents view shows: Default Agent with Auto, Claude, Claude Agent Teams, Codex,
      Goose and Blank Terminal; Agent Permissions with Yolo selected; "Installed" with a
      "4 detected" badge; "Available to install" with a "41 agents" badge, each row with an
      Install link; and a
      "This Mac" heading with the workspace-trust switch on
    - Installed cards keep the Enabled checkbox and label, Set default, Docs, and expand control
      together on one line at the default panel width. Enabled switches retain agent-specific
      accessible names without repeating the agent name in the visible label.
    - **Screen states:**

      | Area | Shows |
      |---|---|
      | Default Agent | Auto (selected), Claude, Claude Agent Teams, Codex, Goose, Blank Terminal |
      | Agent Permissions | Manual / Auto / Yolo, Yolo selected |
      | Installed | 4 detected, Refresh |
      | Available to install | 41 agents |

40. **SC-40: expanding a row edits that agent** (UI)
    - **When** the person expands Claude, clicks Manual, then types `--model haiku` into Arguments
      and presses Tab
    - **Then** after Manual the Arguments field is empty and Reset appears; after the edit the row
      shows a "Custom" badge, "Custom arguments" and a "Replace with Yolo" action, and the
      global control still shows Yolo. Expanding Goose shows an Environment field with
      `GOOSE_MODE=auto`; Claude has none. Typing `--model "haiku` shows "CLI arguments are invalid:
      unterminated quote" under the field and keeps the text.

41. **SC-41: disabling an agent in the view** (UI)
    - **When** the person switches Codex off
    - **Then** its row shows "Disabled", its "Set default" button is gone, Codex leaves the Default
      Agent row and new-session menu, and "New Codex tab" disappears from the palette.

42. **SC-42: Refresh and the empty state** (UI)
    - **When** the person clicks Refresh on a machine with no agents on `PATH`
    - **Then** the button reads "Refreshing…" until it finishes; Installed then says "No agents
      detected. Install one below, then Refresh." and Default Agent shows only Auto and Blank
      Terminal

43. **SC-43: the new-session menu and agent commands** (UI)
    - **When** the person opens the `+` menu, then the command palette
    - **Then** the menu lists Shell, "Manage agents", and choices only for installed and enabled
      agents (Claude, Claude Agent Teams, Codex, Goose and "Claude (background)" in this example);
      "Manage agents" opens the Agents view. The palette retains generic "New agent tab (default
      agent)" with Cmd+Option+T regardless of individual agent availability, and lists explicit
      "New <Agent> tab" commands only for installed and enabled catalog agents. Disabling removes
      an explicit command; re-enabling restores it in an open palette without reloading the app.
      Pressing Cmd+Option+T opens a Claude tab (first in auto-pick order).
    - Foreground initial prompts and required background prompts preserve typed shell flags and
      ASCII quotes without OS autocorrection, capitalization or smart punctuation substitutions.
      For example, `quirky ask --spec '{"question":"Pick a color"}'` reaches submission unchanged.

## Scope & non-goals

**In scope:** the flows of [providers.md](../../../../research/orca-features/providers.md) "What the
user can do" and "How it works": choosing the agent, the settings that change a launch, permission
modes, detection and Refresh, the 45-agent table, first-prompt delivery, paste after ready, drafts,
resume and fork, workspace trust, Claude Agent Teams (in-process), and the Agents view, plus the
two Orca defects (SC-23, SC-35) and the disabled-agent picker question (SC-10, SC-41).

**Non-goals:**
- Model and effort options and their pickers (m1-launch-settings).
- Claude's ask-question suppression flags (m2-ask-parity).
- Choosing a structured chat surface per launch (M5) and native chat.
- Account environment routing (m3-accounts).
- The Create worktree dialog's agent field and work-item launches (m1-worktrees, M4).
- Capturing provider sessions from hooks, and the agent status hooks switch (m1-agent-status).
- Session history UI: resume buttons, Copy Resume Command (m3-session-info).
- Cold-restore resume after a PTY host restart ([D27](../../../loop/decisions/m1-providers.md)).
- Native split panes for Agent Teams teammates (m1-term-ui).
- The pi and omp prefill extensions, OpenCode's startup-prompt claim, OMP's fresh-launch config,
  and forking through a chat protocol (opencode, opencode2, omp).
- Reusing an existing terminal for a launch: every launch is a new session.
- The host switches for Codex servers, tab titles, keep-awake and the prompt cache timer.
- PowerShell and cmd quoting, WSL and Windows key encodings
  ([D13](../../../loop/decisions/m1-providers.md)).
- Remote (SSH) detection and launch.

## Decisions Locked

- **Grouping:** `quirky.agents` owns the catalog, configuration, planning, trust and prompt delivery; `quirky.session` owns records and spawn (D5).
- **Naming:** Orca's agent IDs and labels; CLI group `quirky agents` (D9, D34).
- **Duplicates:** built-in wins, then the lower plugin ID; losers listed as `conflict` (D8).
- **Exceptions:** malformed entries are skipped and listed as `invalid` (D7).
- **Input format:** Arguments are tokenized POSIX-style and re-quoted (D12).
- **Response format:** sessions carry `promptDelivery`; `--wait` blocks for it (D22).
- **Error responses:** disabled, unknown, bad quoting, bad provider session, missing folder, no resume (SC-10, SC-12, SC-30, SC-35).
- **Versioning:** `Session.agent` is any agent ID; protocol stays 2 (D10).
- **Flags and output:** D34.
- **Idempotency:** permission modes rewrite to fixed values (D17).
- **Retry policy:** one paste, never retried; codex and qwen-code get one extra blind Enter (D21).
- **Data mapping:** seven trust presets in the daemon user's home (D28).
- **Layout, empty and error states:** the Agents view (D30, D31), the new-session menu (D32).
- **Palette agent commands:** explicit commands are available only for installed and enabled
  catalog agents; the generic default-agent command remains available, and an open palette
  reflects enablement changes without reloading (SC-43).

## Industry Insights

- Readiness can't rest on bracketed paste alone: Claude enables it before its startup dialogs, and
  a dialog's default answer can quit the agent. Pre-writing trust and refusing to paste into an
  unready Codex follow from this. ([cccc #95](https://github.com/ChesterRa/cccc/issues/95))
- OpenCode drops pastes sent 3–10 s after launch; startup input needs a real ready signal, not a
  sleep. ([opencode #42915](https://github.com/anomalyco/opencode/issues/42915))
- Paste and Enter race in Codex and Gemini; send Enter as a separate write after a settle delay.
  ([codex #56982](https://github.com/openai/codex/issues/56982), [gemini-cli #3940](https://github.com/google-gemini/gemini-cli/issues/3940))
- GUI-launched daemons see a minimal `PATH`, and `-l -c` skips `.zshrc`, so detection must read the
  login shell's `PATH` and check install directories. ([claudette #1004](https://github.com/utensils/claudette/issues/1004),
  [mycelium #1455](https://github.com/mycelium-io/mycelium/issues/1455),
  [U&L SE 217932](https://unix.stackexchange.com/questions/217932/run-zshrc-when-passing-command-via-c))
- Resume is tied to the start folder; resuming elsewhere fails even with a valid id.
  ([claude-code #68525](https://github.com/anthropics/claude-code/issues/68525),
  [orca #9361](https://github.com/stablyai/orca/issues/9361))
- Prompts starting with `-` get parsed as flags without a `--`.
  ([copilot-cli #4902](https://github.com/github/copilot-cli/issues/4902))
- Typing a long line into a macOS terminal is capped at 1,024 bytes in canonical mode, one reason
  to exec rather than type.
  ([DEV article](https://dev.to/gabrielanhaia/paste-2000-characters-at-a-line-mode-prompt-and-macos-keeps-1024-blame-the-tty-2hc1))
- Declarative contribution points should carry enough to list an entry without running code,
  reference code-backed behavior by stable ID, and have host-defined duplicate and disable rules.
  ([VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points),
  [vscode #120369](https://github.com/microsoft/vscode/issues/120369))

## Deferred Ideas

- Cold-restore resume once provider sessions are captured (D27).
- Running agents through an interactive shell, if `.zshrc`-only installs prove common (D11, D18).
- A search box in the new-session menu (D32).
- `[tech-spec]` How `quirky.agents` learns the effective `agent` contributions and when they change.
- `[tech-spec]` How a test controls the login shell's `PATH`.
- `[tech-spec]` Where the ready-signal watcher subscribes to PTY output, and how it stops.

## Glossary

- **Agent:** an agent CLI Quirky can start, one catalog entry.
- **Catalog:** the effective, valid `agent` contributions.
- **Detect command:** the name looked for on `PATH` to decide an agent is installed.
- **Launch record:** the command, user arguments and user environment a session started with.
- **Provider session:** the agent CLI's own session ID (and sometimes transcript path) that resume
  passes back to it.
- **Prompt delivery:** how a launch's first prompt reached the agent: `command-line`, `pending`,
  `pasted`, `unconfirmed` or `not-delivered`.
- **Ready signal:** terminal output that shows an agent's input can take a paste.
- **Permission mode:** Manual (empty arguments), Auto or Yolo (the agent's flag); `mixed` when
  agents differ.
- **Custom arguments:** saved arguments that are none of empty, the Yolo flag or the Auto flag.
- **Draft:** a prompt left in the agent's input without Enter.
