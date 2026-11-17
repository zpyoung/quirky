# Claude plan mode in native chat

A Claude chat in the desktop app can plan before it edits. Claude's plan opens in a panel beside the chat, the conversation keeps going while the plan waits, and one click approves it and switches Claude into the mode that implements it.

This spec is for whoever builds and checks plan mode. It says what the person in the chat sees and does, not how it's built. It extends the [agent chat](../2026-11-16-agent-chat/logic.md) and [chat input redesign](../2026-11-16-chat-input-redesign/logic.md) specs, and replaces their separate Plan switch with one Mode list.

## The model

A Claude chat is always in exactly one **mode**: Ask, Accept edits, Auto (when Claude offers it) or Plan. The composer shows the mode Claude reports, never a flag kept beside it.

In Plan, Claude reads and talks but doesn't change files. When it's ready, it presents a **plan**. Each presentation is a new **plan version** in the chat's history, with one status:

- **waiting**: Claude is paused until the user answers.
- **revised**: a newer version replaced it.
- **approved**: the user approved it, into a named mode.
- **not answered**: it closed without an approve or keep-planning answer.

At most one version is **live**: the newest one still waiting. The **plan panel** to the right of the chat shows the newest version, and the transcript shows a one-line row per version. Leaving Plan by approval takes a click on an approve exit in the panel. The user can still switch modes by hand.

Only Claude chats get plan mode. Codex, pi and omp keep Plan disabled with their current reasons.

## How a plan moves through the chat

1. The user picks Plan (Mode list, `/plan`, Shift+Tab, or before the first message), or Claude enters Plan on its own. The mode badge shows Plan.
2. Claude researches, writes its plan and asks to leave plan mode. Quirky takes the plan text from Claude's plan file at that moment, records **plan vN, waiting**, adds the transcript row, opens the panel, and the header chip reads "Plan · vN waiting".
3. The user answers with one of three **exits** in the panel:
   - **Approve, auto mode**: Quirky approves and switches Claude to Auto, or Accept edits when Auto isn't available, in the same reply. Claude starts implementing in the same turn.
   - **Approve, review edits**: the same, into Ask.
   - **Keep planning**, with text. A message typed in the composer while a plan waits counts as Keep planning with that message. Claude stays in Plan, replies in the chat, and usually presents again.
4. A new presentation marks the previous version **revised** and opens vN+1 in the panel.

Approval switches the mode in one step because there's no state where the user has approved but Claude can't act yet. Plan text comes from the plan file because the text Claude sends with the request can be empty or out of date.

## Scenarios

### Entering Plan

1. **SC-1 One Mode list**
   - **Given** a Claude chat
   - **When** the user opens the settings popover
   - **Then** it shows one Mode list: Ask, Accept edits, Auto, Plan. There's no separate Plan switch. Auto is disabled with a reason on hover when Claude doesn't offer it.
2. **SC-2 Shift+Tab cycles modes**
   - **Given** the composer has focus in a Claude chat
   - **When** the user presses Shift+Tab
   - **Then** the mode moves to the next available one in list order and wraps around, skipping disabled modes. Shift+Tab never approves a plan, and a waiting plan doesn't change what it does.
   - **Walkthrough:**
     1. Mode is Ask; the user presses Shift+Tab. ✓ Accept edits
     2. Shift+Tab again. ✓ Auto
     3. Shift+Tab again. ✓ Plan
     4. Shift+Tab again. ✓ Ask
3. **SC-3 /plan toggles**
   - **Given** a Claude chat in any mode
   - **When** the user runs `/plan`
   - **Then** (a) from a mode other than Plan, the chat enters Plan; (b) from Plan, the chat returns to the mode it was in before Plan, or Ask when there was none.
4. **SC-4 A new chat can start in Plan**
   - **Given** the New chat composer with Plan picked
   - **When** the user sends the first message
   - **Then** Claude starts in Plan, so the first turn can't change files.
5. **SC-5 Claude enters Plan itself**
   - **Given** a Claude chat in Ask, Accept edits or Auto
   - **When** Claude switches itself into plan mode
   - **Then** the mode badge changes to Plan with no prompt, the same as if the user had picked it.

