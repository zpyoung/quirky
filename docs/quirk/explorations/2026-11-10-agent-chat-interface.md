> 🧭 EXPLORATION — not a spec. No locked decisions; nothing here is build-ready.

# Exploring: a chat interface for Claude Code, Codex, pi and omp in Quirky

**Date**: 2026-11-10 · **Emphasis**: research-heavy · **Intensity**: 0.5 (Exploratory) · **Involvement**: medium

## Framing

Quirky runs coding agents in git worktrees. We want to know which features are worth building in a Quirky chat interface that drives four backends: Claude Code, Codex, pi and omp. This doc collects evidence from highly rated agent GUIs and turns it into a set of directions. It doesn't pick one.

Scope came from the scoping questions:

- **Depth:** deep, with seven parallel research facets and then two gap rounds.
- **Comparables:** GUIs that wrap CLI agents, first-party apps, and IDE agent panels. General LLM chat UIs were excluded.
- **Focus:** transcript rendering, control surfaces, parallel sessions, the review loop, and one UI over many backends. Mobile and remote access were left out.

**Native chat is currently out of scope for Quirky.** `BRIEF.md` and the M1 and M5 specs exclude it, and `docs/loop/BLOCKERS.md` lists the chat ruling as blocked. This exploration feeds that ruling; it doesn't override it.

The companion doc `.quirk/html/claude-code-tab.html` (local only, not in git) walks through the Claude desktop Code tab with screenshots.

## What was explored

- **Research facets:**
  1. a catalog of highly rated agent GUIs, with rating signals
  2. transcript rendering
  3. control surfaces: permissions, plan mode, questions, queue, steer, rewind
  4. parallel sessions and worktrees
  5. the review loop
  6. multi-backend protocols: ACP, Codex app-server, the Claude Agent SDK, and pi and omp RPC
  7. community complaints and wishes
- **Gap rounds:**
  - how multi-backend GUIs normalize transcripts, the ACP v2 draft, and pi and omp specifics
  - specific praise, Codex app details, attention designs, history portability, and performance as a selling point
- **Directions generated:** 11. The user asked to go deeper on 1 through 9. Directions 10 and 11 are kept as first drafted.
- **Out of scope:** general chat UIs such as Open WebUI and LibreChat, mobile and remote clients, and pricing.
- _Steered:_ the user dropped the mobile facet at scoping and flagged directions 1 to 9 for depth at the idea gate.

## Findings

### Theme: the category is consolidating fast

