# Subagents in native chat

## Status & amendments

**Status:** Draft, awaiting review.

**Amendments:** none yet.

## Purpose

When the agent in a native chat starts subagents, you should be able to see what each one is doing, answer it, stop it, and read what it did, without its work flooding the main conversation.

Today none of that is possible. A Claude subagent's reads, edits and test runs land loose in the parent turn, mixed with the main agent's and with other subagents'. The Agent call itself reads "Used 1 other tool". A background agent's row goes done the moment it launches. Codex sub-agent threads are dropped entirely.

The reader of this spec is the person approving what gets built. The tech spec, written at execution, owns where the code lives and its contracts.

## Conceptual model

A **subagent** (just "agent" in this spec) is an agent the session's agent starts to do part of the work. It has:

- a name, such as Explore or test-runner
- the task it was given and the model it runs on
- a parent: the main agent or another agent
- a state: working, needs you, quiet, done, failed or stopped
- elapsed time and tokens
- its own items: prose, activity, cards and asks, the same kinds a turn holds

**Every chat item records the agent that produced it.** Items with no agent belong to the main agent. Three surfaces read those items:

- **The main turn** shows main-agent items, plus a quiet **spawn marker** where each agent started and a **return marker** where it ended.
- **The dock**, one line above the composer, summarizes the agents that are running now.
- **The Agents card** in the visual panel lists every agent in the chat and shows the selected agent's transcript, drawn by the same renderer as the main chat.

## Data flow

1. The session's agent starts an agent. Each agent type signals this differently:
   - Claude Code uses the Agent tool.
   - Codex makes a collab call and opens a child thread.
   - pi reports `subagents_update`.
   - omp uses its Task tool.

   Quirky journals a spawn item with the name, task, model and parent.
2. Every event from inside that agent is tagged with the agent's stable id and journaled in the same session journal as everything else. There is no second store.
3. State changes update the agent's state: it started, it asks, it went quiet, it ended. About every 30 seconds a small model rewrites the agent's current-action line from its recent events. A setting falls back to showing the latest tool call instead.
4. The dock, the markers, the Agents card and the header totals are all computed from journaled items. A reopened chat therefore rebuilds them exactly.

## Key decisions

- **Tagged items in one journal**, chosen over a hidden child session per agent and over reading Claude's own subagent transcript files.
  - It is the only option that works for all four agents, rebuilds exactly on reopen, and adds no rows to any session list.
  - Child sessions were the most future-proof option. In other products, though, they leaked into session lists and let a child's status bleed into the parent.
  - Claude's files are undocumented and deleted after 30 days, and they cover Claude only.
- **Live state in a dock, not a card in the turn.** The turn stays readable prose. The quiet markers keep cause and effect visible when you reread it later.
- **One Agents card in the panel, not a tab per agent.** It scales to Claude's default of 20 concurrent agents without flooding the strip the visuals share.
- **Asks surface in the main turn, labeled with the agent.** Claude and Codex both do this. Cursor showed what goes wrong without it: a permission prompt inside an expanded card loses its Allow button.
- **Read-only transcripts.** Copilot and Codex do the same. Follow-ups go to the main agent, which avoids messages that never reach the agent's transcript.
- **AI-written current action, with an off switch.** It reads better than a raw tool call. The setting exists because summary cost is a known complaint.
- **Research traps become rules.** Each rule below caused a published bug in another product:
  - Streaming text is kept per agent, because parent and child text crossed wires in t3code.
  - A finishing agent never settles the chat, because a child's completion marked the whole chat ready in bridge-harness.
  - An event whose parent is unknown is never dropped, because hapi orphaned 48 of 69 subagent messages.

## Behaviour & scenarios

### Watching agents work