### Presenting and answering a plan

6. **SC-6 A plan arrives**
   - **Given** a chat in Plan
   - **When** Claude presents a plan
   - **Then** a new waiting version is recorded, the transcript gets a "Plan ready (vN)" row, the panel opens on it with the three exits, and the header chip reads "Plan · vN waiting".
   - **Data before:** **Chat**: mode Plan; no plan versions
   - **Data after:** **Chat**: mode Plan; **Plan v1** ✓ waiting; panel ✓ open; chip ✓ "Plan · v1 waiting"
7. **SC-7 Approve, auto mode**
   - **Given** plan v3 waiting
   - **When** the user clicks Approve, auto mode
   - **Then** v3 becomes approved into Auto, or into Accept edits when Auto isn't available. In the same turn the badge shows the new mode and Claude starts implementing, with no further message from the user. The panel stays open on v3 without buttons. The transcript row reads "Plan approved (v3) · auto mode".
   - **Data before:** **Chat**: mode Plan; **Plan v3** waiting
   - **Data after:** **Chat**: ✓ mode Auto; **Plan v3** ✓ approved, auto mode; buttons ✗ hidden
8. **SC-8 Approve, review edits**
   - **Given** plan v3 waiting
   - **When** the user clicks Approve, review edits
   - **Then** the same as SC-7, except the chat lands in Ask and Claude asks before each edit.
9. **SC-9 Keep planning from the panel**
   - **Given** plan v2 waiting
   - **When** the user clicks Keep planning, types "Split step 2" and clicks Send to Claude
   - **Then** Claude gets the text as the reason the plan wasn't approved and stays in Plan. When Claude presents again, v2 becomes revised and v3 opens in the panel marked revised or unchanged against v2.
   - **Data before:** **Chat**: mode Plan; **Plan v2** waiting
   - **Walkthrough:**
     1. The user clicks Keep planning; the feedback box opens in the panel.
     2. The user sends "Split step 2". **Plan v2** stops waiting.
     3. Claude replies in the chat and presents again.
   - **Data after:** **Chat**: mode Plan; **Plan v2** ✓ revised; **Plan v3** ✓ waiting, marked revised
10. **SC-10 Talking while a plan waits**
    - **Given** plan v2 waiting
    - **When** the user sends "Does this survive an app restart?" from the composer
    - **Then** it's handled as Keep planning with that message (SC-9). Claude answers in the chat. If it presents again with no change, v3 is marked unchanged.
11. **SC-11 Claude replies without presenting again**
    - **Given** the user sent Keep planning feedback on v2
    - **When** Claude ends its turn without presenting a plan again
    - **Then** v2 shows as not answered with no buttons, and the chip reads "Plan · waiting for Claude". The chat stays in Plan.
12. **SC-12 Approval is click-only**
    - **Given** plan v2 waiting and the user typing in the composer
    - **When** the user presses any key, including Enter, Shift+Tab, 1, 2 or 3
    - **Then** no exit is chosen. The composer keeps focus and its text.
13. **SC-13 Revisions collapse**
    - **Given** v1 and v2 were revised and v3 waits
    - **When** the user looks at the transcript
    - **Then** v1 and v2 show as one-line "Revised" rows that open that version in the panel read-only. Only v3 has exits.

### Leaving without approval

14. **SC-14 Stop while waiting**
    - **Given** plan v2 waiting
    - **When** the user stops the turn
    - **Then** v2 becomes not answered and the chat stays in Plan.
15. **SC-15 Manual mode switch while waiting**
    - **Given** plan v2 waiting
    - **When** the user picks Accept edits from the Mode list, or with Shift+Tab
    - **Then** v2 becomes not answered, Claude is told the plan wasn't approved, and the chat changes to Accept edits.
16. **SC-16 Resume**
    - **Given** a chat in Plan with v2 waiting, and Quirky restarts
    - **When** the user reopens the chat
    - **Then** the chat is in Plan and v2 shows as not answered, with the notice "Quirky restarted before you answered" and one button, Ask Claude to present it again. The button sends that request and stays in Plan.
    - **Data before:** **Chat**: mode Plan; **Plan v2** waiting
    - **Data after:** **Chat**: ✓ mode Plan; **Plan v2** ✓ not answered; approve exits ✗ hidden
