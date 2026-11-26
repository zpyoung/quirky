# Agent-drivable Quirky: one public CLI and API surface

**Status:** Draft

## Status & amendments

**Amendments:** none yet.

## Conceptual model

Any agent can drive Quirky through one public surface: an agent running in a Quirky terminal, the central brain chat, a remote environment, mobile, or a plain script. The surface works the same over the local socket and over a paired WebSocket. Every mutation records who made it.

The surface comes from three sources of truth that already exist:

1. **RPC methods.** These are the ~350 zod-typed `defineMethod` definitions. In-scope methods get _public metadata_: a CLI path, a result schema, a stability tier (`stable` or `unstable`), a destructive flag with an effects previewer, and the error codes the method can raise. A method without public metadata must be marked `internal: true`.
2. **App actions.** These are the ~94 keybinding action ids handled by `dispatchAppCommand` in the renderer. Each gets a description, an availability check and a destructive flag. They are exposed as data, not as one command per action.
3. **The event bus.** Main-process events go into a bounded replay buffer, each with a sequence number. The events cover chat turns, UI focus and tabs, notifications, workspace and terminal lifecycle, settings changes, and the activity trail.

Everything an agent touches is derived from those three:

- **Generated CLI commands.** Hand-written commands take precedence where the generic shape is clumsy.
- **`quirky schema`** describes commands.
- **`quirky rpc`** is the unstable escape hatch.
- **`quirky action list/run`** reaches the app actions.
- **`quirky events`** and `--wait` report what happened.
- **The coverage check** fails CI when a method or action has no public path and isn't marked internal or UI-only.

## Data flow

**A public method call.** The CLI resolves the command, generated or hand-written, and validates flags against the method's schema locally. A usage error exits 2 without contacting the app. The request travels over the socket, or a paired WebSocket for remote calls, and carries the caller's identity. Agent terminals carry their session and workspace identity in the environment, so attribution needs no flag.

The dispatcher first checks that the runtime advertises the method's capability, because older runtimes must fail clearly rather than obscurely. Next, if the method is destructive and `--yes` is absent, the effects previewer runs. The call then returns `needs_confirmation` with the effects and the confirm command, and nothing runs. With `--yes`, the approval category setting decides whether the call runs now or raises a Quirky approval prompt that the CLI waits on. When the method runs, the mutation is attributed in the activity trail, its event is published to the bus, and the result returns.

**An app action.** Main forwards the request to the renderer, which runs `dispatchAppCommand(id, 'cli')`. The handler either acts, or reports why it didn't, so the agent gets `ok` or `unavailable` with reason `not_applicable`. A headless host has no renderer, so UI calls there return `unavailable` with reason `no_ui`.

**Waiting.** `--wait` subscribes to the bus for the object it started and returns when that object settles. `quirky events` streams NDJSON from the bus, starting after any cursor still in the buffer. When the cursor is too old, the stream opens with an `events.gap` event.

## Key decisions & rationale

- **The contract lives on the RPC methods.** The alternatives were hand-written handlers and a separate facade. Putting metadata on the existing methods gives the CLI, schema, escape hatch and coverage check one source, so they can't drift. It also follows the repo's reuse-before-reimplementing rule. A facade would duplicate ~350 definitions, and hand-written coverage drifts.
- **Hand-written commands win over generated ones.** Generated shapes are fine for most methods, while chat and tab commands deserve positionals and terse output.
- **Discovery is on demand.** One line per command, then full JSON Schema for the command an agent asks about. Loading every tool description up front costs thousands of tokens per session.
- **Every app action is reachable generically, and structured results get typed commands.** `action run` alone can only say whether it acted, so `ui state`, `tab list` and similar commands return data.
- **`quirky rpc` reaches every method, labeled unstable.** It covers "anything" from day one, including git and PR before those get typed commands.
- **Output is text by default, with JSON on request.** `--json` or `QUIRKY_OUTPUT=json` switch to JSON, and Quirky sets the variable in the terminals it launches agents in, so existing text-parsing scripts keep working. JSON results are terse by default, and `--full` returns whole objects.
- **Events come as a stream plus waits.** The brain watches everything through one stream, and one-shot scripts use `--wait`.
- **Destructive calls preview and then confirm.** Telling an agent "never run destructive commands" in its prompt doesn't stop it, so the tool gates instead. The preview doubles as a dry run.
- **Access stays full, with every mutation attributed.** Scoped tokens would break orchestration's cross-workspace work, and attribution leaves a place for them later.
- **One fixed exit-code table and about 8 stable error codes.** Agents branch on the exit code without parsing, and the specifics go in `reason`.

