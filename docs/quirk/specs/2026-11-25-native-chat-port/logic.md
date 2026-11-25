# Native chat port: v1's chat view on Orca's engine

This spec covers replacing Orca's native chat in the new Quirky with v1 Quirky's chat. It's written for the owner, who signs it off and uses the result every day, and for the agents that build it. It amends one decision in the [cutover spec](../2026-11-24-orca-based-quirky/logic.md): the port replaces the chat UI and extends Orca's engine instead of replacing the engine.

## What changes for the owner

Every chat tab, on desktop, looks and behaves like v1's chat: the same reading layout, Streamdown replies, folded activity, cards, header, plan mode, visual panel, subagent dock and CodeMirror composer. The things only Orca's chat had stay: rewind, compact, the background tasks panel, find, drafts, attachments and reattach after a restart. The phone, older phone apps, remote workspaces and every headless caller keep working on the same engine they use now.

## Conceptual model

The new chat has three parts, and only the outer one is new code.

1. **Orca's engine stays.** It already provides the structured runtime, the per-session journal, the `agentSession.*` calls, and the adapters for Claude, Codex, pi and the ACP agents (grok, opencode, omp, antigravity). It already handles restart reattach, rewind, compact, background tasks and remote hosting. Desktop, phone, loops, orchestration, automations, CLI and ai-vault keep using it as they do today.
2. **The engine gains v1's missing items** as new journal item kinds:
   - plan versions (waiting, revised, approved, not answered)
   - a turn snapshot (the workspace tree before and after the turn), behind the Changes card
   - mode markers
   - fork lineage
   - visual items from `quirky view`, which pulls the cutover spec's later "view and feedback" port into this one
   - test results, derived from the output of the agent's shell tool
3. **v1's chat view is ported** and restyled with this app's STYLEGUIDE tokens and shadcn primitives. It reads one projection that groups journal items into v1-shaped turns. It re-hosts the Orca view features being kept: find, rewind, drafts, attachments with drag and drop, and IME-safe input.

The cutover spec gave the reason for replacing the engine: "plan mode, transcript paging and the visual panel depend on Quirky's session journal". Orca's journal already pages, and part 2 gives it plan and visual items, so that dependency is met without a new engine.

## How data flows

**Desktop.** The composer sends, queues, steers, approves and stops through Orca's existing calls, so nothing new goes on the wire for those. The engine journals items and the view subscribes, as Orca's view does now. The projection folds items into turns: your message, its activity, the reply, its cards and its turn end. Paging uses the existing history call unchanged.

**Turn snapshot.** At turn start and turn end the host records the workspace tree and stores both on the turn.

- In a git repo, with or without a branch, the snapshot is a tree hash, so a detached checkout works the same as a branch.
- In a folder that isn't a git repo, there's no tree to hash. The Changes card lists the files from the agent's edit tool calls instead.

**Visuals.** An agent runs `quirky view ...`. The CLI writes a visual item to that session's journal through the runtime, and the visual panel renders it.

**Phone and older clients.** The phone reads the same journal frames and gains simple rows for plan, changes, visual and mode. New item kinds are gated by client capability: a client that doesn't declare support for them gets each one as a plain status row, so an older phone app shows "update the app to see this" and never receives an unknown item.

**Remote.** A remote workspace's journal and snapshots live on the host that runs the agent, as they do now. `quirky view` talks to that host's runtime.

## Key decisions and why

1. **Keep Orca's engine, and amend the cutover spec.** The owner's must-haves were the phone and older phone apps on day one, remote, history carried over, headless callers moving the same day, ACP, rewind, compact and background tasks. All of them already work on Orca's engine, and v1's engine has none of them. Owning the code wasn't one of the reasons the owner picked. Replacing the engine was estimated at 30,000 to 50,000 lines plus a lossy history migration.
2. **One projection, not a new wire format.** The view folds Orca's journal items into v1-shaped turns. Desktop, phone and headless callers keep reading the same items, so existing kinds don't change on the wire.
3. **New item kinds are gated by client capability.** That's how an older phone app keeps working: it never receives a kind it doesn't know.
4. **Switch on merge, judge it after.** Orca's chat view is deleted in the same branch, so there's no fallback setting. Done means seven days of real use on desktop and phone after merge without a blocker, and any blocker is fixed forward.
5. **v1's layout and behavior, this app's styling.** The view uses STYLEGUIDE tokens and the shadcn primitives in `src/renderer/src/components/ui/`, so it matches the rest of the app.
6. **The conversation outline rail is dropped.** Orca's chat has one (the message rail beside the transcript), v1 didn't, and none of the day-one picks needs it.