17. **SC-17 Resume keeps any mode**
    - **Given** a chat in Accept edits, and Quirky restarts
    - **When** the user reopens it
    - **Then** it's still in Accept edits.

### Plan text and failures

18. **SC-18 The panel shows the newest plan**
    - **Given** Claude writes its plan file and asks to leave plan mode in the same message
    - **When** the plan arrives
    - **Then** the panel shows the plan file's current text, not an empty or earlier one.
19. **SC-19 Empty plan**
    - **Given** the plan file can't be read and Claude sent no plan text
    - **When** the plan arrives
    - **Then** the version shows "Claude sent an empty plan" with only Keep planning available. An empty plan can't be approved.
20. **SC-20 Auto refused after approval**
    - **Given** the user clicked Approve, auto mode
    - **When** Claude refuses Auto
    - **Then** the approval stands, the chat lands in Accept edits, a status row says Auto wasn't available, and the badge shows Accept edits.

### Panel and layout

21. **SC-21 Opening and closing the panel**
    - **Given** a chat with at least one plan version
    - **When** the user closes the panel
    - **Then** the header chip reopens it. A new version always reopens it. After approval it stays open, without buttons, while Claude implements.
22. **SC-22 Narrow window**
    - **Given** the chat is too narrow for a side panel
    - **When** a plan arrives or the user clicks the chip
    - **Then** the plan opens as a drawer over the chat from the right. Esc, the close button or the chip closes it.
23. **SC-23 Open plan file**
    - **Given** a plan version in the panel
    - **When** the user clicks Open plan file
    - **Then** Claude's plan file opens in the user's editor. Edits to the file are not sent to Claude.
24. **SC-24 Other agents**
    - **Given** a Codex, pi or omp chat
    - **When** the user opens the Mode list or presses Shift+Tab
    - **Then** Plan is disabled with that agent's current reason, and no plan panel appears.

## Screens

The signed-off mock is [mock/mock.html](mock/mock.html), with its inventory in [mock/screens.md](mock/screens.md) and review history in [mock/review.json](mock/review.json). It was approved at v1 with no pins. It's the target for layout and flow. Its neutral palette isn't the product's, so the build uses Quirky's tokens.

| Screen | State | Acceptance |
|---|---|---|
| Chat with plan panel | waiting | matches mock: panel with version marker, rendered plan, Open plan file, three exits; transcript row "Plan ready (v2)"; Plan badge; header chip |
| Chat with plan panel | planning | matches mock: no panel yet; Plan badge; "Claude is planning" in the transcript |
| Chat with plan panel | keep planning | matches mock: feedback box replaces the exits; Send to Claude and Cancel |
| Chat with plan panel | revised | matches mock: v3 marked revised; v1 and v2 as Revised rows |
| Chat with plan panel | approved | matches mock: no exits; marker "approved · auto mode"; Auto badge; row "Plan approved (v3)" |
| Chat with plan panel | not answered | matches mock: restart notice; only Ask Claude to present it again |
| Mode picker | default | matches mock: one Mode list with Ask, Accept edits, Auto, Plan; Shift+Tab hint |
| Mode picker | auto unavailable | matches mock: Auto disabled with reason; hint that approval uses Accept edits |
| Narrow window | drawer open | matches mock: drawer over the chat with scrim and exits |
| Narrow window | drawer closed | matches mock: chip in the header opens the drawer |

Open questions from the mock's gaps (elements with no existing component):

- The plan panel, its version marker, the three exit buttons and the feedback box have no existing component. Should the panel be a general chat side panel or plan-only? The design only needs plan-only.
- The header Plan chip and the transcript plan row are new. Do they reuse the existing chip and status-row styles?
- The Open plan file link: open in the user's editor, or in Quirky's own file viewer?

## Decisions Locked