## Behavior & scenarios

1. **SC-1 The brain fans out chat work and answers a permission request**
   - **Given** the brain is watching `quirky events --topic chat`, and permission answers are set to _Agent may confirm_
   - **When** it sends prompts to three sessions and one of them asks for permission
   - **Then** each send returns a turn id at once; a `turn.needs-input` event arrives for that session; `quirky chat respond` answers it; the activity trail records the answer as made by the brain
   - **Data before:** **Session s-7*** idle; **Session s-8*** idle; **Session s-9*** idle
   - **Walkthrough:**
     1. The brain runs `quirky chat send s-7 "run the tests"`, then the same for s-8 and s-9
     2. Each call returns at once: `{turnId: "t-41"*}` and so on
     3. The stream prints `{"seq":4120*,"topic":"chat","type":"turn.needs-input","session":"s-9","request":"r-2"*}`
     4. The brain runs `quirky chat respond s-9 r-2 --allow`
   - **Data after:** **Session s-9**: ✓ permission r-2 allowed, turn continues; **Activity trail**: ✓ "brain allowed a permission request in s-9"

2. **SC-2 An agent inside Quirky tidies its own UI**
   - **Given** an agent in a worktree terminal, where Quirky has set `QUIRKY_OUTPUT=json`
   - **When** it reads the UI state and closes that workspace's browser tabs
   - **Then** it gets JSON without passing `--json`; the browser tabs close; the trail credits that agent
   - **Data before:** **Workspace fix-123***: 4 tabs*, of which 2 are browser tabs*
   - **Walkthrough:**
     1. The agent runs `quirky ui state`, which returns the focused workspace fix-123 and focused tab "terminal 1"*
     2. The agent runs `quirky tab close --type browser --workspace .`
   - **Data after:** **Workspace fix-123**: ✓ 2 tabs remain; **Activity trail**: ✓ "agent in fix-123 closed 2 tabs"

3. **SC-3 An agent tries to delete a workspace**
   - **Given** workspace delete is set to _Ask me_
   - **When** an agent runs the delete action, first without `--yes`, then with it
   - **Then** (a) without `--yes` nothing runs; it exits 4 with the effects and the confirm command; (b) with `--yes` a Quirky approval prompt appears; if the user declines, the call exits 4 with reason `declined` and the workspace stays
   - **Data before:** **Workspace old-spike***: 3 uncommitted files*
   - **Walkthrough:**
     1. The agent runs `quirky action run worktree.delete --workspace old-spike`
     2. The output is `needs_confirmation`, effects "delete workspace old-spike; 3 uncommitted files lost", confirm `... --yes`
     3. The agent runs the confirm command, and the user sees the approval prompt and declines
   - **Data after:** **Workspace old-spike**: ✓ unchanged; **CLI result**: ✗ `needs_confirmation`, reason `declined`, exit 4

4. **SC-4 An action with nothing to act on**
   - **Given** no tab has focus in workspace X
   - **When** an agent runs `quirky action run tab.close`
   - **Then** it exits 6 with `unavailable`, reason `not_applicable`, and a message naming what was missing; `quirky action list --available` would have left `tab.close` out
   - **Data before:** **Workspace X***: no focused tab
   - **Walkthrough:**
     1. The agent runs `quirky action run tab.close --workspace X`
   - **Data after:** **CLI result**: ✗ `unavailable`, reason `not_applicable`, "no focused tab in workspace X", exit 6