## Behavior and scenarios

### Starting a chat

1. **SC-1: New chat lists only agents that support chat**
   - **Given** Claude and Codex are installed, opencode isn't, and an agent has no chat adapter
   - **When** the owner opens New chat
   - **Then** Claude, Codex, pi, omp and the ACP agents are listed; Claude and Codex can be started; opencode shows its install hint and can't be started; the agent without a chat adapter isn't listed
   - **Screen states:**

     | Row                        | Shown                                                        |
     | -------------------------- | ------------------------------------------------------------ |
     | Claude                     | ✓ ready, Start chat enabled                                  |
     | Codex                      | ✓ ready, Start chat enabled                                  |
     | opencode (ACP)             | ✗ "Not installed" with its install hint, Start chat disabled |
     | Agent with no chat adapter | ✗ not listed                                                 |

### A normal turn

2. **SC-2: A turn reads as one unit**
   - **Given** an open Claude chat
   - **When** the owner sends a message and the agent reads two files, edits one, runs the tests and replies
   - **Then** the turn shows the owner's message, one folded activity row, the reply in Streamdown, a Changes card for the edited file and a Tests card with the result, in that order; cards with nothing to show don't appear
   - **Data before:** **Workspace**: clean at tree A*
   - **Walkthrough:**
     1. The owner sends "fix the date parser"*.
     2. The agent reads two files and edits `parse-date.ts`*. The activity row folds all three.
     3. The agent runs the tests: 41 passed, 0 failed*.
     4. The agent replies. The turn ends and the host records tree B*.
   - **Data after:** **Turn 1**: ✓ message; activity (3 tool calls); reply; Changes card (1 file, tree A to tree B); Tests card (41 passed); no Plan, Visual or Agents card

3. **SC-3: Messages sent mid-turn queue, and the owner can steer or stop**
   - **Given** the agent is working on a turn
   - **When** the owner sends two more messages
   - **Then** both appear in the queue under the composer in send order; each can be removed before it's delivered; steer sends one into the running turn where the agent supports it; stop ends the turn
   - **Data before:** **Turn 3**: running; **Queue**: empty
   - **Walkthrough:**
     1. The owner sends "also update the docs"*. It's queued as item 1.
     2. The owner sends "and bump the version"*. It's queued as item 2.
     3. The owner presses Stop.
   - **Data after:** **Turn 3**: ✓ ended (stopped); **Queue**: [ASK: After Stop, do queued messages stay waiting for the owner, or does the first one send right away?]

4. **SC-4: Approvals and questions appear inline**
   - **Given** an agent asks permission for a command or asks the owner a question
   - **When** the request arrives
   - **Then** it shows inline in the turn with its answer controls, as Orca's chat shows it now, and the answer goes back through the existing calls

### Plan mode

5. **SC-5: Plan revisions are kept as versions**
   - **Given** a Claude chat in plan mode
   - **When** the agent proposes a plan, the owner asks for a revision, and then approves the second version
   - **Then** the plan chip opens the plan panel showing both versions; version 1 is marked revised and version 2 approved; the agent leaves plan mode and starts work
   - **Data before:** **Chat**: plan mode; no plan
   - **Walkthrough:**
     1. The agent proposes **Plan v1**. It's marked waiting.
     2. The owner picks Keep planning with "split step 3"*. **Plan v1** is marked revised.
     3. The agent proposes **Plan v2**. The owner picks Approve.
   - **Data after:** **Plan v1**: revised; **Plan v2**: ✓ approved; **Chat**: ✓ out of plan mode; a mode marker row shows the switch