1. **SC-1 One agent from start to finish**
   - **Given** a Claude chat with the visual panel collapsed
   - **When** you ask a question and Claude starts an Explore agent
   - **Then** the turn shows a spawn marker with a live dot. The dock appears with "1 agent". When Explore reports, a return marker joins the turn, the dock hides, and Explore moves to the card's Done group. None of Explore's own reads or searches appear in the turn.
   - **Data before:** **Turn 3**: your message; **Dock**: hidden; **Agents card**: absent
   - **Walkthrough:**
     1. You send "Where do auth tokens refresh?"
     2. Claude starts Explore with the task "Find where auth tokens refresh"
     3. Explore reads 4 files and searches 2 patterns
     4. Explore reports "Found 3 refresh handlers"
   - **Data after:** **Turn 3**: ✓ "Spawned Explore · Find where auth tokens refresh"; ✓ "Explore returned · Found 3 refresh handlers"; ✗ no Read or Grep rows; **Dock**: ✓ hidden; **Agents card**: ✓ "Agents 1", Explore under Done

2. **SC-2 Three agents in parallel, one asks**
   - **Given** a Claude chat
   - **When** Claude starts Explore, test-runner and reviewer at once, and test-runner asks to run a command
   - **Then** the turn shows three spawn markers and an ask card labeled "test-runner asks". The same ask appears in the Questions panel and the status bar's needs-you count. The dock reads "3 agents · 1 needs you" with an amber dot. Allowing the command clears it.
   - **Data before:** **Dock**: hidden
   - **Walkthrough:**
     1. Claude starts the three agents
     2. test-runner asks to run "bun test src/auth"
     3. You click Allow on the ask card
   - **Data after:** **Ask card**: ✓ answered; **Dock**: ✓ "3 agents", green dot; **test-runner row**: ✓ "Running bun test src/auth"

3. **SC-3 Twelve agents fold**
   - **Given** a chat where the agent starts 12 auditors, one per plugin
   - **When** they run, with 2 asking, 1 quiet and 3 finished
   - **Then** the 12 spawn markers fold into one line with live counts, which expands on click. Return markers fold the same way once there are 4 or more. Each ask is still its own card. The dock stays on one line, and the card's Running group sorts agents that need you first.
   - **Screen states:**

     | Surface | Shows |
     |---|---|
     | Turn | ✓ "Spawned 12 agents · 9 running · 2 need you · 1 quiet · 3 done" ▸ |
     | Asks | ✓ two cards: "audit ask asks", "audit accounts asks" |
     | Dock | ✓ "9 agents (+2) · 2 need you · 1 quiet" |
     | Agents card | ✓ Running · 9, needs-you first, then quiet, then working; ✓ "Done · 3" collapsed |

4. **SC-4 A nested agent asks**
   - **Given** "audit vault" has started two agents of its own, "trace callers" and "check tests"
   - **When** "trace callers" asks for permission
   - **Then** its ask card in the main turn is labeled "trace callers asks". In the card, "trace callers" is indented under "audit vault", and the "audit vault" row adds "child needs you". The dock counts nested agents in brackets, as in "(+2)", and still says "1 needs you".

5. **SC-5 Nothing loose in the main turn**
   - **Given** three agents running in parallel while the main agent also works
   - **When** the agents read files, edit files, run tests and stream text
   - **Then** ✗ none of that appears in the main turn. ✓ Each agent's activity, file-change and test cards, and prose appear only in its own transcript. ✓ The main agent's streaming text never contains an agent's text.

### Drilling in and control

6. **SC-6 Opening an agent**
   - **Given** a running chat with the visual panel collapsed
   - **When** you click (a) the dock, (b) a spawn or return marker, or (c) "Open test-runner" on an ask
   - **Then** the panel expands to the Agents card. (a) selects the first agent that needs you, or else the first running one. (b) and (c) select that agent.

7. **SC-7 The selected agent's transcript**
   - **Given** Explore is selected in the Agents card
   - **When** you read its transcript
   - **Then** the header shows Explore, its task, model, elapsed time and tokens, plus Stop while it runs. Below that, its transcript is drawn like the main chat:
     - the prompt it was given, folded
     - activity groups
     - file-change and test cards
     - spawn markers for its own agents
     - its report
   - A running agent ends with its live current-action line. There is no composer.