5. **SC-5 A headless host, and an older runtime**
   - **Given** (a) a `quirky serve` host with no window; (b) a runtime that predates `settings.get` having public metadata
   - **When** an agent calls `quirky ui state` against (a), and `quirky settings get editor.fontSize` against (b)
   - **Then** (a) exits 6 with reason `no_ui`, while chat, settings, files and events still work there; (b) exits 6 with reason `capability_missing` and a `next` step to update that runtime
   - **Data before:** **Host serve-1***: headless; **Host old-1***: older runtime
   - **Walkthrough:**
     1. `quirky --environment serve-1 ui state`
     2. `quirky --environment old-1 settings get editor.fontSize`
   - **Data after:** **Result 1**: ✗ `unavailable`, reason `no_ui`; **Result 2**: ✗ `unavailable`, reason `capability_missing`, next "update the runtime on old-1"

6. **SC-6 An agent restarts mid-run**
   - **Given** the replay buffer holds events from seq 5000* onward
   - **When** a restarted agent runs `quirky events --after 4120`
   - **Then** the first event is `events.gap`; the agent re-reads state with `chat list` and `ui state`, then keeps streaming
   - **Data before:** **Replay buffer**: seq 5000* to 5310*
   - **Walkthrough:**
     1. The agent runs `quirky events --after 4120 --topic chat`
   - **Data after:** **Stream**: ✓ `{"type":"events.gap","from":4120,"oldest":5000}`, then live events

7. **SC-7 Discovering a command cheaply**
   - **Given** an agent that doesn't know how to answer a chat permission request
   - **When** it lists commands, then asks for one schema
   - **Then** the list prints one line per command, and the schema returns params, result, stability, destructive flag and error codes
   - **Data before:** none
   - **Walkthrough:**
     1. `quirky schema | grep chat`
     2. `quirky schema chat respond --json`
   - **Data after:** **Output**: ✓ `chat respond  Answer a permission request or question in a chat session`; ✓ the schema lists params session, request and one of allow, deny or answer; the result is the updated turn status; stable; destructive no; errors not_found, conflict, needs_confirmation

8. **SC-8 The coverage check catches a new unexposed action**
   - **Given** a developer adds a new app action or RPC method with no public metadata and no internal or UI-only mark
   - **When** CI runs
   - **Then** the coverage check fails and names the method or action

## Result and error contract

The JSON envelope keeps today's shape, `{id, ok, result | error, _meta}`.

| Exit | Error code                               | Meaning                                                             | `next` required |
| ---- | ---------------------------------------- | ------------------------------------------------------------------- | --------------- |
| 0    | none                                     | ok                                                                  | no              |
| 1    | `internal`                               | unexpected failure                                                  | no              |
| 2    | `invalid_argument`                       | bad flags, params or schema                                         | no              |
| 3    | `not_found`                              | session, tab, workspace, setting or file missing                    | yes             |
| 4    | `needs_confirmation`                     | destructive call without `--yes`, or approval declined or timed out | yes             |
| 5    | `conflict`                               | stale state or a concurrent change                                  | yes             |
| 6    | `unavailable`, `timeout`, `unauthorized` | app down, capability missing, `no_ui`, `not_applicable`             | yes             |

`error.data.reason` carries the specific cause. `error.data.next` is a list of `{command, why}`. Today's ad hoc codes map onto this set. A new CLI normalizes codes from an old runtime. An old CLI against a new runtime still sees exit 1 and the message.

## Command surface (first version)

- **Discovery:** `quirky schema [command]`, `quirky rpc list`, `quirky rpc <method> --params '{...}'`
- **UI:** `quirky ui state`; `quirky tab list|focus|close|move|pin` for every tab type; `quirky layout get|apply`; `quirky action list [--available]`; `quirky action run <id> [--workspace X] [--yes] [--wait]`
- **Chat:** `quirky chat list|create|resume|send|cancel|rewind|history`; `quirky chat options get|set`; `quirky chat respond <session> <request> --allow|--deny|--answer`
- **Admin:** `quirky settings get|set|list`; `quirky notifications list|dismiss`; `quirky plugins list|enable|disable|run`; `quirky file list|read|write|search`. File commands go through the runtime, so they work on remote hosts and in folder workspaces.
- **Events:** `quirky events [--topic chat,ui,notifications,workspace,activity] [--after <cursor>] [--until <type>]`