6. **SC-6: Plan mode is offered only where the agent supports it**
   - **Given** a Codex chat
   - **When** the owner opens the composer's mode list
   - **Then** plan mode isn't offered

### Changes card

7. **SC-7: Changes card in a git workspace**
   - **Given** a git worktree, or a git folder on a detached checkout
   - **When** a turn edits files and ends
   - **Then** the Changes card lists every file that differs between the turn's start and end snapshots, with a diff for each, including files changed by shell commands
   - **Data before:** **Workspace**: tree A*
   - **Walkthrough:**
     1. The agent edits `app.ts`* with its edit tool.
     2. The agent runs a formatter that rewrites `util.ts`*.
     3. The turn ends at tree B*.
   - **Data after:** **Changes card**: ✓ `app.ts`; ✓ `util.ts`

8. **SC-8: Changes card in a folder that isn't a git repo**
   - **Given** a folder workspace with no git repo
   - **When** a turn edits files through the edit tool and also through a shell command, then ends
   - **Then** the Changes card lists only the files from the agent's edit tool calls
   - **Data before:** **Workspace**: plain folder, no git
   - **Walkthrough:**
     1. The agent edits `notes.md`* with its edit tool.
     2. The agent runs a script that rewrites `out.json`*.
     3. The turn ends. No snapshot is taken.
   - **Data after:** **Changes card**: ✓ `notes.md`; ✗ `out.json` not listed, because no tool call named it

9. **SC-9: Turns from before the switch have no Changes card**
   - **Given** an Orca chat started before the switch
   - **When** the owner opens it in the new view
   - **Then** its old turns show no Changes card; turns sent after the switch show one

### Subagents and visuals

10. **SC-10: Subagents show in the dock, then as a card**
    - **Given** the agent starts two subagents
    - **When** they run and then finish
    - **Then** the dock above the composer shows both while they run; once they finish, the dock empties and the turn gains an Agents card listing both with their results

11. **SC-11: An agent shows a visual**
    - **Given** an agent in a chat, local or remote
    - **When** it runs `quirky view` with a page
    - **Then** a visual chip appears in the turn and the visual panel opens it; on the phone the same item shows as a row saying "open on desktop"

### Restart, rewind and compact

12. **SC-12: A chat reattaches after a quit mid-turn**
    - **Given** a chat with a turn running
    - **When** Quirky quits or crashes and is reopened
    - **Then** the chat reopens and reattaches on its own; the cut-off turn ends with an interrupted row; the owner can send again from the composer
    - **Data before:** **Turn 5**: running
    - **Walkthrough:**
      1. Quirky crashes.
      2. The owner reopens Quirky. The chat reattaches.
    - **Data after:** **Turn 5**: ✓ ends with an interrupted row; **Composer**: ✓ ready

13. **SC-13: Rewind uses Orca's existing behavior behind a confirmation**
    - **Given** a chat with several turns
    - **When** the owner clicks Rewind to here on one of their messages and confirms
    - **Then** the chat rewinds as Orca's rewind does now; cancelling the dialog changes nothing

14. **SC-14: Compact is a composer command**
    - **Given** a chat whose context is filling up
    - **When** the owner runs compact from the composer
    - **Then** the chat compacts as Orca's compact does now

### Chat and terminal

15. **SC-15: One conversation moves between chat and terminal in both directions**
    - **Given** a Claude chat tab
    - **When** the owner picks Continue in terminal, works there, then picks Continue as chat on that terminal tab
    - **Then** each move carries the same agent conversation over; the chat shows the turns made in the terminal

16. **SC-16: The composer under an agent terminal**
    - **Given** an agent running in a terminal tab
    - **When** the owner types in the docked composer and sends
    - **Then** the text goes straight to the terminal, with no chat cards; the composer is the same v1 composer as in chat, with its IME handling

### Phone and mixed versions