8. **SC-8 Stopping one agent**
   - **Given** Explore (with a nested grep-helper), test-runner and reviewer are running
   - **When** you click Stop on Explore's header, or on its row when you hover over it
   - **Then** Explore and grep-helper stop and show "Stopped by you". test-runner, reviewer and the turn keep going. The composer's "Stop turn" still stops everything.
   - **Data before:** **Explore**: working; **grep-helper**: working; **test-runner**: working; **reviewer**: working
   - **Walkthrough:**
     1. You hover Explore's row and click Stop
   - **Data after:** **Explore**: ✓ stopped; **grep-helper**: ✓ stopped; **test-runner**: working; **reviewer**: working; **Turn**: still working

9. **SC-9 Current-action line**
   - **Given** an agent working through several tool calls
   - **When** (a) the summary setting is AI-written, the default, or (b) it is set to the latest tool call
   - **Then** (a) the row reads like "Tracing where tokens refresh" and is refreshed about every 30 seconds. (b) It reads like "Grep "refresh(" src/" and updates on every tool call.

10. **SC-10 Tokens**
    - **Given** a chat where the main agent used 31.4k* tokens and three agents used 28.0k* together
    - **When** you look at the header and an agent's card header
    - **Then** the chat header total reads 59.4k, and its tooltip splits it into main 31.4k and subagents 28.0k. Each agent's card header shows its own tokens.

### Lifecycle

11. **SC-11 A background agent outlives the turn**
    - **Given** Claude starts reviewer in the background and finishes its reply
    - **When** the turn ends
    - **Then** the turn closes normally. The header reads "Ready · 1 agent running", the dock shows "1 agent", and you can send messages. When reviewer ends, its return marker joins the turn that spawned it and the dock hides.
    - **Screen states:**

      | Moment | Header | Dock | reviewer |
      |---|---|---|---|
      | turn ends | ✓ Ready · 1 agent running | ✓ 1 agent | ✓ working |
      | reviewer reports | ✓ Ready | ✓ hidden | ✓ Done, return marker in its turn |

12. **SC-12 A quiet agent is flagged**
    - **Given** reviewer is running
    - **When** 2 minutes pass with no events from it, and no tool call of its is still in progress
    - **Then** its row shows "quiet 2m" in amber, counting up, and the dock adds "1 quiet". The flag clears on its next event.

13. **SC-13 An agent fails**
    - **Given** test-runner is running
    - **When** it ends with an error
    - **Then** its dot turns red and it moves to Done marked "failed". While others still run, the dock adds "1 failed". The return marker reads "test-runner failed" with the first line of the error.

14. **SC-14 Reopening a chat**
    - **Given** a chat whose reviewer was still running when Quirky quit
    - **When** you reopen the chat
    - **Then** the markers, the Agents card and the totals are rebuilt from the journal. reviewer shows "stopped · cut off", and ✗ nothing shows as running.

15. **SC-15 A spawn is refused**
    - **Given** a Claude chat already running 20 agents
    - **When** Claude tries to start a 21st and gets "Concurrent subagent limit reached"
    - **Then** the spawn marker shows the refusal in red, and no row is added to the card. Depth-limit refusals behave the same.

16. **SC-16 An event whose parent is unknown**
    - **Given** an agent event that names a parent Quirky has no record of
    - **When** it arrives
    - **Then** it goes to an "Unattributed" agent in the card. ✗ It is never dropped and never shown loose in the main turn.

### Across agents

17. **SC-17 Every agent shows its subagents as far as it reports them**
    - **Given** a native chat with (a) Claude Code, (b) Codex, (c) pi or (d) omp
    - **When** the agent starts a subagent
    - **Then** (a) and (b) get everything in this spec, with Codex's child-thread events kept instead of dropped. (c) and (d) get markers, dock, rows and states. If they also report a subagent's steps, they get its transcript too. If they don't, the card shows the row with the note "This agent doesn't report its subagents' steps".

## Screens

The signed-off mock is `mock/mock.html` (v2), and the inventory is `mock/screens.md`. Each state below passes when it matches the mock.

| Screen | State | Acceptance |
|---|---|---|
| Chat turn | three agents running, one asks | matches mock scenario 1 |
| Chat turn | turn ended, background agent | matches mock scenario 2 |
| Chat turn | twelve agents, folded | matches mock scenario 6, folded and expanded |
| Chat turn | all finished, one failed | matches mock scenario 4 |
| Dock | running / needs you / quiet / hidden | matches scenarios 1, 3 and 6, hidden in 4 |
| Chat header | Working / Ready · N agents running / Done | matches scenarios 1, 2 and 4; token tooltip splits main and subagents |
| Agents card: list | working, needs you, quiet, failed, stopped, child needs you, Done collapsed | matches scenarios 1 to 6 |
| Agents card: transcript | running, done, failed, stopped | matches scenarios 1, 4 and 5 |

**Open questions from component gaps** (for the tech spec):
- The spawn/return marker row and the folded spawn line have no repo component. Should they reuse `CommandLine` or be new?
- The dock row is new. Does it share chrome with the composer's queued list?
- The visual panel has only visual cards plus the hard-coded Plan card. The Agents card is a new card kind there.

## Scope & non-goals

**In v1:** the desktop native chat, for Claude Code, Codex, pi and omp, each as far as it reports subagents.

**Not in v1:**
- the mobile app
- terminal (PTY) sessions
- per-agent budgets, limits or pause-and-ask
- side-by-side agent transcripts
- messaging an agent directly
- opening an agent as its own tab

**Success means:**
- Nothing an agent does appears loose in the main turn. It shows only in its markers and its transcript.
- With 3 or more parallel agents, the dock alone tells you which one needs you.
- A background agent shows running until it really ends. It doesn't go done at the launch ack or close with the turn's result.

## Decisions Locked

**Where an agent lives**
- Live state sits in a dock above the composer. No card in the turn.
- The turn keeps a quiet spawn marker and a return marker.
- The dock is one summary line. You open it to tell agents apart.
- The visual panel holds one Agents card: the list plus the selected agent's transcript.
- Nested agents indent under their parent in the card. The dock counts top-level agents, with nested ones in brackets.

**What a row shows**
- List row: name, state, current action and elapsed time.
- Dock: count, plus anything that needs you, is quiet or failed.
- Tokens: in the selected agent's header, and rolled into the chat header total.
- The transcript renders like the main chat.
- The current action is AI-written, about every 30 seconds.

**Drilling in and control**
- Clicking the dock opens the Agents card. Markers and ask links open it with that agent selected.
- An agent's permission prompts go in the main turn and the Questions panel, labeled with the agent.
- Stop is in the selected agent's header and on row hover. It also stops that agent's descendants.
- Transcripts are read-only. Follow-ups go to the main agent.

**Lifecycle**
- A background agent stays live after the turn ends, and the header reads "Ready · N agents running".
- The dock hides when nothing runs. The card keeps a Done group for the session.
- An agent with no events for 2 minutes is flagged "quiet Nm" in amber.
- On reopen, the card is rebuilt from the journal, and agents cut off by the restart show stopped.

**Scope and success**
- All four agents, each as far as it reports subagents.
- Not in v1: mobile, PTY sessions, budgets and limits, side-by-side transcripts.
- The AI summary is on by default. A setting falls back to the latest tool call.
- Success criteria: nothing loose in the main turn; the dock alone shows which agent needs you; background agents show running until they end.

**Approach and review**
- Approach: tagged items in one journal.
- UX review signed off at mock v2. v2 added the 12-agent scenario, folded markers, attention-first sorting and a collapsed Done group.
- Gray areas came from the standard set; adhd wasn't run.

## Industry Insights

- **The common pattern** is one collapsed row per spawn with a live current-action line, the child's transcript opened read-only on demand, child permission prompts raised to the top with the child's name, and status and cost rolled up. Sources: [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents), [Claude Code in VS Code](https://code.claude.com/docs/en/vs-code), [VS Code subagents](https://code.visualstudio.com/docs/agents/run/subagents), [GitHub Copilot session visibility](https://github.blog/changelog/2026-03-19-more-visibility-into-copilot-coding-agent-sessions/), [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
- **The top complaints:**
  - You can't see what a subagent is doing now ([claude-code #92136](https://github.com/anthropics/claude-code/issues/92136), [#74257](https://github.com/anthropics/claude-code/issues/74257)).
  - Background agents go silent for 15 minutes or more, or are lost ([#95730](https://github.com/anthropics/claude-code/issues/95730), [#75165](https://github.com/anthropics/claude-code/issues/75165)).
  - There are no per-agent tokens ([#106025](https://github.com/anthropics/claude-code/issues/106025)).
  - Verbose modes either flood the transcript or hide everything ([#77326](https://github.com/anthropics/claude-code/issues/77326)).
- **Permission prompts belong at the top level.** Cursor hid one inside an expanded card and its Allow button disappeared ([Cursor forum](https://forum.cursor.com/t/subagent-permission-request-allow-button-disappears-if-expanding-the-subagent/171872)).
- **Summary cost matters.** Claude cut its status-summary cost by about 99% after complaints, and users asked for an off switch ([HN thread](https://news.ycombinator.com/item?id=50284255)).
- **Single tagged stream: the SDK contract.**
  - Child messages carry `parent_tool_use_id`, and in TypeScript `agent_id`. Match on `agent_id`, because it survives a resume.
  - `background_tasks_changed` carries the full live set.
  - Background launches return `async_launched`.

  Source: [Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript), [Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents).
- **Single tagged stream: traps.**
  - Parent and child streaming text crossed wires ([t3code #5395](https://github.com/pingdotgg/t3code/issues/5395)).
  - A child's completion reset the main stream ([clawed-abode #497](https://github.com/brendanlong/clawed-abode/issues/497)).
  - A child's turn end marked the chat ready ([bridge-harness #943](https://github.com/Atharva-Kanherkar/bridge-harness/issues/943)).
  - Orphaned messages were dropped ([hapi #1904](https://github.com/tiann/hapi/issues/1904)).
- **Child sessions: costs.**
  - Children leaked into session lists ([VS Code #347327](https://github.com/microsoft/vscode/issues/347327)).
  - Grandchildren were hidden ([T3 Code #6689](https://github.com/pingdotgg/t3code/discussions/6689)).
  - Processless rows burden every session consumer ([bridge-harness #943](https://github.com/Atharva-Kanherkar/bridge-harness/issues/943)).
- **Claude transcript files: costs.**
  - The format is undocumented ([docs](https://code.claude.com/docs/en/sub-agents)).
  - Writes stayed partial for an hour ([#97763](https://github.com/anthropics/claude-code/issues/97763)).
  - Nested transcripts mis-render ([#98643](https://github.com/anthropics/claude-code/issues/98643)).
  - Files are deleted after 30 days.
- **Limits:** Claude defaults to 3 nesting levels and 20 concurrent subagents (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).

## Deferred Ideas

- Opening an agent as its own tab.
- Per-agent budgets, step limits and pause-and-ask.
- Side-by-side agent transcripts.
- Messaging a running agent directly.
- Subagents in the mobile app and in PTY sessions.
- `[tech-spec]` What exactly pi (`subagents_update`) and omp (Task tool) emit, and whether they report a subagent's steps.
- `[tech-spec]` Whether Codex default sessions need `multi_agent` enabled, and how child-thread events map to agent ids.
- `[tech-spec]` How streaming deltas are keyed per agent. Today every delta shares one key, `assistant`.
- `[tech-spec]` The summary model, the cadence, and what context it reads.
- `[tech-spec]` Whether the agent-status `Child` model or `background_tasks_changed` is the liveness source for background agents.
- `[tech-spec]` The quiet threshold's interaction with long-running tool calls.

## Glossary

- **Agent** (in this spec): a subagent started by the session's agent, or by another agent.
- **Spawn marker / return marker**: the muted lines in a turn where an agent started and ended.
- **Folded line**: one line standing in for 4 or more consecutive markers, with live counts.
- **Dock**: the one-line agent summary above the composer, shown only while an agent runs.
- **Agents card**: the visual-panel card listing every agent in the chat, with the selected agent's transcript.
- **Quiet**: no events from an agent for 2 minutes while no tool call of its is in progress.
- **Cut off**: stopped because Quirky or the agent process quit, not by you.
- **Unattributed**: the catch-all agent for events whose parent Quirky can't find.