Existing families such as terminal, browser and orchestration keep their handlers and gain the error and exit contract.

## Safety and what the user sees

- **Approval categories.** These live under Settings → Agents → Approvals: workspace delete, file overwrite or delete, chat discard or rewind, permission answers, and security-relevant settings. Each is set to _Agent may confirm_, the default, or _Ask me_.
- **Activity trail.** It lives in the existing notifications and activity area. It lists every attributed mutation, grouped by caller and filterable by workspace. Read-only calls aren't logged. The trail is also the `activity` event topic.
- **Markers.** A tab an agent opened or focused shows a caller marker for a few seconds. A setting an agent changed stays marked until the user views it. There are no toasts.
- **Approval prompts** use the existing ask-prompt UI. They are the only interruption.

## Scope & non-goals

**In scope:**

- public-method metadata and the generated CLI
- `schema`, `rpc` and `action`
- UI state, tabs and layout
- chat, at full reach
- settings, notifications, plugins and files
- `events` with replay
- the error and exit contract across all commands
- preview-then-confirm and the approval categories
- attribution and the activity trail
- the coverage check
- a scripted agent scenario that runs without computer use

**Success criteria:**

- The coverage check passes in CI. Every in-scope method and every app action is public, internal, or UI-only.
- A scripted agent completes this flow through the CLI alone, with no computer use: open a workspace, read the UI state, send a chat and wait, answer a permission request, change a setting, close tabs, and observe the matching events.

**Non-goals:**

- replacing computer use for native apps outside Quirky
- pixel-level UI driving
- Windows and Linux

## Decisions Locked

**Scope**

- First-version coverage: UI state, layout and actions; settings, notifications, plugins and files; agent chat. Git and PR are deferred.
- Primary consumer: inside and outside agents equally (local socket, brain chat, remote, mobile).
- Chat reach is full: create or resume, send, cancel, rewind, history, options, and answering permission requests and questions. Permission answers follow the approval setting.

**Discovery**

- `quirky schema` gives a one-line list, and `quirky schema <command>` gives JSON Schema for params and result, generated from zod.
- The generic `action list` and `action run` cover all app actions, and typed commands cover structured state.
- `quirky rpc <method>` reaches every method and is labeled unstable.
- Output switches to JSON with explicit `--json`, and `QUIRKY_OUTPUT=json` is set automatically in agent terminals.

**Events**

- The model is a `quirky events` NDJSON stream with `--topic` and `--after`, plus `--wait` on slow commands.
- Topics: chat turn lifecycle; UI focus, tabs and layout; notifications; workspace and terminal lifecycle and settings changes.
- Missed events replay from a bounded buffer by seq cursor. An explicit `events.gap` marks a cursor that's too old.
- `chat send` returns at once with a turn id, and `--wait` blocks until the turn finishes or needs input.

**Safety**

- Without `--yes`, a destructive call runs nothing and returns `needs_confirmation` with its effects and the confirm command.
- The agent's `--yes` is enough by default. A per-category setting can require user approval in Quirky instead.
- Access stays full, and every mutation is attributed to its caller.
- User visibility comes from the activity trail plus brief markers. There are no toasts.

**Errors**

- Exit codes: 0 ok, 1 general, 2 usage, 3 not found, 4 needs confirmation, 5 conflict, 6 unavailable.
- About 8 stable error codes, with specifics in `reason`. Legacy codes keep working through the compat window.
- `next: [{command, why}]` is required for not_found, needs_confirmation, conflict and unavailable.
- An action that doesn't act exits 6 with reason `not_applicable`.

**Constraints and success**