17. **SC-17: The phone shows the new items simply**
    - **Given** the phone app that declares support for the new kinds
    - **When** a chat has a plan, a Changes card, a visual and a mode switch
    - **Then** the phone shows one simple row for each, and reading, sending, approving and stopping work as they do now
    - **Screen states:**

      | Item               | Phone row                                |
      | ------------------ | ---------------------------------------- |
      | Plan v2 (approved) | ✓ "Plan approved"* with the plan text    |
      | Changes card       | ✓ "2 files changed"* with the file names |
      | Visual             | ✓ "Visual: open on desktop"*             |
      | Mode switch        | ✓ "Switched to plan mode"*               |

18. **SC-18: An older phone app never sees an unknown item**
    - **Given** a phone app built before this change, connected to the new desktop
    - **When** a chat has a plan and a Changes card
    - **Then** each shows as a plain status row reading "update the app to see this"; all other items render as they do now
    - **Data before:** **Phone client**: doesn't declare the new kinds
    - **Walkthrough:**
      1. The host journals **Plan v1** and a **Changes card**.
      2. The host checks the client's declared support and sends each as a status row.
    - **Data after:** **Phone**: ✓ two rows reading "update the app to see this"; ✗ no unknown item reaches the app

### Existing chats

19. **SC-19: Orca chats started before the switch carry over**
    - **Given** an Orca chat from before the switch
    - **When** the owner opens it and presses Resume
    - **Then** its full history shows in the new view, and Resume continues the same agent conversation

20. **SC-20: v1 Electrobun chats are left alone**
    - **Given** chats in `~/.quirky-v1-archive`
    - **When** the new chat ships
    - **Then** nothing reads, moves or changes them

## Screens

The signed-off mock is [mock/mock.html](mock/mock.html), with the inventory in [mock/screens.md](mock/screens.md). Each item below must match the mock.

- **Chat tab**
  - [ ] Default: matches mock
  - [ ] Working: matches mock
  - [ ] Reattached (interrupted row): matches mock
  - [ ] Rewind (confirmation dialog): matches mock
  - [ ] Background tasks panel: matches mock
  - [ ] Find: matches mock
  - [ ] Empty (skipped in the mock): opens with the composer focused and nothing else
  - [ ] Error (skipped in the mock): v1's error row with Restart and Open in terminal
- **Tab menu**
  - [ ] Chat tab menu (Continue in terminal): matches mock
  - [ ] Terminal tab menu (Continue as chat): matches mock
- **New chat**
  - [ ] Default: matches mock
  - [ ] Agent missing (install hint): matches mock
- **Composer over a terminal agent**
  - [ ] Default: matches mock
- **Phone chat**
  - [ ] Default (simple rows): matches mock
  - [ ] Older app (fallback rows): matches mock

These mocked elements have no component in the repo yet, so each is an open question for the build:

