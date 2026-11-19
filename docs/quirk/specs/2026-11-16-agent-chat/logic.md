# Agent chat with agent-drawn views

## Status & amendments
Status: Approved 2026-11-16 in the brainstorm companion. SC-5 (Restart on an agent that can't resume) is still open. Tech spec: authored (tier gate fired: crosses subsystems), see tech.md.

**Amendments:**
- 2026-11-19, visual panel in native chat: SC-13's default changes. A view opened with no placement now lands in the pane instead of inline; an agent can still ask for `inline`, and the Move control is unchanged. See [the visual panel spec](../2026-11-19-chat-visual-panel/logic.md) (SC-17).

## Purpose
Run Claude Code, Codex, pi and omp sessions from one chat view in the Quirky desktop app, with tool output, questions and agent reports shown as real UI instead of raw text. It replaces the raw structured transcript (`plugins/quirky.session/src/window/StructuredView.tsx`) inside the session tab.

The reader of this spec is the person approving what gets built. The tech spec, written at execution, owns where the code lives and its contracts.

## Conceptual model
A **session** is one agent conversation in one worktree. Its transcript is a list of **turns**. A turn starts with your message and holds what the agent did in reply, in order:

- **Prose**: the agent's text, as markdown.
- **Activity**: tool calls that only read or ran something, folded into one line per run.
- **Cards**: things that changed something or that you need to see, drawn by Quirky from the agent's tool calls. File change, Test results and Steps cards come from every agent.
- **Asks**: an approval or a question the agent is waiting on.
- **Views**: UI the agent drew on purpose with `quirky view`.
- **Changes**: the closing card listing what the turn changed in git.
- **Errors**: the agent process exiting or a view failing checks.

Quirky draws the cards for every agent without the agent knowing. Views are the opposite: the agent asks for them. Both use Quirky's own components, so they look like the rest of the app.

Each agent declares what it supports (steer, plan mode, permission modes, images, effort, approval for a session). The chat shows the same controls for every agent and disables the ones an agent lacks, with the reason.

## Data flow
1. You type in the composer and send. The message goes to the session's agent through its native channel: the Claude Agent SDK for Claude Code, app-server for Codex, and JSONL RPC for pi and omp.
2. The agent's events stream back. Quirky turns each event into a turn item (prose, activity, card, ask, view, error) and appends it to the session journal, so everything comes back after a restart.
3. An ask is also registered with the existing Questions panel and the status bar's needs-you count. Your answer, from either place, goes back to the agent's approval API.
4. When the agent runs `quirky view open|update|close`, the daemon checks the view against the catalog. A valid view is journaled and shown. An invalid one is refused, and the error is printed back to the agent.
5. A click on a view button becomes an action. It is the result of a pending `quirky view wait`, or else a follow-up message to the agent.
6. When the turn ends, Quirky reads git for the files that turn changed and adds the changes card. Line comments on it join the existing notes, and Send delivers them as one message.

## Key decisions & rationale
- **Our own catalog plus a `quirky view` command,** chosen over adopting json-render with fenced specs in replies, and over MCP Apps or A2UI first. A command works for all four agents because all four can run a shell command. The daemon can check a view before anything renders and send errors back for a retry. The agent pays for the catalog guide only when it runs `quirky view --help`, never on every turn.
- **No json-render or OpenUI dependency.** Both are pre-1.0. OpenUI sends telemetry at install. json-render's checks are opt-in, skip props for catalogs with more than one component, and its events carry no payload.
- **MCP Apps HTML views are out of v1.** Only Codex passes the link through today, and HTML sandboxes in desktop hosts have been escaped. They stay a later option for third-party MCP servers.
- **Cards come from the tool stream, not from the agent.** They cost no tokens, work on every agent, and can't be wrong about what a tool did.
- **The agent picks where a view opens,** and you can move it. You chose this over always-inline and always-pane.
- **Approvals show inline and in the Questions panel, never as a dialog,** so answering doesn't interrupt reading or typing.

## Decisions Locked

**Scope**
- Chat comes into scope for the desktop app. The implementation amends `BRIEF.md`, `docs/architecture.md` and `docs/roadmap.md`, which drop native chat today (see Scope & non-goals).
- All four agents in v1: Claude Code, Codex, pi, omp. macOS desktop only.

**Layout and density**
- The chat replaces the structured transcript inside the existing session tab. The app shell does not change.
- The transcript is grouped by turn, at Quirky's compact 12px density.
- Tool activity folds into one-line groups that expand. Edits, test runs and the agent's todo list become cards. (Your pick.)

**Streaming and working**
- Text streams. Cards appear when their tool call starts, show running, then fill in.
- Views render only after the whole view passes checks.
- While a turn runs, the composer shows elapsed time and Stop.
- Enter queues a message until the turn ends, with Steer now where the agent supports it. (Your pick.)

**Empty and error states**
- A new chat shows the four agents with their default model and readiness. One that isn't ready says why.
- An agent exit shows an inline row with the last stderr lines, Restart and Open in terminal. The transcript is kept.

**Approvals and questions**
- Inline in the transcript and in the Questions panel; answering either clears both. (Your pick.)
- Approval actions: Allow once, Allow for this session, Deny with an optional reason.
- Agent questions use the `quirky ask` field types.

**Agent-drawn views**
- Drawn with `quirky view open|update|close|wait`; the catalog guide is served by `quirky view --help`.
- Built only from Quirky's catalog: stack, columns, section, markdown, key-value list, table, stat, status list, steps, code, file diff, bar and line charts, callout, button, and the `quirky ask` field types.
- The agent picks inline or the Views pane per view; inline when it doesn't say. You can move any view either way, and your move holds. (Your pick.)
- Buttons and fields send an action back to the agent.
- No agent code, no network, sanitized markdown, links ask first, a "by <agent>" tag on every view.
- Views are saved in the session journal.

**Review loop**
- A changes card closes each turn that changed files, with inline diffs and line comments that join the existing notes.

**Composer**
- Agent chip, model, permission mode, plan toggle, attachments, `@file` mentions. Unsupported controls stay visible, disabled, with the reason on hover.
- Slash commands are not in v1.

**Success criteria** (your picks)
- The common loop (prompt, watch, answer, review) never needs the terminal.
- Anything waiting on you shows inline and in the status bar.
- Agent views either render or fail visibly with their source.

**UX review:** signed off at mock v2 with no pins.

## Screens
The signed-off mock is [mock/mock.html](mock/mock.html), and the inventory with components and gaps is [mock/screens.md](mock/screens.md). The mock is the visual target. Execution rebuilds it with `@quirky/ui` and never lifts mock code.

Acceptance, one item per screen and state:

- [ ] Chat session, default: matches mock. A finished turn shows prose, a folded activity line, File change and Test results cards, a Steps card and a changes card.
- [ ] Chat session, working: matches mock. Elapsed time and Stop show, and a queued message waits above the composer with Steer now.
- [ ] Chat session, empty: matches mock. Four agent cards with default model and readiness.
- [ ] Chat session, error: matches mock. Inline exit row with stderr lines, Restart and Open in terminal.
- [ ] Approvals and questions, approval: matches mock. Command shown with Allow once, Allow for this session and Deny.
- [ ] Approvals and questions, question: matches mock. Agent question rendered with ask fields.
- [ ] Approvals and questions, answered: matches mock. The card is replaced by a one-line record.
- [ ] Agent-drawn views, inline: matches mock. View with by-agent tag, stats, chart, table, action buttons and Move to pane.
- [ ] Agent-drawn views, pane: matches mock. Transcript record with Move inline; pane with view tabs and "updated N times".
- [ ] Agent-drawn views, invalid: matches mock. Error card with Show source, followed by the agent's retry.
- [ ] Reviewing a turn, default: matches mock. Changed files with counts and an expandable diff.
- [ ] Reviewing a turn, commenting: matches mock. Line comment box open; notes count goes up.
- [ ] Reviewing a turn, sent: matches mock. Notes sent as one message.
- [ ] Composer across agents, pi: matches mock. Unsupported controls disabled with the reason on hover.
- [ ] Composer across agents, claude-code: matches mock. All controls live.
- [ ] Composer across agents, mention: matches mock. `@` opens a file list from the worktree.

## Behavior & scenarios

### The chat session

1. **SC-1 A turn folds activity and shows cards**
   - **Given** a Claude Code session in a worktree
   - **When** you send a prompt and the agent reads files, edits one, and runs tests
   - **Then** the reads fold into one activity line; the edit shows a File change card; the test run shows a Test results card; each card shows running until its tool call returns
   - **Walkthrough:**
     1. You send "Retry webhooks on 5xx with backoff"*.
     2. The agent reads 4 files* and searches 2 patterns*: ✓ one line, "Read 4 files · searched 2 patterns".
     3. The agent edits `src/webhooks/retry.ts`*: ✓ a File change card appears as running, then shows +18 −4*.
     4. The agent runs the tests: ✓ a Test results card shows running, then 42 passed*.
   - **Data after:** **Turn 1**: ✓ your message; ✓ prose; ✓ one activity line; ✓ File change card; ✓ Test results card; ✓ changes card

2. **SC-2 Typing while the agent works queues the message**
   - **Given** an agent mid-turn
   - **When** you type a message and press Enter
   - **Then** the message waits above the composer and sends when the turn ends; you can edit or delete it before then; Steer now sends it straight away on agents that support steering and is disabled with a reason on the rest

3. **SC-3 Stop ends the turn**
   - **Given** an agent mid-turn
   - **When** you click Stop
   - **Then** the turn ends, cards still running show stopped, and a queued message stays queued for you to send or delete

4. **SC-4 A new chat shows which agents are ready**
   - **Given** a new chat where Codex is not signed in
   - **When** the chat opens
   - **Then** four agent cards show; Codex is disabled and says "not signed in" with a link to sign in; the others show their default model
   - **Screen states:**

     | Agent | Shown |
     |---|---|
     | Claude Code | ✓ ready, default model |
     | Codex | ✗ disabled, "not signed in" |
     | pi | ✓ ready, default model |
     | omp | ✓ ready, default model |

5. **SC-5 The agent process exits**
   - **Given** a session whose agent process exits with an error
   - **When** the exit is noticed
   - **Then** an inline row shows the last stderr lines with Restart and Open in terminal; the transcript is kept; Restart resumes the same conversation on agents that support resume
   - [ASK: on an agent that can't resume, should Restart start a fresh conversation in the same tab, or be disabled with the reason?]

### Approvals and questions

6. **SC-6 An approval shows in two places and clears from both**
   - **Given** a Codex session in a background tab
   - **When** Codex asks to run `pnpm prisma migrate dev`
   - **Then** an approval card shows inline in the transcript and in the Questions panel; the tab, the sidebar and the status bar count it; answering in either place clears both and the inline card becomes a one-line record
   - **Data before:** **Status bar**: 0 need you
   - **Walkthrough:**
     1. Codex asks to run the command: ✓ the inline card and the panel entry appear; ✓ the status bar shows 1 needs you.
     2. You click Allow once in the Questions panel.
   - **Data after:** **Status bar**: ✓ 0 need you; **Turn**: ✓ "Allowed once: pnpm prisma migrate dev"

7. **SC-7 Deny with a reason**
   - **Given** a pending approval
   - **When** you click Deny and type a reason
   - **Then** the agent receives the denial and your reason; the record shows "Denied" with the reason

8. **SC-8 Allow for this session where the agent lacks it**
   - **Given** an agent whose approval API has no session-wide allow
   - **When** an approval card shows
   - **Then** Allow for this session is disabled, with the reason on hover

9. **SC-9 An agent question renders as ask fields**
   - **Given** a Claude Code AskUserQuestion, a pi extension prompt or an omp ask
   - **When** it arrives
   - **Then** it renders as the same card with `quirky ask` field types, and your answer goes back through that agent's own channel

### Reviewing a turn

10. **SC-10 The changes card comes from git**
    - **Given** a turn where the agent edited one file with its edit tool and a shell command rewrote another
    - **When** the turn ends
    - **Then** the changes card lists both files with lines added and removed
    - **Data after:** **Changes card**: ✓ `src/webhooks/retry.ts` +18 −4*; ✓ `pnpm-lock.yaml` +2 −2*

11. **SC-11 Line comments join the existing notes**
    - **Given** 1 note already in the Changes panel
    - **When** you comment on two lines in the changes card and click Send
    - **Then** the notes count shows 3 before sending, and the agent receives all 3 as one message
    - **Data before:** **Notes**: 1
    - **Walkthrough:**
      1. You comment on line 42*: notes 2.
      2. You comment on line 57*: notes 3.
      3. You click Send.
    - **Data after:** **Notes**: ✓ 0 pending; **Agent**: ✓ one message holding 3 notes

12. **SC-12 Notes sent while the agent works**
    - **Given** an agent mid-turn
    - **When** you send notes
    - **Then** they queue like a typed message and send when the turn ends

### Agent-drawn views

13. **SC-13 A view with no placement opens inline**
    - **Given** an omp session
    - **When** omp runs `quirky view open` with a valid view and no placement
    - **Then** the view shows inline in the transcript with a "by omp" tag and Move to pane

14. **SC-14 The agent puts a view in the pane, and you move it**
    - **Given** omp opens "Bundle size" with the pane placement
    - **When** you click Move inline, and omp later updates the view
    - **Then** the view moves into the transcript and stays there after the update
    - **Walkthrough:**
      1. omp opens "Bundle size"* in the pane: ✓ the Views pane opens; ✓ the transcript shows a one-line record with Move inline.
      2. You click Move inline: ✓ the view shows in the transcript; ✓ the pane closes if it has no other views.
      3. omp runs `quirky view update` on it: ✓ the view updates where it is, inline.
    - **Data after:** **Bundle size view**: ✓ inline; ✓ "updated 1 time"

15. **SC-15 Updating a view replaces it in place**
    - **Given** a view in the pane that omp has updated twice
    - **When** omp updates it again
    - **Then** the view's content is replaced, not duplicated, and it shows "updated 3 times" with the time

16. **SC-16 A view button reaches the agent**
    - **Given** a view with a "Lazy-load zxcvbn" button
    - **When** you click it
    - **Then** (a) if the agent is blocked in `quirky view wait`, the action is that command's result; (b) if the agent is idle, the action arrives as a follow-up message; (c) if the agent is mid-turn, the action queues like a typed message

17. **SC-17 An invalid view never renders half-built**
    - **Given** omp runs `quirky view open` with a component the catalog doesn't have
    - **When** the daemon checks it
    - **Then** nothing renders; `quirky view` prints the error and exits non-zero; the transcript shows a card naming the problem with Show source
    - **Walkthrough:**
      1. omp opens "Module map"* using a Treemap*.
      2. The daemon refuses it: ✗ unknown component "Treemap".
      3. ✓ omp's command prints the error and a hint; ✓ the transcript shows the error card.
      4. omp opens the same data as a table: ✓ it renders.

18. **SC-18 Views can't reach out on their own**
    - **Given** a view with a markdown link
    - **When** you click the link
    - **Then** Quirky asks before opening it; a view never loads remote content or runs agent code

19. **SC-19 Views survive a restart**
    - **Given** a session with an inline view and a pane view
    - **When** Quirky restarts and you reopen the session
    - **Then** both views come back where they were, with their last content

### Composer

20. **SC-20 Unsupported controls explain themselves**
    - **Given** a pi session
    - **When** you hover the disabled plan toggle
    - **Then** it says pi has no plan mode
    - **Screen states:**

      | Control | Claude Code | pi |
      |---|---|---|
      | Model | ✓ live | ✓ live |
      | Permission mode | ✓ live | ✗ disabled, reason on hover |
      | Plan toggle | ✓ live | ✗ disabled, reason on hover |
      | Attach | ✓ live | ✓ live |

21. **SC-21 A started session's agent is fixed**
    - **Given** a session with at least one turn
    - **When** you look at the agent chip
    - **Then** it shows the agent and can't be changed; a new chat lets you pick

22. **SC-22 Slash is plain text**
    - **Given** any session
    - **When** you send `/review`
    - **Then** the text is sent as written

## Scope & non-goals
**In v1:** the five screens above, for all four agents; `quirky view` and its catalog; cards from the tool stream; the changes card and notes.

**Not in v1:** mobile; the central brain chat; HTML views from MCP servers (MCP Apps); running one task on several agents; rewind and checkpoints; ACP; voice and dictation; slash commands; saving views as files in the worktree.

**Source-of-truth amendments this spec carries.** `BRIEF.md:67-69` lists native chat as dropped, `docs/architecture.md:175-178` and `:302-303` keep interactive agents in terminals and structured sessions background-only, and `docs/roadmap.md:176` says native chat was dropped. The implementation updates all three to allow interactive desktop chat over structured sessions. Terminal sessions stay available for agents and for anyone who prefers them. The blocked `sb-mobile-chat-voice-native-ruling` in `docs/loop/BLOCKERS.md` asked for exactly this amendment, so its entry is updated to say desktop chat is now authorized. Mobile chat, voice and native mirroring stay blocked, because they need contracts this spec doesn't provide.

## Open questions
**Components with no match in `@quirky/ui`** (gaps from [mock/screens.md](mock/screens.md)). For each, the tech spec decides whether it becomes a shared design-system component or stays in the chat plugin:
- Chat session: user message, agent prose, activity group, File change card, Test results card, Steps card, queued message, agent picker
- Approvals and questions: answered record, "also in the Questions panel" link
- Agent-drawn views: view card, stat tile, bar chart, table, updated marker, Show source
- Composer: plan toggle, disabled-control reason

**From the scenarios:** SC-5's Restart on agents that can't resume.

## Industry Insights
- The field is converging on host-registered components with tool-call replies. Agent-supplied HTML in a sandbox is the fallback for what a catalog can't express. ([AI SDK](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces), [CopilotKit](https://docs.copilotkit.ai/generative-ui), [assistant-ui](https://www.assistant-ui.com/docs/tools/tool-ui))
- json-render's `harness-chat` example renders Claude Code, Codex and pi work with FileChange, Terminal, TestResults and Steps components, which matches this spec's cards. Its checks are opt-in and its events carry no payload. ([json-render](https://github.com/vercel-labs/json-render), [harness-chat](https://github.com/vercel-labs/json-render/tree/main/examples/harness-chat))
- OpenUI renders every partial program and sends form state back to the host, but it is 0.x and its install sends telemetry. ([OpenUI](https://github.com/thesysdev/openui), [actions](https://www.openui.com/docs/openui-lang/actions))
- A2UI 1.0 updates surfaces in place by id, and its action envelope (name, surface, source, context, data) shaped this spec's view actions. ([A2UI 1.0](https://a2ui.org/specification/v1.0-a2ui/))
- MCP Apps is the one cross-host standard for agent HTML, but desktop sandboxes have been escaped and only Codex passes the UI link through. ([MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [Backslash](https://www.backslash.security/blog/new-mcp-spec-opens-new-attack-surfaces), [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md))
- Hosted generative-UI services are fragile: Tambo's cloud shut down in October 2026. ([Tambo](https://tambo.co/blog/posts/tambo-is-shutting-down))

The full research is in `docs/quirk/explorations/2026-11-16-agent-generative-ui.md` and `docs/quirk/explorations/2026-11-10-agent-chat-interface.md`.

## Deferred Ideas
- MCP Apps views from third-party MCP servers, starting with Codex.
- Saving views as files in the worktree.
- Slash commands.
- Comparing one task across agents.
- Rewind and checkpoints.
- `[tech-spec]` Virtualizing the transcript for long sessions.
- `[tech-spec]` Where the turn-item model lives (protocol package or plugin).
- `[tech-spec]` Whether the Claude Agent SDK passes MCP `_meta` through.

## Glossary
- **Turn**: your message and everything the agent did in reply, up to the next message.
- **Activity**: tool calls that read or ran something without a card of their own, folded into one line.
- **Card**: UI Quirky draws from an agent's tool calls, such as File change or Test results.
- **View**: UI an agent draws on purpose with `quirky view`, from Quirky's catalog.
- **Catalog**: the fixed list of components a view may use.
- **Action**: what a click on a view button sends back to the agent.
- **Views pane**: the side panel beside the chat that holds views placed there.
- **Steer**: sending a message to an agent mid-turn so it changes course without stopping.
- **Capability**: a feature an agent declares it supports; the composer disables what's missing.
