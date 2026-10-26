# m1-providers decisions

## D1: Classify the item as Data, API, CLI, Visual and Integration work, and run every research phase
- **Question:** which gray-area domains apply, and whether the research swarms run (quirk:brainstorming, checklist steps 2 and 7)
- **Options:** one domain; several; skip research because Orca's source already answers most questions
- **Chose:** Data (the 45-agent catalog and per-agent configuration), API and CLI (launch, resume, detection and permission methods and their commands), Visual (the Agents view and the new-session menu) and Integration (third-party CLIs, their trust files and their TUIs' readiness). Phase A ran two web-research agents (launcher patterns; launch pitfalls). Phase B ran one per approach.
- **Why:** the consumers are an agent or script at the CLI, the person at the window, and plugin authors who add agents. Orca's source answers how Orca behaves, not what went wrong for other launchers.
- **Evidence:** docs/loop/queue.json m1-providers; docs/roadmap.md M1 "Agent launch"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D2: Skip the visual companion and the adhd offer, use the standard gray-area set
- **Question:** brainstorming's visual companion offer and its Step 0 adhd offer
- **Options:** run them; skip them
- **Chose:** skip both
- **Why:** LOOP.md says to skip the parts that assume a person is there
- **Evidence:** docs/loop/LOOP.md "Skip the parts that assume a person is there"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D3: Select every gray area that matters for m1-providers
- **Question:** which gray areas to drill into (brainstorming Gray Areas Step 1)
- **Options:** Data: input-format, output-format, error-handling, idempotency; API: response-format, error-responses, versioning; CLI: output-format, flag-design, exit-codes, error-recovery; Organization: grouping-criteria, naming-convention, duplicate-handling, exception-handling; Visual: layout-style, empty-state, error-state, interaction-style; Integration: retry-policy, data-mapping
- **Chose:** grouping-criteria (which plugin owns what), naming-convention (agent IDs, methods, CLI words), duplicate-handling (two plugins declaring one agent ID), exception-handling (a malformed agent entry), input-format (how Arguments text is tokenized), response-format (agent listing and launch result), error-responses, versioning (the session `agent` field widening), flag-design, output-format, idempotency (permission modes), retry-policy (prompt paste and Enter), data-mapping (trust files written for each agent), layout-style, empty-state and error-state (the Agents view)
- **Why:** LOOP.md asks for every area that matters. Pagination, rate limiting and authentication have no new consumer here; interaction style follows the existing window.
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D4: The item stays one item with one pair of specs
- **Question:** brainstorming's scope check: does the item need decomposing
- **Options:** split catalog, launch and resume into separate specs; one pair of specs built in waves
- **Chose:** one logic spec and one tech spec, built in dependency-ordered waves
- **Why:** the loop cannot split a queue item, and every part reads the same catalog
- **Evidence:** docs/loop/LOOP.md "Hard rules"; docs/loop/queue.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/queue.json

## D5: A new built-in plugin, `quirky.agents`, owns the catalog, detection, agent configuration and launch planning; `quirky.session` keeps records and spawning
- **Question:** grouping-criteria: where the providers feature lives
- **Options:** grow `quirky.session` (m0-core D5 gave it agent launch); a new `quirky.agents` plugin that `quirky.session` depends on; move session records into the new plugin too
- **Chose:** `quirky.agents` owns the agent catalog, detection, the per-agent configuration (enabled, command, arguments, environment, permission mode), the default agent, launch and resume planning, workspace trust and prompt delivery after start. `quirky.session` keeps the session records, the PTY spawn and the session CLI, and asks `quirky.agents` for the launch plan. `quirky.session` declares a dependency on `quirky.agents`.
- **Why:** the roadmap ships each feature as its own built-in plugin with its own API and CLI group, and a distro should be able to replace the agent catalog without replacing session records. This narrows m0-core D5, which put "agent launch" in `quirky.session` when launch was a five-line switch.
- **Evidence:** docs/roadmap.md "When a milestone is done"; docs/loop/decisions/m0-core.md D5; plugins/quirky.session/src/agents.ts
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** a later item needs session records and agent planning to change together in one transaction
- **Source:** supersedes m0-core D5 (narrows it)

## D6: Each agent is an `agent` contribution in a manifest, so plugins can add, replace or disable agents as data
- **Question:** "all 45 CLIs as data": where the data lives
- **Options:** a TypeScript table inside the plugin (Orca's `TUI_AGENT_CONFIG`); a JSON file the plugin reads; one `agent` contribution per CLI in `quirky.agents`' manifest
- **Chose:** `agent` contributions. `quirky.agents` declares all 45. Another plugin adds an agent by declaring its own `agent` contribution, replaces a built-in one through `overrides`, or removes it through `disables`, with the kernel's existing override and disable rules. The agent's ID is the contribution's name (`agent:quirky.agents/claude` is agent `claude`). Behavior that data can't express (readiness scanners, the Claude resume splice, the Hermes query wrapper) is code in `quirky.agents`, selected by name from the entry (`readySignal: "codex-composer-prompt"`).
- **Why:** the roadmap's "Overrides" rule says a plugin can replace or disable any built-in contribution, and the kernel already accepts any kind name and applies overrides and disables generically. A TS table would make a third-party agent a code change to a built-in.
- **Evidence:** packages/protocol/src/plugins.ts isKind, parseContributionId; packages/daemon/src/plugins/manifest.ts overrides and disables; docs/roadmap.md "Overrides"
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** the agent fields need validation at manifest load, which today only kernel kinds get
- **Source:** assumed — autonomous

## D7: `quirky.agents` validates agent entries itself and skips a malformed one with a diagnostic
- **Question:** exception-handling: an `agent` contribution with a missing or wrong field
- **Options:** make the kernel validate the kind (the plugin becomes invalid); validate in `quirky.agents` and skip the entry; accept anything
- **Chose:** `quirky.agents` checks each entry when it builds the catalog. A malformed entry is left out of the catalog, logged, and listed by `quirky agents list --all` with its error. The rest of the catalog loads.
- **Why:** m0-daemon-api D14 leaves non-kernel kinds unchecked by the kernel, and one bad third-party agent shouldn't make its whole plugin invalid
- **Evidence:** docs/loop/decisions/m0-daemon-api.md D14
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D8: Two effective `agent` contributions with the same name: the built-in wins, then the lower plugin ID
- **Question:** duplicate-handling: `agent:acme/claude` and `agent:quirky.agents/claude` are different contribution IDs with the same agent ID
- **Options:** reject both; first by plugin ID wins; built-in wins, then lower plugin ID
- **Chose:** a built-in agent keeps its ID; among non-built-ins the lower plugin ID (string order) wins. The loser is listed by `--all` as `conflict`, naming the winner. Replacing a built-in agent is done with `overrides`, which the conflict message says.
- **Why:** session records store the bare agent ID, so it must name one entry. Deterministic order keeps the catalog stable across restarts.
- **Evidence:** packages/daemon/src/plugins/registry.ts (override precedence)
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D9: Agent IDs, labels and table values are Orca's
- **Question:** naming-convention: what the 45 agents are called
- **Options:** Orca's `TuiAgent` IDs; new Quirky names
- **Chose:** Orca's IDs and labels (`claude`, `claude-agent-teams`, `qwen-code`, ...) and its per-agent values (detect commands, launch commands, prompt modes, resume argv, permission flags, ready signals, timeouts, homepage and install links), ported from Orca's source. v1's four (`claude`, `codex`, `opencode`, `gemini`) already use these IDs, so existing session records keep working.
- **Why:** architecture.md says agent launch specs, prompt injection and startup plans are ported as is, and the feature doc is the requirement
- **Evidence:** docs/architecture.md "Where the code comes from"; research/orca-features/providers.md "Every supported agent"; ~/PycharmProjects/orca/src/shared/tui-agent-config.ts
- **Reversibility:** hard
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D10: `Session.agent` becomes any agent ID string, and the protocol version stays 2
- **Question:** versioning: the protocol's `AgentKind` is a closed union of v1's five
- **Options:** grow the union to 46 names; make it `string` and drop `AGENT_KINDS`; bump the protocol version
- **Chose:** `Session.agent` is a string: `shell` or an agent ID. The daemon checks agent IDs against the catalog at launch. `PROTOCOL_VERSION` stays 2, because every value an old client could see is still valid.
- **Why:** a plugin can add agents, so no closed list in the protocol can be right
- **Evidence:** packages/protocol/src/model.ts:24-26
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D11: Agents are still started by exec under the login shell, not typed into an interactive shell
- **Question:** Orca types the launch line into the user's interactive shell; v1 runs `<shell> -l -c 'export PATH=...; exec <command>'`
- **Options:** keep exec; type into an interactive shell and leave the shell behind
- **Chose:** keep exec. The launch "line" Orca builds becomes the command string given to the login shell. Orca's typed-line limits (512 bytes, 8,192 for multi-line zsh) don't apply, so argv-mode agents always carry the prompt on the command line, except over 128 KiB, where the prompt is pasted after start instead.
- **Why:** exec is how every v1 session starts, status and exit codes depend on the agent being the PTY's process, and typing needs the shell-ready barrier that m1-term-daemon is building in another lane. A command line can carry any prompt text except NUL, so the typed-line hazards go away. 128 KiB stays well under macOS's ARG_MAX of 1 MiB with a large environment.
- **Evidence:** packages/daemon/src/launch.ts commandArgv; research/orca-features/providers.md "Rules that apply to the typed line"; Phase B research on exec versus typing (below, D30)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** users need the shell to stay after the agent exits, or nvm-only installs fail because `-l -c` skips `.zshrc`
- **Source:** assumed — autonomous

## D12: Arguments are tokenized shell-style and each token re-quoted, so the user's text never runs as shell syntax
- **Question:** input-format: what the Arguments and Command fields accept
- **Options:** pass the text raw into the command string (v1 had no such field); tokenize and re-quote (Orca)
- **Chose:** Orca's rule: tokenize POSIX-style (quotes and backslashes group, `;`, `|`, `&`, `$()` and backticks are literal characters inside tokens), re-quote each token for the shell. Unbalanced quotes fail with "CLI arguments are invalid: ..." or "Agent command override is invalid: ...", and no session starts. Only the POSIX dialect is built.
- **Why:** the feature doc's rule; it stops a saved argument from running as a command
- **Evidence:** research/orca-features/providers.md "Argument handling details"; ~/PycharmProjects/orca/src/shared/tui-agent-startup-shell.ts
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/providers.md

## D13: PowerShell and cmd quoting, WSL detection and Windows key encodings are not built
- **Question:** the doc's Windows and WSL paths
- **Options:** port them now; leave them out and log them
- **Chose:** leave them out. The catalog keeps the Windows-only fields as data so a later port has them; nothing reads them.
- **Why:** every milestone is built and tested on macOS only
- **Evidence:** docs/loop/LOOP.md "Platforms"; research/orca-features/providers.md "Windows and shell details"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** deferred: platform

## D14: Per-agent configuration lives in `quirky.agents`' store; the default agent and workspace trust are plain settings
- **Question:** data shape for Orca's `agentCmdOverrides`, `agentDefaultArgs`, `agentDefaultEnv`, `disabledTuiAgents`, `defaultTuiAgent` and `agentWorkspaceTrustEnabled`
- **Options:** settings for everything (settings are scalar only, so 45 × 4 settings); a store table per agent plus scalar settings for the two global values
- **Chose:** a store row per configured agent (enabled, command override, arguments override, environment override; absent fields mean "use the catalog default"). Two settings: `quirky.agents/default-agent` (string: `auto`, `shell` or an agent ID; default `auto`) and `quirky.agents/workspace-trust` (boolean; default true). Methods change the store; `setting.set` changes the settings.
- **Why:** the kernel's settings are boolean, number, string or enum only, and a per-agent map needs "unset" to differ from "empty" (Manual stores an empty string that beats the default)
- **Evidence:** packages/daemon/src/plugins/ui-kinds.ts SETTING_TYPES; research/orca-features/providers.md "Settings that change a launch"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D15: An agent the user disables stays in the catalog and is hidden from pickers; an agent a plugin or distro disables leaves the catalog
- **Question:** two ways to switch an agent off: the Agents view's Enabled switch and the kernel's contribution disable
- **Options:** map the Enabled switch to the kernel's contribution disable; keep a user-disabled list in the store
- **Chose:** the store. A user-disabled agent is listed with `enabled: false`, never auto-picked, left out of the new-session menu and the per-agent commands, and a launch naming it explicitly is refused with "agent <id> is disabled". Disabling the default agent resets the default to `auto`. A kernel disable (distro, plugin or `quirky plugin` command) removes the agent from the catalog.
- **Why:** Orca keeps disabled agents visible with a Disabled tag so they can be turned back on; the kernel's disable is for distros removing things
- **Evidence:** research/orca-features/providers.md "Disable an agent: worked"; ~/PycharmProjects/orca/src/shared/tui-agent-selection.ts:103-119
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/providers.md

## D16: Agent Permissions default to Yolo, as in Orca
- **Question:** the default Arguments for the 31 agents with a bypass flag
- **Options:** Yolo (the doc's default); Manual (v1 launched Claude without a bypass flag)
- **Chose:** Yolo: an untouched Arguments field means the agent's bypass flag (or goose's `GOOSE_MODE=auto` environment). Choosing Manual stores an empty value.
- **Why:** parity: the doc says what Orca does is the requirement, and the user runs agents this way in Orca today. This changes v1 behavior: Claude, Codex, OpenCode and Gemini sessions start with their bypass flags after the upgrade.
- **Evidence:** research/orca-features/providers.md "Settings that change a launch" (Arguments row) and "Permission modes"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the user wants Quirky's default to be Manual
- **Source:** locked by research/orca-features/providers.md

## D17: Permission modes follow Orca's rules, and changing them is idempotent
- **Question:** idempotency and error-responses for Manual / Auto / Yolo
- **Options:** Orca's rules; overwrite every agent's arguments
- **Chose:** Orca's rules. A bulk change rewrites an agent's arguments only when they are empty, the Yolo flag or the Auto flag; anything else is custom and left alone. Bulk Auto changes only the three agents with an Auto flag. The summary is `manual`, `auto`, `yolo` or `mixed`, ignoring custom rows, and `auto` when every Auto-capable preset agent is on Auto. A per-agent change to an agent with custom arguments is refused unless the call passes `replaceCustom` ("Replace with <mode>"). Per-agent Auto on an agent without an Auto flag, or any mode on an agent with no permission control, is an invalid-params error. Applying a mode twice changes nothing the second time. `opencode` and `kilo` drop `--dangerously-skip-permissions` from saved arguments at launch.
- **Why:** the doc's behavior; idempotency falls out of rewriting to fixed values
- **Evidence:** ~/PycharmProjects/orca/src/shared/tui-agent-permissions.ts:120-213; research/orca-features/providers.md "Permission modes"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/providers.md

## D18: Detection walks the login shell's PATH plus well-known install directories, with no subprocess per command
- **Question:** how "installed" is decided, given a daemon started by a GUI app inherits a minimal PATH
- **Options:** the daemon's own PATH; run `command -v` per agent; read the login shell's PATH once, then walk it in the filesystem, plus a fixed list of install directories
- **Chose:** read `PATH` from `$SHELL -l -c` once at activation and on every Refresh (5 s limit, falling back to the daemon's PATH), then walk it per command, plus `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/.cargo/bin`, `~/.deno/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. An agent is installed when its detect command or an alias is found and every required command is too. Results are kept in memory until the next Refresh.
- **Why:** Orca's rule, and the research's GUI-PATH failures (Claudette #1004). Using the login shell's PATH matches how D11 launches agents, so "installed" means "the launch will find it".
- **Evidence:** research/orca-features/providers.md "Detect, install, refresh"; https://github.com/utensils/claudette/issues/1004; https://github.com/mycelium-io/mycelium/issues/1455
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** agents installed only through `.zshrc` (nvm) are reported missing
- **Source:** locked by research/orca-features/providers.md

## D19: Choosing the agent: an explicit agent, else the default, else Orca's auto-pick order
- **Question:** how a launch without an agent picks one, and what a launch of an undetected agent does
- **Options:** Orca's `pickTuiAgent`; always require an agent
- **Chose:** `quirky.session/create` takes an optional `agent`. Omitted means the default agent: `shell` opens a plain terminal; an agent ID is used if it is installed and enabled; otherwise (and for `auto`) the first installed, enabled agent in Orca's auto-pick order; with none, a plain terminal. The "New agent tab" command (Mod+Alt+T) uses the same order but treats a `shell` default as `auto`, and fails with "no installed agent is enabled" when there is none. An explicit agent that isn't detected still launches (detection can miss), and its exit code shows the failure.
- **Why:** the doc's selection rules; refusing undetected agents would block users whose CLI detection misses
- **Evidence:** research/orca-features/providers.md "Choose which agent starts"; ~/PycharmProjects/orca/src/shared/tui-agent-selection.ts
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/providers.md

## D20: The prompt reaches the agent the way its entry says, using Orca's builders
- **Question:** prompt delivery per agent
- **Options:** Orca's six modes (`argv`, `flag-prompt`, `flag-prompt-interactive`, `flag-interactive`, `hermes-query`, `stdin-after-start`); a simpler two-mode model
- **Chose:** Orca's six, with `argvPromptSeparator` (`--` for grok, trae, prime-agent). An empty or blank prompt launches with no prompt. A prompt containing NUL is refused. Hermes keeps Orca's `sh -c` wrapper and its 24,000-byte limit, over which the prompt is pasted after start instead of refusing the launch.
- **Why:** the feature doc and the port-as-is rule; the separator stops prompts like `help` or `-x` being parsed as flags (research: copilot-cli #4902, ai.world #483)
- **Evidence:** research/orca-features/providers.md "How the first prompt is delivered"; https://github.com/github/copilot-cli/issues/4902
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by research/orca-features/providers.md

## D21: Paste-after-ready follows Orca's renderer path: a per-agent ready signal, a deadline, then a blind paste reported as unconfirmed
- **Question:** retry-policy and readiness for `stdin-after-start` prompts
- **Options:** Orca's host path (composer wait, then a `tui-idle` wait inside a 60 s budget, which needs m1-term-daemon's idle signal); Orca's renderer path (ready signal or deadline, then blind paste if the agent's process is still in front)
- **Chose:** the renderer path, ported. `quirky.agents` watches the session's output from spawn for the entry's ready signal (default: a quiet window after bracketed paste is enabled; per-agent scanners for opencode, mimo-code, grok, dsh, zcode and codex). The deadline is the entry's `readyTimeoutMs` (8,000 ms default; 20,000 ms for codex, opencode and opencode2). When the signal arrives, the prompt is written as one bracketed paste (CRLF to CR, ESC replaced by `␛`), then Enter as a separate write after `500 ms + ceil(bytes / 4096)` (plus 45 ms per line for antigravity; OMP sends Enter in the same write). codex and qwen-code get one extra Enter 1,200 ms later. If the deadline passes and the session is still running, the prompt is pasted blind and reported `unconfirmed`, except for codex, which reports `not-delivered` and writes nothing. A session that exits or is closed first reports `not-delivered`. Nothing is retried after a paste, so a turn can never run twice.
- **Why:** the host path's idle wait needs a terminal-idle primitive that doesn't exist yet. With exec (D11) the PTY's process is the agent, so "still running" stands in for Orca's foreground-process check.
- **Evidence:** research/orca-features/providers.md "Pasting a follow-up prompt"; ~/PycharmProjects/orca/src/shared/draft-paste-ready-scanner.ts; research: cccc #95, opencode #42915
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** m1-term-daemon's idle signal lands and blind pastes prove common
- **Source:** assumed — autonomous

## D22: The launch result says how the prompt was delivered, on the session record, and `--wait` blocks for it
- **Question:** response-format: how a caller learns whether its prompt arrived (Orca's receipt)
- **Options:** return only after delivery; return at spawn and report later; both, chosen by the caller
- **Chose:** the session record gains `promptDelivery`: null (no prompt), `command-line`, `pending`, `pasted`, `unconfirmed` or `not-delivered`. `create` returns once the process is spawned; a `pending` delivery settles later and emits `quirky.session/changed`. `create` with `waitForPrompt: true` (CLI `--wait`) returns only after it settles.
- **Why:** the window shouldn't wait 20 s for a tab, but a script needs to know. Orca's verified Codex launch lost its prompt with no visible sign; a recorded outcome is the fix.
- **Evidence:** research/orca-features/providers.md "Launching Codex with an initial prompt: prompt not delivered"; Orca receipts `handed-to-terminal`, `not-delivered`, `unconfirmed`
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D23: A draft prompt (left in the input, not submitted) uses a native flag where the agent has one, else paste without Enter
- **Question:** Orca's "unattended draft" launch
- **Options:** leave drafts out; Orca's flag and env-var paths, including the pi and omp extensions; native flag, else paste without Enter
- **Chose:** `create` takes `submitPrompt` (default true). With false, claude and openclaude get `--prefill <text>`; every other agent gets the paste-after-ready path without the Enter. The pi and omp prefill extensions are not built.
- **Why:** M4's "Create from PR" and work-item launches need drafts; the extensions are Orca-installed agent plugins with no consumer yet
- **Evidence:** research/orca-features/providers.md "unattended draft"; research/orca-features/providers.md "Launching Claude with an initial prompt: worked, but the prompt is a draft"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D24: A launch records its command, arguments and environment, and resume replays only those
- **Question:** what resume uses for the agent's command and flags
- **Options:** the current configuration; the configuration recorded at launch (Orca's `launchConfig`)
- **Chose:** each agent session stores the resolved command, the user arguments and the user environment it launched with (not launch-hook additions, which are recomputed). Resume and fork rebuild the command from the record plus the resume argv. A session from before this item has no record and resumes with the catalog command and no arguments.
- **Why:** the doc's rule: current defaults carry the bypass flag, so filling a gap would widen a resumed session. The research's "resume drops the yolo flag" (claude-code #21974) is the opposite failure, which replaying the record also prevents.
- **Evidence:** research/orca-features/providers.md "Argument handling details"; https://github.com/anthropics/claude-code/issues/21974
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by research/orca-features/providers.md

## D25: Resume starts a new session in the original session's folder, from a recorded or given provider session
- **Question:** what `resume` creates and where
- **Options:** respawn the old session ID; a new session; in the original folder or the caller's
- **Chose:** `quirky.session/resume {session, providerSession?, fork?}` creates a new terminal session in the old session's worktree and folder and returns it; the old record is untouched. The provider session comes from the call, else the record. Refused: a `shell` session, an agent with no resume argv, no provider session, an ID that is empty, over 512 characters, starts with `-` or contains control characters, and a folder that no longer exists. Fork works for claude, codex, grok and pi (argv); the agents that fork through a chat protocol are refused.
- **Why:** a new ID avoids the PTY generation fence Orca needs; resuming in the recorded folder avoids the research's top resume failure (claude-code #68525, orca #9361). Orca's menu offers Fork on plain shell panes, which the doc records as a difference; refusing it is the test.
- **Evidence:** research/orca-features/providers.md "Resume and restart handling", "Fork: menu entry seen"; https://github.com/anthropics/claude-code/issues/68525; https://github.com/stablyai/orca/issues/9361
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D26: This item stores the provider session; capturing it from hooks is m1-agent-status
- **Question:** where resume's provider session ID comes from
- **Options:** capture it from Claude and Codex hooks now; add a method that stores it and leave capture to m1-agent-status
- **Chose:** `quirky.session/setProviderSession {session, id, transcriptPath?}` (CLI `quirky session set-provider-session`) stores it, with the ID rules of D25. m1-agent-status calls it from hooks. Until then, a person or script can call it or pass `--provider-session` to resume.
- **Why:** the roadmap lists "capture of each session's provider id and transcript path" under agent status, which depends on this item
- **Evidence:** docs/roadmap.md M1 "Agent status"; docs/loop/queue.json m1-agent-status deps
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D27: Cold-restore resume is left to a later item
- **Question:** Orca types the resume line into a pane whose PTY died across an app restart
- **Options:** build it now (startup reconcile resumes sessions with a provider session); leave it out
- **Chose:** leave it out. Quirky's PTY host outlives the app, so a dead PTY means a reboot or a PTY host crash, and resuming then needs captured provider sessions (D26) and m1-term-daemon's cold restore.
- **Why:** both prerequisites are other items' work
- **Evidence:** docs/architecture.md "Processes"; docs/roadmap.md M1 "Terminal host daemon"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m1-agent-status or m1-term-daemon lands without it
- **Source:** assumed — autonomous

## D28: Workspace trust is pre-written for claude, cursor, copilot, codex, antigravity, qoder and qoder-cn, in the daemon user's home
- **Question:** data-mapping: which trust records are written and where
- **Options:** Orca's seven presets; Claude only; none
- **Chose:** Orca's seven, ported, written just before spawn when `quirky.agents/workspace-trust` is on, for the session's folder. The home is the daemon's `HOME`. A failed write is logged and the launch goes on.
- **Why:** the first-launch trust menu swallows a pasted prompt; the research confirms `--dangerously-skip-permissions` doesn't skip it (cccc #95). Tests start the daemon with a temporary `HOME` so nothing touches the real `~/.claude.json`.
- **Evidence:** research/orca-features/providers.md "Workspace trust"; https://github.com/ChesterRa/cccc/issues/95; docs/loop/LOOP.md "Tests never touch real state"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/providers.md

## D29: `claude-agent-teams` runs Claude with in-process teammates
- **Question:** Orca's `orca claude-teams` opens teammates as native split panes, and Quirky has no splits yet
- **Options:** leave the agent out (44 agents); include it and build native panes; include it with Claude's in-process teammate mode, through a `quirky agents claude-teams` wrapper command; include it with the command and environment in its catalog entry
- **Chose:** include it with the command in its entry: detect `claude`, launch `claude --teammate-mode in-process`, launch environment `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, process `claude`, prompt pasted after start, Claude's permission flags. This is what Orca does on Windows. Native teammate panes wait for splits.
- **Why:** the roadmap asks for all 45; splits are m1-term-ui's. A wrapper command was the first choice, but the tech-spec survey found plugin CLI commands reject unknown flags and cap positionals, so `[claude args...]` can't pass through (packages/cli/src/args.ts:139-145, plugin-commands.ts:17-23).
- **Evidence:** research/orca-features/providers.md "Edge cases: Windows/WSL"; ~/PycharmProjects/orca/src/cli/handlers/core.ts:50-80; ~/PycharmProjects/orca/src/shared/tui-agent-startup.test.ts (in-process env)
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m1-term-ui adds splits
- **Source:** assumed — autonomous

## D30: Settings > Agents becomes an Agents view in the main area, opened from a command
- **Question:** layout-style: where the Agents settings live
- **Options:** fields in the kernel's settings dialog (scalar only); a plugin view
- **Chose:** a `view` contribution, `quirky.agents/settings`, titled "Agents", opened by the command "Open agent settings" and by "Manage agents" in the new-session menu. Same sections as Orca: Default Agent (Auto, then one button per installed enabled agent, and Blank Terminal), Agent Permissions (Manual / Auto / Yolo with Orca's mixed text), Installed (with a count badge and Refresh) and Available to install (count badge). Rows: Enabled switch, Set default / Default (installed only), a Docs or Install link, and an expand chevron for agents with something to edit, showing Permissions, Command, Arguments and Environment (when the agent has a default or an override) with Reset beside overridden fields. Fields save on Enter or blur. The workspace-trust switch sits under a "This Mac" heading.
- **Why:** parity with the verified layout. The settings dialog can't hold a per-agent list.
- **Evidence:** research/orca-features/providers.md "Where to find it", "Settings > Agents, layout and counts"; img/providers/01-agents-settings-top.png
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/providers.md

## D31: Empty and error states of the Agents view
- **Question:** empty-state and error-state
- **Options:** —
- **Chose:** no installed agents: the Installed list says "No agents detected. Install one below, then Refresh." and Default Agent shows only Auto and Blank Terminal. Refresh shows "Refreshing…" while running. A field that fails to save (bad quoting) keeps the typed text and shows the error under the field. A malformed contributed agent appears nowhere in the view (it's in `quirky agents list --all`).
- **Why:** each state names the next action; field errors stay where the user typed
- **Evidence:** research/orca-features/providers.md "Edge cases"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D32: The new-session menu lists Shell, then installed enabled agents in auto-pick order, then "Manage agents"
- **Question:** what the `+` menu offers once there are 45 agents
- **Options:** all 45; installed and enabled ones; a searchable list
- **Chose:** Shell, then the installed enabled agents (default agent first, then auto-pick order), then "Claude (background)" as today, then "Manage agents". Undetected and disabled agents aren't offered.
- **Why:** matches Orca's picker, which shows only installed enabled agents; a search box can come with the Create worktree dialog in m1-worktrees
- **Evidence:** research/orca-features/providers.md "Agent picker in the Create worktree dialog"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by research/orca-features/providers.md

## D33: "New agent tab" is Mod+Alt+T, and each agent gets a "New <Agent> tab" command with no chord
- **Question:** the keybindings the doc lists
- **Options:** —
- **Chose:** command `new-agent-tab` ("New agent tab (default agent)") bound to Mod+Alt+T, and one command per built-in agent, `new-<id>-tab` titled "New <Label> tab", with no default chord. A command for a disabled agent does nothing but show "<Label> is disabled". Agents other plugins contribute get no command; their plugin can declare one. (Amended at tech-spec authoring: the survey found UI commands must be declared in a manifest, packages/ui/src/plugins/host.ts:704-720, which this decision's Revisit-if named.)
- **Why:** the doc's bindings
- **Evidence:** research/orca-features/providers.md "Launch points"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the UI API gains runtime commands
- **Source:** locked by research/orca-features/providers.md

## D34: CLI group `quirky agents`, generated from `quirky.agents` methods, plus session resume commands
- **Question:** flag-design and output-format
- **Options:** —
- **Chose:** `quirky agents list [--all]` (table: ID, LABEL, INSTALLED, ENABLED, DEFAULT, PERMISSIONS, PROMPT, RESUME), `quirky agents get <agent>`, `quirky agents refresh`, `quirky agents enable|disable <agent>`, `quirky agents default <agent|auto|shell>`, `quirky agents configure <agent> [--command ...] [--args ...] [--env KEY=VALUE ...] [--reset command|args|env]`, `quirky agents permissions <manual|auto|yolo> [--agent <id>] [--replace-custom]`, `quirky agents plan <agent> [--prompt ...] [--draft]` (prints the command line and how the prompt would be delivered, without launching). `quirky session new` makes `--agent` optional and adds `--wait` and `--draft`. New: `quirky session resume <session> [--provider-session <id>] [--fork] [--wait]` and `quirky session set-provider-session <session> <id> [--transcript <path>]`. `--json` prints the method result. Exit codes follow the existing CLI's.
- **Why:** each flow in the doc needs a scriptable path; `plan` gives scripts and tests a way to check launch lines without starting a CLI
- **Evidence:** docs/roadmap.md "Everything is scriptable"; docs/loop/decisions/m0-scripting.md D10, D12
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D35: Model and effort options, the ask-question flags, structured launch, accounts and the other host switches are out of scope
- **Question:** scope boundary against neighbouring items
- **Options:** —
- **Chose:** out: session options (m1-launch-settings), Claude's ask-question suppression flags (m2-ask-parity), the terminal-versus-structured choice (M5), account env (m3-accounts), the Create worktree dialog's agent field (m1-worktrees), agent status hooks switch (m1-agent-status), and the host switches for Codex servers, tab titles, keep-awake and the prompt cache timer (their own features). Session history UI (resume buttons, copy resume command) belongs to m3-session-info; this item gives it the API.
- **Why:** each is another queue item's flow
- **Evidence:** docs/loop/queue.json; docs/roadmap.md M1, M3
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/queue.json

## D36: Approach: port Orca's pure launch code into `quirky.agents`, with the catalog as manifest data
- **Question:** brainstorming's 2–3 approaches
- **Options:** (A) a new `quirky.agents` plugin with `agent` contributions, Orca's `src/shared/tui-agent-*` code ported behind them, launch by exec; (B) grow `quirky.session`'s `agents.ts` into a 45-row TypeScript table; (C) a JSON data file read by the plugin, not contributions
- **Chose:** A
- **Why:** B makes adding or replacing an agent a change to a built-in, against the roadmap's override rule. C gives data without the kernel's override and disable machinery. Phase B research supports A's shape: a declared entry should carry enough to list without running code, name its code-backed behavior by a stable ID, and the host must define duplicate and disable rules itself (D7, D8), since VS Code and Eclipse leave them unspecified. On launch, typing into a shell hits macOS's 1,024-byte canonical line limit and needs prompt markers, which exec avoids; exec's cost is that `.zshrc`-only PATH entries are missed (D11, D18).
- **Evidence:** https://code.visualstudio.com/api/references/contribution-points; https://github.com/microsoft/vscode/issues/120369; https://www.eclipse.org/articles/Article-Plug-in-architecture/plugin_architecture.html; https://unix.stackexchange.com/questions/217932/run-zshrc-when-passing-command-via-c; https://dev.to/gabrielanhaia/paste-2000-characters-at-a-line-mode-prompt-and-macos-keeps-1024-blame-the-tty-2hc1
- **Reversibility:** hard
- **Confidence:** medium
- **Source:** assumed — autonomous

## D37: Skip Phase C deep research
- **Question:** brainstorming's optional deep validation of the chosen approach
- **Options:** run one deep-research agent; skip
- **Chose:** skip
- **Why:** the approach is a port of working code that architecture.md already chose to port, so the open risks are in Orca's own source, which the implementers read directly
- **Evidence:** docs/architecture.md "Where the code comes from"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D38: Fast-track the remaining questions with the recommended defaults
- **Question:** brainstorming's essential-coverage gate and fast-track
- **Options:** —
- **Chose:** all six essentials are covered from the roadmap, the feature doc and the code: purpose (start any of 45 agent CLIs the way Orca does, scriptably), consumers (scripts and agents at the CLI, the person at the window, plugin authors), success (each doc flow and defect has a passing CLI or API test), hard constraints (locked decisions; macOS; tests use temporary homes), scope (D35) and primary behavior (pick an agent, build its command, spawn, deliver the prompt). Everything else takes the recommended default, as LOOP.md directs.
- **Why:** LOOP.md treats the user as having elected stated defaults
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D39: The kernel's PTY subscriptions become reference-counted per plugin
- **Question:** prompt delivery must read a session's output, but PTY subscriptions are daemon-global and one plugin's `unsubscribe` stops output for every plugin (tech-spec survey)
- **Options:** read the screen with `pty.read` polling (loses the escape sequences the ready signals need); never unsubscribe (output for every session keeps flowing to the daemon); count subscriptions per plugin in `createPtyApi`
- **Chose:** count per plugin. A plugin's `unsubscribe` reaches the PTY host only when no plugin holds the session; `revoke` drops a plugin's holds by the same rule.
- **Why:** the roadmap grows the plugin API in the milestone that needs it, and the fix is local to `packages/daemon/src/plugins/pty-api.ts`. Without it, `quirky.agents` finishing a delivery would cut off an attached terminal view.
- **Evidence:** packages/daemon/src/plugins/pty-api.ts; packages/pty-host/src/session.ts:205-215; plugins/quirky.terminal/src/terminal.ts:157,229
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D40: Session and agents talk through four `quirky.agents` methods, and `deliver` settles before it returns
- **Question:** the contract between `quirky.session` and `quirky.agents` (tech-spec contracts)
- **Options:** one `launch` method in `quirky.agents` that calls back into `quirky.session` (a dependency cycle, which the kernel rejects); session calls `pick`, `prepareLaunch`, `prepareResume` and `deliver`, and stores what they return
- **Chose:** the four methods. `prepareLaunch` returns the command, environment, launch record, initial delivery and any text to paste, and writes trust. `deliver` resolves with the outcome once settled; `quirky.session` awaits it only when the caller asked to wait, and records the outcome either way.
- **Why:** `quirky.session` depends on `quirky.agents`, so `quirky.agents` can't call back without a cycle (registry.ts marks cycles invalid). The methods are public and schema'd like any other, which also lets a script call `plan` without launching.
- **Evidence:** packages/daemon/src/plugins/registry.ts:48-124 (cycle check)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a plugin-to-plugin call has a dispatch timeout shorter than a 20 s delivery
- **Source:** assumed — autonomous

## D41: Tests control detection and timing with two environment knobs and a fake login shell
- **Question:** how e2e tests keep real agent CLIs out and avoid 20-second waits
- **Options:** run against the real machine's PATH; put fakes in `$QUIRKY_HOME/bin`; a fake login shell plus `QUIRKY_AGENT_SEARCH_DIRS` and `QUIRKY_TEST_AGENT_TIME_SCALE`
- **Chose:** the knobs and the fake shell. The fake `<tmp>/shells/sh` drops `-l` so macOS's `path_helper` can't put `/usr/local/bin` (where a real `claude` may live) ahead of the fakes; `QUIRKY_AGENT_SEARCH_DIRS` replaces the install-directory list; `QUIRKY_TEST_AGENT_TIME_SCALE` scales every delivery timer. The daemon runs as a subprocess with a temporary `HOME`, so trust writes land in the temp home.
- **Why:** a test that finds the developer's real `claude` would launch it; LOOP.md forbids touching real state; `QUIRKY_TEST_ENTER_DELAY_MS` is the existing precedent for a test timing knob
- **Evidence:** packages/daemon/test/startup.test.ts:96-145; packages/daemon/test/shell-path.test.ts:49-60; docs/loop/LOOP.md "Tests never touch real state"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D42: One Codex adversarial review covers both specs and stands in for the tech-spec reviewer
- **Question:** the tech-spec rubric dispatches its own reviewer; LOOP.md asks for one adversarial review of both specs
- **Options:** run both reviews; run the adversarial review only
- **Chose:** the adversarial review only, with the tech-spec reviewer's checks (pointer precision, fidelity to Decisions Locked, back-links, the no-code rule, contract completeness, buildability) added to its criteria
- **Why:** LOOP.md replaces the spec review with one pass; folding the rubric's checks in keeps what the reviewer would catch
- **Evidence:** docs/loop/LOOP.md step 4; quirk:writing-specs tech-spec.md "After authoring"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D43: An agent found only in an install directory launches by its absolute path
- **Question:** Codex spec review F1: detection searches install directories that the launch shell's PATH may not include, so an auto-picked agent could fail with "command not found"
- **Options:** add the install directories to PATH at launch (PATH is reserved and rewritten by the kernel); drop the install directories from detection; resolve the executable to its absolute path when it was found only there
- **Chose:** resolve. The plan replaces the leading executable token with its absolute path when detection found it only in an install directory; the launch record keeps the bare name so a resume resolves again.
- **Why:** "installed" must mean "the launch will find it" (D18), and changing the kernel's PATH handling is fenced (D11)
- **Evidence:** packages/daemon/src/launch.ts:50-53; Codex spec review round 1 F1
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D44: Spec review findings dismissed
- **Question:** which Codex spec-review findings are not fixed
- **Options:** —
- **Chose:** dismissed F9 (the pre-pass wants a "Purpose" or "Overview" heading; the logic spec's "Conceptual model" holds that content and the user's writing rules forbid "Overview" headings) and F10–F53 (the pre-pass flags method names, contribution IDs, command examples and file names the specs plan to create, and the link to `research/orca-features/providers.md`, which lives in the local-only research repo, not this worktree, as every earlier spec's links do). Accepted and fixed: F1 (D43), F2, F3, F4, F5, F7, with an amendment in logic.md.
- **Why:** none of the dismissed ones names a defect in the design
- **Evidence:** /Users/zpyoung/CLAUDE.md "Writing"; docs/roadmap.md links to ../research/orca-features/
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D45: Build with Claude subagents implementing and Codex reviewing
- **Question:** subagent-driven development's preflight backend pairing
- **Options:** claude-task + codex; claude-task + gemini; pi-codex + opus
- **Chose:** claude-task + codex (Sonnet implementers and fixers, Codex reviewers through quirk:adversarial-review). `pi-watch --check codex` and `--check gemini` both passed; gemini is the tiebreak family.
- **Why:** LOOP.md names this pairing
- **Evidence:** docs/loop/LOOP.md step 5
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D46: Wave 1 implementation choices accepted as built
- **Question:** choices the wave 1 implementers made where the briefs were silent (subagent-driven development, wave 1 audit)
- **Options:** accept; send back
- **Chose:** accept: (a) the kernel test `context-growth.test.ts` "revoking a plugin removes its listeners" now subscribes its second plugin too, because it asserted the old shared-subscription behavior that D39 replaces (K1's scope widened by that one line); (b) no agent has an `install` URL, because Orca's catalog has only homepage links, so the Agents view's Install link uses the homepage; (c) quoting uses Orca's fish-safe splice and always single-quotes prompts; (d) the ready scanners keep Orca's 1,500 ms quiet window and 5,000 ms OpenCode grace; (e) the Claude trust writer creates `~/.claude.json` when missing, refuses to trust a filesystem root, the home or a folder above it (Orca's guard), and a corrupt config throws instead of being skipped; (f) Codex trust goes to `~/.codex/config.toml`, ignoring `CODEX_HOME`, as Orca does; (g) applying Yolo to an untouched agent stores the flag explicitly.
- **Why:** each matches Orca or the logic spec, and none changes a scenario's Then
- **Evidence:** wave 1 reports (journal); ~/PycharmProjects/orca/src/main/agent-trust-presets.ts; packages/daemon/test/plugins/context-growth.test.ts:180
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D47: Trust writes skip the real home in test runs, after one test run wrote to it
- **Question:** a wave 2 test set `process.env.HOME` to a temp dir and expected trust writes to land there, but Bun's `os.homedir()` ignores `$HOME`, so one run wrote trust entries for `/tmp/qag-*` folders into the real `~/.codex/config.toml` and `~/.claude.json`
- **Options:** fix the one test; read `$HOME` first and also refuse the real home during `bun test`; set a temp `HOME` for every test through a Bun preload
- **Chose:** the service reads `$HOME` before `os.homedir()`, and skips the trust write (with a log line) when `NODE_ENV` is `test` and the home is the real one; e2e daemons run as subprocesses with a temporary `HOME`. The stray entries (one Codex section, six `~/.claude.json` project keys, all `qag-` temp paths) were removed by hand, and nothing else in those files was changed. `packages/cli/test/v1-words.e2e.test.ts` no longer launches an agent with the real built-ins.
- **Why:** LOOP.md forbids touching real agent state; a preload changing `HOME` for every test would also change git identity for the protected loop scripts' tests
- **Evidence:** wave 2 B1a report; `bun test` sets `NODE_ENV=test` (checked); plugins/quirky.agents/src/service.ts trustFolder
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another in-process test path writes under a user home
- **Source:** assumed — autonomous

## D48: Review rounds: what was accepted, rejected and fixed
- **Question:** subagent-driven development's checkpoint reviews (after waves 1 and 2) and Final Round 1, all with Codex reviewers
- **Options:** —
- **Chose:** wave 1 checkpoint: accepted a Codex TOML multiline-value corruption, a subscribe-failure race that erased another hold, and a login-PATH read that hung past its timeout; rejected the claim that env-only agents (goose) with custom arguments must count as custom, because Orca treats only goose's environment as its permission state. Wave 2 checkpoint: accepted eight findings (delivery waiting forever on a stalled subscribe, its deadline not armed until subscribe returned, a paste attempt after a pre-spawn exit, a provider session overwritten by the launch's own write, two default-agent edge cases). Final Round 1 (deep, non-test source because the full 740 KB diff exceeds a lens's budget): accepted `opencode run` overrides getting `--prompt` instead of a message, a stalled liveness check leaving delivery pending, Codex trust writing invalid TOML into inline-table configs (now refused, file untouched), and the open new-session menu not following catalog changes; plus one found by the e2e suite, hook arguments landing after a user `--`. Every accepted finding was fixed with a regression test that failed before the fix; none is left open, so nothing goes to BLOCKERS.md.
- **Why:** LOOP.md runs one final round and one fix batch
- **Evidence:** run journal (checkpoint and final digests); fix commits e97f807, the G1/G2 merges, the H1-H4 merges
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D49: The UI scenarios passed in the web window; one visual defect was fixed
- **Question:** LOOP.md step 6's UI check with quirk:using-apps-like-a-user (`--surface web --owner yours --unattended`)
- **Options:** —
- **Chose:** ran it against a built daemon on a temporary home with fake claude, codex and goose. All six goals passed: SC-39 (sections and counts), SC-43 (menu, Manage agents, palette commands), SC-9 (Cmd+Option+T opened a Claude tab), SC-40 (Manual, custom arguments, Replace with Yolo; Goose's Environment confirmed in the accessibility tree just below the fold), SC-41 (disable Codex), SC-42 (Refresh picked up a newly installed gemini; the brief "Refreshing…" label and the empty state are covered by unit tests). The run found that the selected Manual/Auto/Yolo segment wasn't visually highlighted (an inline style hid the `active` class); fixed with a test. Report: `.quirk/using-apps-like-a-user/runs/20261026T234451-c11b/report.md` (local, ignored). The daemon was stopped and its temporary home removed.
- **Why:** the logic spec's window scenarios must pass when used like a user
- **Evidence:** the run report; plugins/quirky.agents/src/window/controls.tsx
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D50: No native-only scenarios
- **Question:** LOOP.md step 6: scenarios only the real window can show go to docs/loop/native/<id>.json
- **Options:** —
- **Chose:** none. Every window scenario of this item lives in the webview (the Agents view, the menu, palette commands and their chord), which the web pass covers; no tray, menu bar, OS dialog or notification is involved.
- **Why:** the native file is for what the web surface can't show
- **Evidence:** logic.md "The window"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Progress
Done. Waves 1-3 built with checkpoint fix batches after waves 1 and 2; Final Round 1 and its fix batch merged; the web UI pass passed all six goals (D49). Verify: `bun run test` 2670 pass, `bun test scripts` 30 pass, `bun run typecheck` clean; every SC-1..SC-43 has a named test; the Orca defects (SC-23, SC-35) have tests; `quirky.agents` uses only the public plugin API and ships its methods and `quirky agents` CLI group. Nothing left open in BLOCKERS.md.