**Scope**
- Gray areas: plan approval, mode after approval, plan display and persistence, entering plan mode. Standard set only, no adhd run.
- Claude only. Codex, pi and omp keep Plan disabled. The panel is built so another agent can feed it later.
- The plan is read-only in the panel. Changes go through the conversation.
- No "approve and clear context" exit.
- UX review: mock v1 signed off with no pins.

**Approval**
- Three exits, like the Claude Code terminal: Approve, auto mode; Approve, review edits; Keep planning.
- The full plan renders as markdown in the panel.
- Keep planning reveals a text box, and composer messages while waiting also count as Keep planning.
- Approval is click-only. The composer keeps focus and text.

**Mode after approval**
- The auto exit goes to Claude's Auto mode, or Accept edits when Auto isn't available.
- The composer shows the mode Claude reports.
- When Claude enters Plan itself, Quirky follows it.
- Stopping or messaging while a plan waits never approves it. The chat stays in Plan.

**Plan display**
- The plan lives in its own panel right of the chat, and the conversation continues beside it.
- The exits sit in the panel under the plan.
- The transcript shows a one-line row per version.
- The panel opens when a plan arrives, can be closed, and stays open after approval.
- A Plan chip in the chat header reopens it.
- An Open plan file link shows Claude's plan file.
- Earlier versions collapse to Revised rows. Only the newest is live.
- In a narrow window the panel is an overlay drawer.

**Entering plan mode**
- One Mode list: Ask, Accept edits, Auto when available, Plan. The separate switch is removed. `/plan` toggles.
- Shift+Tab cycles modes and never approves.
- A Plan pick before the first message is honored.
- Resume restores the mode and shows a waiting plan as not answered.

**Approach**
- The plan is a versioned entry in the chat's history, shown by a chat-owned panel. A plan ask variant and an agent-drawn view were considered and not chosen.

**Done means**
- A chat in Plan never changes a file before an approve click, including the first turn and after a stop.
- Approving switches the mode and starts implementing in the same turn.
- The panel always shows the newest plan, never an empty or stale one.

## Industry Insights

- Approving Claude's request to leave plan mode can switch the permission mode in the same answer, so approval and the switch happen in one step. ([Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript))
- The plan text sent with the request can be empty or the previous plan when Claude writes the plan file in the same message. Reading the plan file at approval time avoids it. ([anthropics/claude-code#96553](https://github.com/anthropics/claude-code/issues/96553), [#97740](https://github.com/anthropics/claude-code/issues/97740))
- The most damaging failures reported elsewhere are plan mode silently dropped on resume or reload, after which Claude implements without approval. ([#85095](https://github.com/anthropics/claude-code/issues/85095), [#109225](https://github.com/anthropics/claude-code/issues/109225))
- An approval frame that captured composer keystrokes counted typing as approval in VS Code. ([#107293](https://github.com/anthropics/claude-code/issues/107293))
- Approve-and-clear-context drops instructions that weren't in the plan, and users rarely want it. ([#18599](https://github.com/anthropics/claude-code/issues/18599))
- Users complain that plans are hidden in `~/.claude/plans/` and hard to review in a terminal, and they build their own review windows. ([Armin Ronacher](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/), [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1xe8l86/))
- The terminal's exits are "Yes, and use auto mode", "Yes, manually approve edits" and "No, keep planning". Labels have drifted across versions, so Quirky uses its own labels. ([Permission modes](https://code.claude.com/docs/en/permission-modes), [#94716](https://github.com/anthropics/claude-code/issues/94716))
- The three approaches weren't separately web-researched, because they're choices about Quirky's internals. The SDK research above applies to all three.

## Deferred Ideas

- Plan mode for Codex through its experimental collaboration mode.
- Editing the plan in the panel before approving.
- Highlighting what changed line by line between versions.
- Inline comments on plan lines.
- Writing plans into the worktree so they can be committed.
- An "approve and clear context" exit.
- `[tech-spec]` How Quirky learns whether Auto is available for the current model and account.
- `[tech-spec]` How a manual mode switch answers the paused request so Claude hears the plan wasn't approved.

## Status & amendments

**Status:** Draft

**Amendments:** none