- Works locally and remotely alike. Headless hosts return `no_ui`, and older runtimes return `capability_missing`.
- Done means the coverage check passes and the scripted agent scenario runs.

**Approach and process**

- Approach: annotated RPC methods with a generated CLI, where hand-written commands take precedence.
- UX review: skipped, because the only new UI is the activity trail in the existing notifications and activity area.

## Industry Insights

- **Generic invoke-by-id registries usually stay internal.** The outward contract is typed and schema-described, with confirmation metadata. Sources: VS Code commands and LM tools (https://code.visualstudio.com/api/extension-guides/ai/tools), Raycast tools (https://developers.raycast.com/api-reference/tool.md), MCP tools spec (https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
- **tmux control mode is the reference event model.** It interleaves notifications with replies and lets subscribers rate-limit. Source: https://github.com/tmux/tmux/wiki/Control-Mode.
- **Loading tools on demand saves tokens.** Naive schema loading costs an estimated 2k to 55k tokens per session, against about 170 when descriptions load on demand. Full-object responses cost many times more than terse ones. Sources: https://arxiv.org/html/2610.30157, https://www.reddit.com/r/ClaudeAI/comments/1y4lvbf/.
- **Prompt rules don't stop destructive commands. Gating in the tool does.** Arcjet returns a confirmation envelope with exit 4. Elastic requires `--yes` and offers `--dry-run`. Sources: https://arcjet.com/blog/designing-a-cli-for-ai-agents, https://www.elastic.co/search-labs/blog/elastic-cli-ai-agents, https://www.techrepublic.com/article/ai-agent-deletes-company-database-admits-violating-guardrails/.
- **Generated CLIs work when hand-written overrides sit in a separate layer that wins.** Positionals need an explicit mapping rule. Sources: https://raw.githubusercontent.com/stripe/stripe-cli/HEAD/ARCHITECTURE.md, https://rest.sh/blog/turn-an-openapi-spec-into-a-cli-without-generating-code/.
- **Hand-written wrappers drift in coverage.** One sweep found 173 unwrapped operations. The defenses are a coverage gate, a raw escape hatch and a version handshake. Sources: https://github.com/hadron-memory/hadron-cli/issues/1334, https://cli.github.com/manual/gh_api, https://docs.docker.com/reference/api/engine/.
- **A public facade pays off mainly for unnamed third parties.** It costs a layer that has to be kept in sync. Sources: https://stripe.com/blog/api-versioning, https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer.

## Deferred Ideas

- Typed git, PR and review commands. `quirky rpc` covers them as unstable until then.
- A `quirky mcp` endpoint built from the same metadata.
- Scoped tokens and capability grants per caller.
- A durable event log that survives app restarts.
- Keybinding remapping, and ports, usage and stats commands.
- Migrating terminal, browser and orchestration onto generated metadata.
- `[tech-spec]` Where the public metadata sits on `defineMethod`, and how generated commands are registered alongside `COMMAND_SPECS`.
- `[tech-spec]` How the main process forwards app actions to the renderer and gets back claimed or reason. This needs a new `'cli'` dispatch source.
- `[tech-spec]` Replay buffer size and retention, and how the unix-socket transport carries streams, given that streaming exists today only on WebSocket.
- `[tech-spec]` How caller identity reaches the dispatcher from agent terminals, remote and mobile.

## Glossary

- **Public method:** an RPC method with public metadata. It's reachable as a CLI command and listed in `quirky schema`.
- **Stable / unstable:** stable methods keep the mixed-version compat guarantee, meaning additive changes only, with a deprecation window. Unstable methods may change between versions.
- **App action:** a renderer command id, such as `tab.close`, run by `quirky action run`.
- **Caller:** who made a call: an agent session in a workspace, the brain, a remote environment, mobile, or a script.
- **Effects preview:** the concrete list of what a destructive call would do. It's returned instead of running when `--yes` is absent.
- **Approval category:** a group of destructive operations, with a setting for whether an agent's `--yes` is enough.
- **Cursor:** an event sequence number. Replay starts after it.