- **Conductor is joining Meta.** It was announced Nov 4, 2026. Cloud goes read-only Nov 13 and shuts Nov 20, and the Mac app gets fixes until early 2027. Chat history does not migrate. — [GitKraken](https://gitkraken.com/blog/conductor-is-joining-meta-what-that-means-if-you-run-parallel-agents), [TechCrunch](https://techcrunch.com/2026/11/04/meta-acquires-ai-coding-startup-conductor/)
- **Google is shutting down Jules.** It goes read-only after Nov 11 and shuts Dec 31, 2026. — [SmartScope](https://smartscope.blog/en/blog/google-jules-shutting-down-december-31-read-only-2026/) (secondary)
- **Other wind-downs:** Vibe Kanban is sunsetting and community-maintained ([README](https://github.com/BloopAI/vibe-kanban)). Crystal is deprecated in favour of Nimbalyst ([repo](https://github.com/stravu/crystal)). Roo Code is archived ([repo](https://github.com/RooCodeInc/Roo-Code)). coder/agentapi, which scraped terminals, was archived Sep 2026 ([repo](https://github.com/coder/agentapi)).
- **First-party apps are absorbing the features.** Examples are the Claude Code agent view, the Codex app, Cursor 3's Agents Window and Copilot mission control. — [agent view](https://code.claude.com/docs/en/agent-view.md), [Cursor 3.0](https://cursor.com/changelog/3-0), [mission control](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)
- **Tools with the most stars or HN points are mostly session managers, not chat apps.** Examples: Vibe Kanban (28.6k★), cmux (28.7k★, a terminal), and Conductor (Show HN 228 pts). Among IDE agents, Cline (71k★) leads. — [catalog notes in Sources](#sources)
- **omp is oh-my-pi**, a pi fork by Stencil Labs (can1357/oh-my-pi, 38k★). Upstream pi moved to earendil-works/pi. — [oh-my-pi](https://github.com/can1357/oh-my-pi), [pi](https://github.com/earendil-works/pi)

### Theme: transcript rendering

- **Claude desktop has three transcript views.** Normal collapses tool calls, Thinking adds reasoning, and Verbose shows everything. Hiding detail by default drew complaints, and critics call Verbose "too noisy". — [docs](https://code.claude.com/docs/en/desktop), [i-programmer](https://i-programmer.info/news/105-artificial-intelligence/18709-claude-code-now-hides-the-way-it-works-but-theres-a-workaround.html)
- **Users want subagents shown as nested, collapsible tool sequences.** Today the delegation row disappears when the subagent finishes. — [#88622](https://github.com/anthropics/claude-code/issues/88622), [#98643](https://github.com/anthropics/claude-code/issues/98643)
- **Codex reasoning summaries are the sharpest rendering complaint.** Users report them truncated, hidden, or reduced to a blinking "Thinking". — [#27197](https://github.com/openai/codex/issues/27197), [#46356](https://github.com/openai/codex/issues/46356), [#49761](https://github.com/openai/codex/issues/49761)
- **Long sessions are a memory problem.**
  - Zed rebuilt every diff when it restored a thread. Building each diff on first expand cut memory from about 3.0 GiB to 478 MiB ([PR #65444](https://github.com/zed-industries/zed/pull/65444), author's numbers).
  - Minified files froze Zed's agent panel ([#65894](https://github.com/zed-industries/zed/issues/65894)).
  - VS Code users ask for a virtualized chat DOM ([#297349](https://github.com/microsoft/vscode/issues/297349)).
- **Markdown done well gets praised.** One user said of Zed, "they nailed the markdown formatting, the syntax highlighting". — [r/ZedEditor](https://www.reddit.com/r/ZedEditor/comments/1rgdg0b/)
- **Proportional, prose-style rendering is a reason people leave the terminal.** From a 467-point r/ClaudeCode thread: "a proportional font is easier to read" (122 pts). — [thread](https://www.reddit.com/r/ClaudeCode/comments/1xp5998/)

### Theme: control surfaces

- **Approval fatigue is driving vendors toward modes and classifiers.**
  - Anthropic says users accept 93% of manual prompts. Its auto-mode classifier cut false positives from 8.5% to 0.4% but missed 17% of overeager actions ([Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)).
  - Cursor ships Auto-review and warns its classifier "can make mistakes" ([Cursor](https://cursor.com/docs/agent/security/run-modes)).
  - Codex can route approvals to a reviewer agent ([Codex](https://learn.chatgpt.com/docs/agent-approvals-security)).
- **Approval choices ship as allow once, always, or for this session.** Zed writes "Always for <pattern>" as a regex rule ([Zed](https://zed.dev/docs/ai/tool-permissions)). Cursor drew a consent complaint because one checkbox silently changed the global run mode ([forum](https://forum.cursor.com/t/run-mode-not-respected-the-enable-auto-review-checkbox-changes-global-agentic-run-mode-and-violates-consent/163931)).
- **Plan approval offers three exits in Claude.** They are "Yes, and use auto mode", "Yes, manually approve edits" and "No, keep planning". Armin Ronacher notes the approval UI is hard to reproduce elsewhere. — [permission modes](https://code.claude.com/docs/en/permission-modes), [Ronacher](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/)
- **Queue and steer are now standard, and easy to get wrong.**
  - In Claude, Enter queues a message, which lands after the current tool calls. Ctrl+Enter sends now, and Up pulls queued items back ([interactive mode](https://code.claude.com/docs/en/interactive-mode)).
  - A Codex queue change drew a 33-point "This new queue thing is a disaster" post about lost and duplicated messages ([r/codex](https://www.reddit.com/r/codex/comments/1wx1det/)).
- **Rewind restores files, not side effects.** Claude's `/rewind` doesn't revert Bash edits once file tools touched the file, and usually doesn't restore subagent edits ([checkpointing](https://code.claude.com/docs/en/checkpointing)). Cline's checkpoints live in a shadow git repo, and its docs say "Without checkpoints, auto-approve feels risky" ([Cline](https://docs.cline.bot/features/checkpoints)).
- **Users keep building their own "agent needs input" alerts.** Examples are a popup, a notch display, and a taskbar animal that "knocks" (75 pts). — [popup](https://www.reddit.com/r/ClaudeCode/comments/1xpr4ap/), [taskbar](https://www.reddit.com/r/ClaudeCode/comments/1xqh8vr/)

### Theme: parallel sessions and attention

- **Users describe the bottleneck as review and attention, not spawning agents.**
  - Simon Willison: "the natural bottleneck on all of this is how fast I can review the results" ([Willison](https://simonw.substack.com/p/embracing-the-parallel-coding-agent)).
  - A Smartsheet anecdote: one engineer produced 7x the code while six teammates spent most of their time reviewing it ([Stack Overflow blog](https://stackoverflow.blog/2026/05/21/coding-agents-are-giving-everyone-decision-fatigue/)).
- **The Claude agent view states a strict contract.** "`blocked` always means the session needs something from you." It has six states, and "Ready for review" and "Needs input" sort above Working. `Space` peeks and replies without attaching, but dialogs still need attaching. — [agent view docs](https://code.claude.com/docs/en/agent-view.md)
- **The Codex app's automations land in a Triage inbox.** It has Approve, Revise and Reject actions. A reviewer writes that "the bottleneck shifts from agent execution speed to review bandwidth". — [Vaughan](https://codex.danielvaughan.com/2026/04/08/codex-desktop-automations/) (third-party)
- **Users ask for a "whose move" view.** One user running seven sessions built a ticket board where "if it's waiting on me, it adds a blocker". Another suggested "making the task the unit rather than the session". — [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1x5553i/), [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1xqrv0a/)
- **Running many sessions costs RAM.** One mirrored issue reports 10 parallel sessions at about 30 GB. Another says idle chats never release memory. — [mirror](https://claudeissues.com/issue/63318-bug-excessive-ram-usage-with-multiple-parallel-chats-10-sessions-30-gb-memory-pr), [mirror](https://claudeissues.com/issue/88524-memory-scales-linearly-with-open-sessions-on-macos-idle-chats-never-release-ram)
- **Best-of-N exists in Cursor (`/best-of-n`, separate worktrees) and Codex cloud (`--attempts` 1 to 4).** Claude Code users do it by hand. One user notes it is "3x the tokens. What you're buying is variance reduction." — [Cursor 3.0](https://cursor.com/changelog/3-0), [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1vpijym/)
- **Worktrees isolate files, not ports or databases.** Conductor gives each workspace a ten-port range via `CONDUCTOR_PORT`. — [Conductor scripts](https://www.conductor.build/docs/core/scripts), [Nimbalyst guide](https://nimbalyst.com/blog/git-worktrees-for-ai-coding-agents-complete-guide/)

### Theme: the review loop

- **Batched line comments sent back to the agent is the common pattern.**
  - Claude desktop: comment with +, then submit the batch with Cmd+Enter.
  - Codex: comments ride along with your next message.
  - Vibe Kanban: comments are consumed on send.
  - Copilot: "Add to batch", then "Fix and commit".
  - Sources: [Claude desktop](https://code.claude.com/docs/en/desktop), [Codex](https://learn.chatgpt.com/docs/code-review?surface=app), [Vibe Kanban](https://vibekanban.com/docs/reviewing-code), [Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)
- **Diff scopes and per-hunk actions differ by product.** The Codex review pane offers Unstaged, Staged, Commit, Branch and Last turn, with stage or revert per file or hunk ([Codex](https://learn.chatgpt.com/docs/code-review?surface=app)). Zed has hunk keep/reject in a multibuffer ([Zed](https://zed.dev/docs/ai/agent-panel)).
- **Removing per-change accept caused the loudest backlash in the research.** One Cursor forum thread is titled "Bring back per-change Apply + inline diff review — you're throwing away your best UX advantage". — [forum](https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856)
- **Zed users approve without seeing the diff.** The permission prompt shows the tool name, not the change (30 votes). — [discussion #47695](https://github.com/zed-industries/zed/discussions/47695)
- **PR round-trips are first-party now.** Claude desktop has Auto-fix for CI and review comments, plus Merge when ready. Codex has a Fix action under Checks. — [Claude desktop](https://code.claude.com/docs/en/desktop), [Codex](https://learn.chatgpt.com/docs/code-review?surface=app)
- **Trust is eroding.** One r/cursor user asks whether people "still read every diff" or "just run the app and check" ([thread](https://www.reddit.com/r/cursor/comments/1xbzrqc/)). Another says, "review fatigue usually means the agent was allowed to produce too much in one shot" ([r/ChatGPTCoding](https://www.reddit.com/r/ChatGPTCoding/comments/1x17k3i/)).

### Theme: one UI over four backends

Each backend's protocol differs on the controls a shared UI needs. Cells marked "?" were not verified.

| Capability | Claude Agent SDK | Codex app-server | pi RPC | omp RPC | ACP v1 |
|---|---|---|---|---|---|
| Native ACP | adapter (`claude-agent-acp`) | adapter (`codex-acp`) | third-party `pi-acp` | yes, `omp acp` | n/a |
| Diffs | none; Edit carries old/new strings | `fileChange` with unified diff | edit tool carries `EditDiff {diff, patch}` | ? | `diff` content; v2 adds `changes[]` + `git_patch` |
| Permissions | `canUseTool` plus six modes | accept, for session, decline, cancel | none in core; extensions block via `tool_call` hook | `always-ask` … `yolo` (default) | allow/reject once or always |
| Questions | `AskUserQuestion` | `tool/requestUserInput` (experimental) | `extension_ui_request` | `ask` dialog | `elicitation/create` |
| Plan mode | `plan` mode | `collaborationMode` (experimental) | absent by design | `plan` role at launch only | `plan` updates |
| Steer | queued messages | `turn/steer` (timing undocumented) | `steer` after tool calls | `steer` live if provider allows | none in core |
| Subagents | `parent_tool_use_id` | experimental | absent | `task`, `steer_subagent` | draft only |
| Host-provided tools | MCP | MCP | extensions | `host_tool_call` | v2: client tools as MCP |

Sources for the table are in [Sources](#sources), under "Protocols".

- **Existing multi-backend GUIs normalize in three ways.**
  - ACP for every agent: Zed, JetBrains Air and Toad. ([Zed](https://zed.dev/docs/ai/external-agents), [Air](https://blog.jetbrains.com/air/2026/07/what-s-new-air-gets-more-agents-local-models-and-java-kotlin-code-intelligence/))
  - Native protocols plus ACP: Happy. ([Happy](https://github.com/slopus/happy))
  - One plugin per agent, or terminal only: HumanLayer and Emdash. ([HumanLayer](https://github.com/humanlayer/humanlayer), [Emdash](https://github.com/generalaction/emdash))
- **Zed gates features for external agents.** Steering is Zed-agent only because it "can't detect turn boundaries for external agents" (search summary, unverified). Profiles and Skills don't apply. Its thread model keeps agent-reported tool status separate from local status, and a pending permission forces `WaitingForConfirmation`. — [acp_thread.rs](https://github.com/zed-industries/zed/blob/main/crates/acp_thread/src/acp_thread.rs)
- **Happy's own design doc calls normalization the hard part.** It names six plaintext families as "the real source of the complexity". Its nine-event schema drops tool results and diffs. The redesign moves to a message-plus-parts model copied from OpenCode, where a pending permission or question is a `blocked` tool state. — [session-protocol.md](https://github.com/slopus/happy/blob/main/docs/session-protocol.md), [provider-envelope-redesign.md](https://github.com/slopus/happy/blob/main/docs/plans/provider-envelope-redesign.md)
- **The ACP v2 draft (Jul 20, 2026) changes the client model.**
  - `session/prompt` no longer ends the turn. UI state comes from `state_update` (`running`, `idle`, `requires_action`).
  - Tool calls are upserts.
  - Diffs carry `changes[]` with an optional git patch.
  - Modes become config options.
  - Zed's code already references v2 types. No agent adapters were found speaking v2.
  - — [v2 migration](https://agentclientprotocol.com/protocol/v2/migration.md), [announcement](https://agentclientprotocol.com/announcements/acp-v2-draft.md)
- **The adapters lose features.** pi-acp has no thought stream, drops MCP servers, and queues one prompt at a time client-side ([pi-acp](https://github.com/svkozak/pi-acp)). claude-agent-acp doesn't mention AskUserQuestion ([repo](https://github.com/zed-industries/claude-agent-acp)). One Zed user still runs Claude in a terminal because they "didn't find acp quite there yet" ([r/ZedEditor](https://www.reddit.com/r/ZedEditor/comments/1vxza7o/)).
- **Terminal scraping loses structure.** A fork of coder/agentapi says thinking blocks, tool calls and usage can't be reliably rebuilt from terminal output. — [fork](https://github.com/k1dav-c/agentapi) (search excerpt)
- **Framing traps:**
  - Split pi stdout only on LF.
  - omp v1 caps frames at 1 MiB.
  - Codex experimental methods need `experimentalApi: true`.
  - omp defaults to `yolo` approvals.
  - Claude skips `canUseTool` for calls a rule or mode already allows.
  - — [pi rpc.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md), [omp rpc.md](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md), [Codex README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [omp approvals](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md), [Claude SDK](https://code.claude.com/docs/en/agent-sdk/python)

### Theme: what users complain about and praise

These themes are ranked by how often they came up.

1. **Desktop apps trail the CLI on features.** Users report fewer slash commands, missing MCP prompts, plugin hooks not running, and no `/plugin`. — [#45399](https://github.com/anthropics/claude-code/issues/45399), [#75234](https://github.com/anthropics/claude-code/issues/75234), [#72025](https://github.com/anthropics/claude-code/issues/72025), [#42142](https://github.com/anthropics/claude-code/issues/42142)
2. **Lag, RAM and freezes.** "It lags the same as the browser" ([r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1v4fwjv/)). A Codex syspolicyd CPU issue has 398 +1s ([#25719](https://github.com/openai/codex/issues/25719)). Emdash with 78 tasks is "crawling to a halt" ([HN](https://news.ycombinator.com/item?id=47140322)).
3. **Sessions vanish.** There are at least six Claude desktop issues, one labeled data-loss. — [#60341](https://github.com/anthropics/claude-code/issues/60341), [#75229](https://github.com/anthropics/claude-code/issues/75229), [#81907](https://github.com/anthropics/claude-code/issues/81907)
4. **Users can't see what agents did.** An IDE diff approval request for Codex has 241 +1s ([#2998](https://github.com/openai/codex/issues/2998)). Prompts that time out have 388 +1s ([#73125](https://github.com/anthropics/claude-code/issues/73125)).
5. **UI churn.** "Bring back old UI" on Vibe Kanban got +33 ([#2687](https://github.com/BloopAI/vibe-kanban/issues/2687)).

- **Why people pick a GUI:** named threads across projects, worktree isolation, background work, readable prose, and multi-agent layouts. — [r/codex](https://www.reddit.com/r/codex/comments/1rrllg3/), [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1xp5998/)
- **Why people stay in the terminal:** habit (231 pts), it fits developer workflows, it's snappier, and `codex exec` works for CI. — [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1xcag8t/), [vibecoding.app](https://vibecoding.app/blog/codex-desktop-app-vs-codex-cli)
- **Multi-agent praise:** "Love the fact that I can seamlessly switch between Codex for heavy backend stuff and Claude code for everything else" ([Emdash HN](https://news.ycombinator.com/item?id=47140322)). Trying Codex in Conductor is "as easy as shifting a dropdown" ([r/conductorbuild](https://www.reddit.com/r/conductorbuild/comments/1rokhwv/)).
- **Status praise:** Orca ADE "displays the status of each Claude Code session in a very useful way" (142 pts; Orca is the app Quirky rewrites). On cmux: "Love being able to leave and reattach while an agent is working". — [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1vwjgyv/), [HN](https://news.ycombinator.com/item?id=47079718)
- **What makes people switch:** usage limits, model regressions, UX, and access to other harnesses. The most-upvoted interop request is AGENTS.md support (5,192 +1s). — [#6235](https://github.com/anthropics/claude-code/issues/6235), [#17118](https://github.com/anthropics/claude-code/issues/17118)

### Theme: where Quirky starts

These facts come from the code in this worktree.

- **Background (structured) sessions:**
  - Claude runs through the Agent SDK `query()` (`plugins/quirky.structured/claude-runner.ts`) and resumes by provider session ID (`claude-runner.ts:198`).
  - Codex runs through `codex app-server` and resumes with `thread/resume` (`codex-runner.ts:126`).
  - The structured agent enum is `claude|codex`.
- **Other agents:** pi is used only for one-shot `--print` runs and model discovery. omp and 40-plus other agents run only as PTY terminals (`packages/pty-host`). There is no ACP code.
- **History store:** structured sessions already keep a Quirky-owned SQLite journal, the `structured_messages` table (`plugins/quirky.structured/journal.ts`). Each row has a session, a sequence number, a role, text and JSON data.
- **The native view is minimal.** It shows role badges, plain text, collapsible raw tool output, and cost and duration (`plugins/quirky.session/src/window/StructuredView.tsx`, `MessageRow.tsx`). It doesn't render markdown, thinking or diffs. Codex file changes show paths only.
- **Questions and permissions go to the Questions panel, not inline.** The flow is `canUseTool` → `createAsk` with `nativeQuestion` (`claude-runner.ts:236-246`, `quirky.structured/main.ts`).
- **Review notes reach terminal agents only.** The Changes panel's "Send notes to agent" sends notes through a target layer (`plugins/quirky.git/src/daemon/targets.ts`) that doesn't cover structured sessions.
- **Mobile hides structured sessions** (`apps/mobile/src/pages/SessionPage.tsx`).

## Idea landscape

No direction is preferred over another. Directions 1 to 9 are expanded at the user's request.

### Direction 1: an honest capability model

**The idea.** Store one transcript model for every backend: messages made of parts (text, reasoning, tool call, patch, subtask). A pending permission or question is a state of its tool call. Each backend adapter declares what it can do, such as `plan`, `steer: after-tools | live | none`, `questions`, `thinking`, `subagents`, `diffs: native | derived`. The UI reads that declaration and renders only controls the backend can honor, worded to match it.

**What going deeper shows:**
- **The shape already exists twice.** Happy's redesign and OpenCode use message-plus-parts with a `blocked` tool state. ACP v2's upsert tool calls and `requires_action` state point the same way. Quirky could borrow the shape instead of inventing one.
- **Steer is the clearest case for honest labels.** pi steers after tool calls, omp steers live when the provider allows, Claude queues until the current tool calls finish, and Codex's `turn/steer` timing is undocumented. A single "send now" button would mean four different things.
- **Zed's split between reported and local status is worth copying.** It keeps the agent-reported status separate from the UI's own status, and that split handles the permission-pending and unknown-status cases.
- **Quirky's journal is a starting point.** `structured_messages` stores role, text and a JSON `data` column. Parts could live in `data` without a schema break, though that's a guess until someone tries it.

*Why this might actually work:* all four event streams already emit tool start, update and end plus text deltas, so the common core is real. Users forgive a missing feature far more than a control that misbehaves, as Codex's queue backlash shows.  
*surfaced by:* first principles · *sits at intensity:* Grounded

### Direction 2: ACP at the edge, native at the core

**The idea.** Talk to each backend through the richest channel it offers, and use ACP only where it's native or where no better channel exists.

**What going deeper shows. There are three variants:**
- **(a) Native everywhere.** The Agent SDK for Claude, app-server for Codex, `pi --mode rpc` for pi, and omp's own JSONL RPC. This keeps every feature, including omp's `host_tool_call` and pi's `EditDiff`. The cost is four adapters to maintain.
- **(b) Native for Claude and Codex, ACP for the pi family.** omp needs no adapter for ACP. pi would need pi-acp or Quirky's own adapter, and pi-acp lacks thinking, MCP and fs delegation.
- **(c) ACP for everything.** One protocol and one adapter layer, the route Zed, Air and Toad took. It inherits the adapter losses for Claude and Codex, such as AskUserQuestion and steering, and v1 versus v2 churn.

Quirky already does native Claude and Codex, so (a) and (b) add to what exists, while (c) would replace it.

*Why this might actually work:* the two backends with the richest native protocols are the two Quirky already speaks natively. ACP's main value, typed tool calls and diffs, is something those native protocols already provide.  
*surfaced by:* analogical transfer, comparing native drivers with a generic bus · *sits at intensity:* Grounded

### Direction 3: git is the universal diff

**The idea.** Quirky owns each worktree, so what changed in a turn can come from git rather than from the agent. At each turn boundary, snapshot the worktree to a shadow ref, as Cline does. The diff for a turn is snapshot to snapshot. Rewind restores a snapshot.

**What going deeper shows:**
- **It works the same for all four backends.** Only Codex and ACP send real diff objects. Claude sends `old_string`/`new_string`, omp's diff payload is undocumented, and pi's `EditDiff` covers only its own edit tool.
- **It catches what agent-side checkpoints miss.** That includes Bash `sed` edits, codegen, formatters, and subagent edits, which Claude's `/rewind` doesn't track.
- **Quirky already has the git machinery.** The Changes panel's daemon (`plugins/quirky.git/src/daemon/`, with `compare.ts`, `review.ts` and `staging.ts`) already computes worktree diffs.
- **Turn boundaries come from the protocols.** Claude has `ResultMessage`, Codex has `turn/completed`, pi has `agent_end`, and omp has its equivalent. Snapshot cost is a write-tree per turn, so it's cheap for normal repos. That's unmeasured for huge ones.
- **Side effects stay unrestorable.** Databases, network calls and installed packages can't be rolled back by any of these systems, and this one is no different.

*Why this might actually work:* Cline's own docs credit shadow-git checkpoints with making auto-approve feel safe. Owning the worktree is something Quirky has and an IDE plugin doesn't.  
*surfaced by:* assumption reversal, from "the agent tells you what changed" · *sits at intensity:* Grounded

### Direction 4: each turn is a reviewable change

**The idea.** When a turn ends, the transcript shows a change card instead of a pile of tool rows. The card shows files and line counts, a diff since the turn started (from direction 3), keep or revert per hunk, and line comments. Comments queue up and go back to the same session as one message.

**What going deeper shows:**
- **Quirky already has the review half.** The Changes panel has review marks, notes, and "Send notes to agent" (`targets.ts`, `notes.ts`, `note-bridge.ts`). Today the send targets cover terminal agents only. Adding structured sessions as a target is the smallest version of this direction.
- **The comment format is unsettled.** No vendor documents what message the agent actually receives. The Codex docs example is "Address the inline comments and keep the scope minimal". Quirky's `notes-format.ts` already renders notes for terminal agents, so the same text could go to any backend's `send`.
- **Per-hunk keep or revert is where competitors stumbled.** Cursor removed it and drew the loudest backlash in the research. Codex has it, and Claude desktop doesn't.
- **There are two ways to show it.** The change card can sit inline in the transcript, as Cursor does with bubbles, or open in the side review pane, as Claude, Codex and Conductor do. Users called Cursor's one-bubble-at-a-time approach painful.

*Why this might actually work:* batched line comments is the one review pattern four separate vendors converged on. Review time is the bottleneck users name most often.  
*surfaced by:* analogical transfer, from the pull request · *sits at intensity:* Grounded

### Direction 5: inbox first, chat second

**The idea.** The home surface is a cross-agent queue of whose move it is. Items are questions, permission requests, plan approvals, finished turns ready for review, and failures. The user answers inline, and the transcript is a drill-in.

**What going deeper shows:**
- **Quirky already centralizes asks.** Claude permission and question callbacks go to the Questions panel via `createAsk` (`claude-runner.ts:236-246`). In this direction that panel becomes the main screen instead of a side panel. Inline transcript cards could be a second view of the same ask.
- **Claude's agent view contract is worth copying.** It promises that "blocked always means you need to act". Its states are Working, Needs input, Idle, Completed, Failed and Stopped, and review and input items sort to the top.
- **Codex's Triage inbox adds review actions.** Approve, Revise and Reject turn review into an inbox operation.
- **Reply without opening is valued.** The agent view's `Space` peek is praised in the Conductor-rebuild post. Its limit is that dialogs still need the full session.
- **Terminal agents could join the same inbox.** Hooks (Claude `Notification`, Codex event hooks) and Quirky's existing terminal status detection could feed it, so the inbox isn't chat-only.
- **The four backends route their asks differently.** pi's are `extension_ui_request`, omp's are the `ask` dialog, and Codex's are approvals plus `requestUserInput`. All of them map onto "an item waiting on the user".

*Why this might actually work:* users keep building their own notifiers. The research names attention as the bottleneck for people running 5 to 10 agents, and Quirky's job is running many agents.  
*surfaced by:* analogical transfer, from a triage board · *sits at intensity:* Exploratory

### Direction 6: terminal twin

**The idea.** A chat session and a real CLI session are two views of one provider session. The user flips to the terminal when they need something only the CLI has, such as slash commands, plugins, `/config` or MCP prompts, then flips back to chat.

**What going deeper shows:**
- **Resume is already wired.**
  - Claude: the SDK writes normal Claude Code transcripts, and Quirky resumes them by ID (`claude-runner.ts:198`). A PTY could run `claude --resume <id>` on the same session.
  - Codex: app-server threads resume via `thread/resume` (`codex-runner.ts:126`). Whether `codex resume <id>` in a terminal reads the same thread wasn't verified.
  - pi and omp: both have session files and `switch_session`.
- **Only one side can drive the session at a time.** The other side would need to sleep, which suggests a handoff, not two live views. Quirky's sleep and wake already detaches and reattaches sessions by provider ID.
- **It answers the top complaint without matching the CLI feature by feature.** Desktop apps trailing the CLI is the most common complaint. Here the GUI doesn't have to reimplement every CLI feature.

*Why this might actually work:* Quirky already runs both PTY agents and structured sessions for the same backends. The gap users complain about can be bridged with a handoff instead of a rewrite.  
*surfaced by:* assumption reversal, from "the GUI must reimplement the CLI" · *sits at intensity:* Exploratory

### Direction 7: lean by construction

**The idea.** Make memory and speed a visible feature of the chat surface. That means a virtualized transcript, diffs and syntax highlighting built only when a card is expanded, sleeping sessions holding no renderer state, and per-session memory shown in the session list.

**What going deeper shows:**
- **The evidence is specific.** Zed's lazy diffs cut memory from 3.0 GiB to 478 MiB. One report has 10 Claude desktop sessions at about 30 GB, and another says idle chats never release RAM. A Codex commenter says pruning a 5.3 GB thread history cut switch latency from seconds to milliseconds (unverified).
- **The transcript store matters as much as the renderer.** Paging journal rows from SQLite by `seq` beats loading whole sessions.
- **Native-performance claims are mostly unmeasured.** cmux, Veil and Supacode make them without benchmarks. A measured number would stand out.

*Why this might actually work:* lag and RAM is the second-biggest complaint theme. Memory efficiency is the reason Quirky exists, so this is a claim it can back with numbers.  
*surfaced by:* overlooked value · *sits at intensity:* Grounded

### Direction 8: same task, different agents

**The idea.** Use the fact that Quirky drives four backends. Two variants:
- **Fan-out:** send one prompt to two to four backends in sibling worktrees, then compare their diffs side by side and keep one.
- **Baton pass:** hand a stuck or rate-limited session to another backend in the same worktree, with a summary.

**What going deeper shows:**
- **Fan-out is proven in single-vendor form.** Cursor runs `/best-of-n` across models in separate worktrees, and Codex cloud has `--attempts`. Neither crosses vendors. The cost is honest: "3x the tokens … variance reduction".
- **Baton pass matches why people switch.** Users switch over usage limits and model regressions. omp has a native `handoff` command. For the others, the summary would come from Quirky's own transcript (direction 9), and the worktree carries the code state.
- **The comparison view reuses directions 3 and 4.** Each attempt's diff is a git diff against the same base.

*Why this might actually work:* users already praise one-dropdown switching in Conductor and Emdash. A single-vendor app can't offer cross-vendor comparison, and Quirky can.  
*surfaced by:* analogical transfer, from A/B tournaments · *sits at intensity:* Exploratory

### Direction 9: Quirky owns the history

**The idea.** Quirky keeps its own normalized copy of every chat transcript, whichever backend produced it. That copy is searchable across agents and sessions, exportable, and survives when an agent app or a vendor changes.

**What going deeper shows:**
- **Half of it exists.** `structured_messages` is already a Quirky-owned journal for Claude and Codex sessions. Extending it to pi and omp, and to the parts model from direction 1, makes it cross-agent.
- **Search is the visible feature.** claude-devtools' Cmd+K search and export is Claude-only. A cross-agent viewer exists only as an unverified skill listing.
- **The evidence comes from loss events, not stated demand.** Vanishing sessions, Conductor history not migrating, and Zed threads that can't move between machines are the signals. No source showed users asking for cross-agent history directly.
- **Terminal agents could be included later.** Claude, Codex, pi and omp all write transcript files, so the same store could import them. That's untested.

*Why this might actually work:* agent apps keep shutting down or losing sessions, and Quirky already writes the journal. Making it the system of record is an extension, not a new subsystem.  
*surfaced by:* overlooked value · *sits at intensity:* Grounded

### Direction 10: one approval policy, compiled per backend

**The idea.** One Quirky policy covering paths, commands and network, turned into each backend's own mechanism:
- Claude: a `PreToolUse` hook plus `canUseTool`
- Codex: its approval policy and sandbox
- omp: `approvalMode`
- pi: a permission extension that Quirky ships, since pi has no core approvals

Paired with per-turn snapshots from direction 3, broader auto-approve becomes safer to allow.

*Why this might actually work:* users accept 93% of prompts, omp defaults to `yolo`, and pi has no gate at all. A single-vendor app can't set one policy across agents, and Quirky can.  
*surfaced by:* first principles · *sits at intensity:* Exploratory

### Direction 11 (contrarian): don't build chat, make the terminal smarter

**The idea.** Keep agents in PTYs and overlay structure on them: status from hooks, a side diff from git, question cards fed by `Notification` hooks, and the Changes-panel review loop Quirky already has.

*Why this might actually work:* habit keeps many users in the terminal (a 231-point thread). cmux and Emdash are well loved, and `BRIEF.md` already dropped native chat. Quirky supports 40-plus terminal agents and only two structured ones.  
*surfaced by:* contrarian inversion · *sits at intensity:* Exploratory

## Tensions & trade-offs

- **Fidelity versus reach (directions 1 and 2 against 11).** Native protocols give typed tool calls, diffs and questions, but only for four backends. The terminal reaches 40-plus agents but loses structure, as agentapi's archive and its fork's caveat show.
- **Normalization versus provider detail (direction 1).** A shared parts model makes the inbox, history and review uniform. Happy's own doc warns it risks discarding native tool IDs and raw payloads, and large diffs may need separate storage.
- **Agent-reported versus git-derived change (directions 3 and 4).** Git sees every file change but not why. Agent events carry intent but miss Bash edits. Showing one, the other, or both affects how much the user trusts the change card.
- **Inbox versus transcript as home (direction 5).** An inbox optimizes for many agents. Users who praise Claude desktop praise readable prose in a single session. The two pull the layout in opposite directions.
- **Parity versus simplicity (direction 6).** A terminal twin avoids reimplementing the CLI but exposes two surfaces for one session, with handoff rules to learn.
- **Spending versus saving (directions 7 and 8).** Fan-out multiplies tokens and RAM, which is the problem direction 7 is trying to shrink.
- **Building into a shrinking market.** Conductor, Jules, Vibe Kanban and Crystal winding down suggests first-party apps are winning. That cuts both ways: it removes multi-backend competitors, but it shows how hard the category is to sustain.
- **Exploring chat while the brief excludes it.** Any direction except 11 reopens the `BRIEF.md` exclusion and the blocked ruling in `docs/loop/BLOCKERS.md`.

## Challenge notes

- **Honest capability model (1).**
  - Steelman: it's the layer every other direction rests on, and two independent projects arrived at the same shape.
  - Strongest counter: capability flags multiply UI states, and backends change fast (omp and pi ship weekly, ACP v2 is in flux), so the declarations go stale.
  - Disproven if: adapters can't keep their capability declarations accurate across backend releases, or users find greyed-out or relabeled controls more confusing than missing ones.
- **ACP at the edge (2).**
  - Steelman: it keeps what Quirky already has and adds omp almost for free.
  - Strongest counter: maintaining four native adapters is the cost Happy calls "the real source of the complexity", and ACP exists to avoid that cost.
  - Disproven if: claude-agent-acp and codex-acp reach parity on questions, steering and plan mode, which would make native code redundant.
- **Git is the universal diff (3).**
  - Steelman: one mechanism gives correct diffs and rewind for every backend.
  - Strongest counter: turn-boundary snapshots interleave badly with a user editing the same worktree, or with agents that commit themselves.
  - Disproven if: snapshot cost on large monorepos is noticeable per turn, or attribution of user edits versus agent edits gets confused in practice.
- **Each turn is a reviewable change (4).**
  - Steelman: it's the converged pattern, and Quirky has half of it built.
  - Strongest counter: users are drifting toward "run the app and check" instead of reading diffs, so per-turn review may go unused.
  - Disproven if: people with the Changes panel today rarely use "Send notes" with terminal agents.
- **Inbox first (5).**
  - Steelman: attention is the stated bottleneck, and the inbox works the same for chat and terminal agents.
  - Strongest counter: Copilot's Agents tab drew requests to disable or move it, and questions often need transcript context to answer.
  - Disproven if: most inbox items still require opening the session, which the agent view's dialog limit hints at.
- **Terminal twin (6).**
  - Steelman: it answers the top complaint at the lowest cost.
  - Strongest counter: a handoff between two views may be stranger than either view alone, and Codex's thread versus CLI resume compatibility is unverified.
  - Disproven if: resume across SDK and CLI loses state such as permission mode or queued messages, or users never flip.
- **Lean by construction (7).**
  - Steelman: it's Quirky's identity, and a measurable one.
  - Strongest counter: users choose agents for the model and the limits, not memory. Performance is a hygiene factor, not a reason to switch.
  - Disproven if: no one cites memory when comparing Quirky to Claude desktop or the Codex app.
- **Same task, different agents (8).**
  - Steelman: only a multi-backend app can do it, and switching is common.
  - Strongest counter: fan-out burns quota that users already complain about, and baton-pass summaries lose context.
  - Disproven if: users try fan-out once and don't repeat it, as the "3x tokens" quote suggests they might not.
- **Quirky owns the history (9).**
  - Steelman: an extension of an existing journal, protecting against vendor churn.
  - Strongest counter: the demand evidence is indirect, and each vendor already keeps its own transcript files.
  - Disproven if: users never search or export across agents once it exists.

## Open questions & gaps

- **Stated demand for a native chat surface is unmeasured.** Neither the research nor the code shows whether Quirky users want chat over their current terminal agents. That question is what the blocked chat ruling waits on.
- **Codex terminal resume is unverified.** Can `codex resume <id>` open a thread that app-server created, and the reverse? Direction 6 depends on it.
- **pi and omp fields are unverified.** Does pi attach `EditDiff` to `tool_execution_end.result.details`? What does omp put in its tool events for edits, and does it expose plan mode over RPC?
- **ACP v2 timing is unknown.** When the adapters adopt v2 affects direction 2's variant (c).
- **No vendor documents the line-comment message the agent receives.** The best format for batched review comments is untested.
- **Snapshot cost on large repos.** Per-turn shadow-ref cost on a big monorepo wasn't measured.
- **Research coverage gaps:**
  - Reddit rate limits cut most comment threads.
  - Brave's llm-context endpoint wasn't available on this key.
  - Praise evidence is much thinner than complaint evidence.
  - Superset/Paradev, Sculptor and Nimbalyst internals weren't found.
  - No builder post-mortems comparing protocol choices turned up.
- **Several star counts look inflated** (Orca 120k, Paradev 16k) and weren't used.

## Sources

Most claims carry inline links above. This list covers the protocol table and key references.

**Protocols**
- ACP agents and adapters — https://agentclientprotocol.com/get-started/agents
- ACP v1 tool calls, permissions, diffs — https://agentclientprotocol.com/protocol/v1/tool-calls
- ACP v1 schema — https://agentclientprotocol.com/protocol/v1/schema
- ACP v2 migration — https://agentclientprotocol.com/protocol/v2/migration.md
- ACP v2 draft announcement — https://agentclientprotocol.com/announcements/acp-v2-draft.md
- ACP clients — https://agentclientprotocol.com/get-started/clients
- Codex app-server docs — https://learn.chatgpt.com/docs/app-server
- Codex app-server README — https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Claude Agent SDK user input and AskUserQuestion — https://code.claude.com/docs/en/agent-sdk/user-input
- Claude Agent SDK streaming — https://code.claude.com/docs/en/agent-sdk/streaming-output
- Claude Agent SDK sessions — https://code.claude.com/docs/en/agent-sdk/sessions
- Claude Agent SDK Python reference — https://code.claude.com/docs/en/agent-sdk/python
- pi RPC — https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
- pi RPC commands — https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc-commands.md
- pi JSON events — https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md
- pi extension UI over RPC — https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md
- pi EditDiff — https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit-diff.ts
- pi-acp — https://github.com/svkozak/pi-acp
- claude-agent-acp — https://github.com/zed-industries/claude-agent-acp
- codex-acp — https://github.com/agentclientprotocol/codex-acp
- omp repo — https://github.com/can1357/oh-my-pi
- omp RPC — https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
- omp CLI reference — https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md
- omp approval modes — https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md
- Zed thread model — https://github.com/zed-industries/zed/blob/main/crates/acp_thread/src/acp_thread.rs
- Zed external agents — https://zed.dev/docs/ai/external-agents
- Happy session protocol — https://github.com/slopus/happy/blob/main/docs/session-protocol.md
- Happy provider envelope redesign — https://github.com/slopus/happy/blob/main/docs/plans/provider-envelope-redesign.md

**Products and catalog**
- Vibe Kanban — https://github.com/BloopAI/vibe-kanban
- cmux — https://github.com/manaflow-ai/cmux
- Conductor — https://conductor.build/
- Happy — https://github.com/slopus/happy
- opcode — https://github.com/winfunc/opcode
- Claude Squad — https://github.com/smtg-ai/claude-squad
- HumanLayer — https://github.com/humanlayer/humanlayer
- Emdash — https://github.com/generalaction/emdash
- Sculptor — https://github.com/imbue-ai/sculptor
- Cline — https://github.com/cline/cline
- Kilo Code — https://github.com/Kilo-Org/kilocode
- Zed — https://github.com/zed-industries/zed
- JetBrains Air — https://jetbrains.com/air/
- Show HN threads (points and comments) — https://hn.algolia.com
- Codex app launch — https://simonwillison.net/2026/Feb/2/introducing-the-codex-app/
- Codex app review pane — https://learn.chatgpt.com/docs/code-review?surface=app
- Claude Code desktop docs — https://code.claude.com/docs/en/desktop
- Claude Code agent view — https://code.claude.com/docs/en/agent-view.md
- Claude Code agent teams — https://code.claude.com/docs/en/agent-teams
- Cline checkpoints — https://docs.cline.bot/features/checkpoints
- Copilot coding agent — https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github
- Cursor Bugbot — https://cursor.com/docs/bugbot

**Quirky code (this worktree)**
- `plugins/quirky.structured/journal.ts`
- `plugins/quirky.structured/claude-runner.ts`
- `plugins/quirky.structured/codex-runner.ts`
- `plugins/quirky.structured/main.ts`
- `plugins/quirky.session/src/window/StructuredView.tsx`
- `plugins/quirky.session/src/window/MessageRow.tsx`
- `plugins/quirky.git/src/daemon/targets.ts`
- `plugins/quirky.git/src/daemon/notes.ts`
- `plugins/quirky.git/src/daemon/notes-format.ts`
- `BRIEF.md`
- `docs/loop/BLOCKERS.md`

---
*Exploration only. To build a direction: invoke `quirk:brainstorming` → an execution skill (which authors a tech spec when warranted, then plans in context).*