- [ASK: Which component does the mode marker row use? None exists yet.]
- [ASK: Which component does the background tasks panel use in the ported view? Orca's panel lives in the deleted chat view.]
- [ASK: Which component does the interrupted-turn row use? None exists yet.]
- [ASK: Which component does the not-installed hint on New chat use? None exists yet.]
- [ASK: Which mobile components do the phone's plan, changes, visual and fallback rows use? None exist yet.]

## In scope and out of scope

**In scope, all on one branch and merged together:**

- the engine additions: plan versions, turn snapshots, mode markers, fork lineage, visual items and test results
- the capability flag for the new kinds, and the fallback rows older clients get
- the ported v1 view and composer, restyled, with find, rewind, drafts, attachments and IME re-hosted
- the `quirky view` CLI writing to the session journal
- simple phone rows for the new kinds
- the composer in the terminal dock
- the amendment to the cutover spec

**Deleted in the same branch:**

- Orca's chat view (`src/renderer/src/components/native-chat`), except the hooks the projection reads
- the PTY bridge view (the transcript decoders and readers stay; see Amendments)
- `fork-agent-composer`
- the terminal-dock composer
- thread goal

**Out of scope:**

- rebuilding the phone chat UI; the phone only gains simple rows
- v1 Electrobun chats
- replacing the engine
- the conversation outline rail
- a fallback setting for the old chat
- Changes cards for turns from before the switch

**Reliability checks.** The owner picked Orca chat reliability as a reason for the port but didn't name specific failures. The code review found no logged engine bugs. The known composer and view issues become checks the port must pass:

- BUG-1: reattach quarantine covers every PTY-swap path, and docked-composer sends respect it
- DEFER-1: refocusing a visible window returns focus to the docked composer
- TEST-5: IME composition and composer remount get real tests in the ported composer

## Decisions Locked

**Scope and approach**

- v1's chat view runs on Orca's engine; the engine gains v1's missing items; the cutover spec's "replace engine and UI" line is amended
- v1 features on day one: plan mode, visual panel (pulls in `quirky view`), subagents, turn Changes card
- Visual style: v1 layout and behavior, STYLEGUIDE tokens and shadcn primitives (assumed from AGENTS.md)
- Conversation outline rail: dropped (assumed)

**Agents**

- Day-one agents: Claude, Codex, pi, omp, plus the ACP agents (grok, opencode, antigravity)
- Orca-only features kept: rewind, compact, background tasks panel; thread goal dropped
- An agent without chat support isn't offered for chat

**Mobile and remote**

- The phone keeps reading, sending, approving and stopping on switch day
- An older phone app keeps working against a newer desktop
- Remote runtimes are supported on day one
- Today's mobile chat screens stay, with simple renderings of the new items

**History**

- Orca chats from before the switch carry over with history, and Resume continues the same conversation
- v1 Electrobun chats are left behind, untouched
- After a quit or crash, chats reopen and resume on their own, and the cut-off turn is marked interrupted
- Chat-to-terminal and terminal-to-chat both stay

**Dependents**

- Loops, orchestration, automations, CLI launch and ai-vault stay on the same engine, so they move the same day
- The PTY bridge view is dropped; Continue as chat covers it
- v1's composer goes everywhere the owner types to an agent, the terminal dock included

**Purpose, success and cutover**

- Why: UI feel, v1 features Orca lacks, Orca chat reliability (owning the code wasn't picked)
- One switch on merge, no fallback setting; built on one branch
- Done: seven days of real use on desktop and phone after merge without a blocker; blockers are fixed forward
- UX review: signed off at mock v1 (Looks right, all five screens visited, no pins)

## Industry Insights

Research ran in two parts: web research on agent chat apps and on replacing a forked subsystem, then a validation pass that read both codebases for each candidate approach.

- **Desktop agent apps wrap the vendor's own interface and keep the vendor's transcripts.** Zed, Conductor, opcode, Crystal and harnss drive the Claude Agent SDK, the Codex app-server or ACP and leave session files with the vendor. No shared event schema exists beyond ACP's `session/update`. Orca's engine and v1's both already follow this pattern, so transport didn't separate the approaches. Sources: https://zed.dev/blog/claude-code-via-acp, https://github.com/zed-industries/zed/blob/main/docs/src/ai/external-agents.md, https://github.com/zed-industries/codex-acp, https://agentclientprotocol.com/protocol/v1/overview, https://agentclientprotocol.com/protocol/session-setup, https://code.claude.com/docs/en/agent-sdk/sessions, https://code.claude.com/docs/en/headless, https://learn.chatgpt.com/docs/app-server, https://www.conductor.build/docs, https://github.com/winfunc/opcode, https://github.com/stravu/crystal/blob/main/CLAUDE.md, https://github.com/OpenSource03/harnss
- **One report says Claude transcripts are deleted after 30 days.** It's a single third-party source, so it's unconfirmed. It matters only if old chats' history depends on vendor files, and Orca's journal keeps its own copy. Source: https://ccassist.dev/blog/where-claude-code-stores-conversations/
- **Port the data layer before the UI, and don't copy old behavior wholesale.** Strangler-fig and parallel-change write-ups agree, and reports from Electron rewrites show behavior copied line by line carries the old bugs along. This design keeps the data layer and ports the view. Sources: https://martinfowler.com/bliki/StranglerFigApplication.html, https://martinfowler.com/bliki/ParallelChange.html, https://gpui-starter.freeoxide.com/blog/migrating-electron-to-rust/, https://kettanaito.com/blog/electron-to-pwa-and-back-again
- **A cutover flag works only with a scheduled removal, and a dual-write window is where migrations fail.** The owner chose no flag at all, and keeping the engine means no history migration and no dual write. Sources: https://martinfowler.com/articles/feature-toggles.html, https://dev.to/freddie_thompson_e0488262/zero-downtime-database-migration-the-dual-write-window-is-where-it-goes-wrong-5dm1
- **Long-lived forks get expensive when they keep syncing.** Quirky no longer syncs upstream, so this caution doesn't constrain the design, but it's why the cutover spec dropped sync tooling. Sources: https://open-energy-transition.github.io/handbook/docs/Engineering/SoftForkStrategy/, https://dev.to/bengreenberg/lessons-learned-from-maintaining-a-fork-48i8, https://lobste.rs/s/yav1ky/those_who_have_maintained_forks_oss_at, https://dl.acm.org/doi/10.1145/3377813.3381362
- **Codebase validation.** Keeping Orca's engine is feasible: the missing pieces are the six new item kinds, and the biggest risk is the re-hosted view features (find, rewind, drafts, drag and drop, IME). Replacing the engine was estimated at 30,000 to 50,000 lines, three to five times v1's engine, with lossy history migration. Running v1's runners inside Orca's host was rejected because it throws away the engine's crash safety for no gain.

Coverage gaps: Brave's context endpoint wasn't available on the plan, two Reddit queries failed, the ICSE 2020 paper returned 403, and no source covered routing a flag between Electron renderers.

## Deferred Ideas

- [tech-spec] Does the engine have a call to reorder queued messages, or does v1's queue reorder need one?
- [tech-spec] Where does the header's cache timer get its data on each agent?
- [tech-spec] Does today's shipped phone app tolerate an unknown item kind, or does it fail? Capability gating covers it either way, but the answer sets how strict the gate's tests must be.
- [tech-spec] How is the turn snapshot recorded in a git folder without a branch, and how is it cleaned up?
- [tech-spec] Which journal kinds can a remote host older than the desktop send, and how does the desktop render a session from such a host?
- Re-adding the conversation outline rail if the week of use shows a need.

## Glossary

- **Engine:** Orca's structured agent runtime. It runs agents through their adapters, journals what happens, and serves the `agentSession.*` calls.
- **Journal:** the per-session record of items in SQLite, on the host that runs the agent.
- **Item kind:** one type of journal entry, such as message, tool call, plan or turn snapshot.
- **Projection:** the view-side code that groups journal items into v1-shaped turns.
- **Turn snapshot:** the workspace tree recorded at turn start and end. The Changes card is built from it.
- **Capability gating:** the host sends new item kinds only to clients that declare support for them, and every other client gets a plain status row.
- **Bridge path:** Orca's older chat mode, which rebuilt a chat from the agent's on-disk transcript beside a terminal. It's deleted.
- **Terminal dock:** the composer shown under an agent terminal tab.
- **Interrupted row:** the marker that ends a turn cut off by a quit or crash.

## Status & amendments

Status: Approved (2026-11-25), signed off with the SC-3 queue-after-Stop question and the five component gaps open for the build. Tech spec: written ([tech.md](tech.md)); gate fired because the work crosses the engine, desktop view, CLI and phone and spans more than one session

**Amendments:**

- 2026-11-25: Two corrections found while writing the tech spec. No decision changed.
  - The transcript decoders and readers in `src/main/native-chat/` stay. Legacy history import, ai-vault, orchestration worker reads and Claude rewind use them, and `nativeChat.*` serves shipped phone apps. Only the bridge view is deleted, which is what Decisions Locked says.
  - The outline rail being dropped is Orca's message rail, not a v1 feature. v1 never had one.
