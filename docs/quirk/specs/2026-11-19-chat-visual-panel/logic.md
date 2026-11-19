# Visual panel in native chat

## Status & amendments

**Status:** Approved.

**Amendments:** none yet.

## Conceptual model

The person this is for thinks in pictures. Native chat should hand them visual context liberally, not only when they ask for it. Today agents almost never draw, for three reasons. Nothing tells them the Views pane exists. The catalog can't draw diagrams, images or mockups. The pane is a fixed 320px column next to the Plan pane.

Native chat gains a **visual panel**: a docked column beside the transcript where the agent keeps the pictures that explain its work. Every agent (Claude, Codex, pi, omp) draws into it with `quirky view`, the command the Views pane already uses, grown into a full visual toolkit.

- A **visual** is one titled thing in the panel: a diagram, table, mockup, prototype, screenshot, and so on. Quirky gives it an id when it's first drawn.
- Every change to a visual is kept as a numbered **version**. Nothing is overwritten.
- **Pointing** means clicking part of a visual to attach a reference to your next message.
- The **visual level** (Off, Balanced, Visual-first) tells the agent how liberally to draw. It's set with a dial in the composer.

The agent's written reply gets shorter when it draws. The reply carries the reasoning and takeaways and points at the visual instead of restating it.

## Data flow

You send a message. It may carry reference chips naming a visual, the version you were looking at, and the element you clicked. The agent replies in prose and, as it works, opens, updates or patches visuals through `quirky view`. Quirky checks every new version before storing it.

- A version that passes is stored, shown in the panel, and leaves a chip on the message that made it.
- A version that fails is refused. The agent gets the error on that same call, while the panel keeps showing the last good version.

Visual guidance matched to the visual level is part of every agent session from its start. Changing the dial updates the guidance from your next message in that chat. Visuals, versions, placements and the dial setting are saved with the chat and survive restarts.

## Key decisions

- **Grow `quirky view` rather than add a second mechanism.** All four agents already share the CLI. Quirky-assigned ids keep versions reliable: in one study, model-chosen ids drifted on 53 of 81 updates. A refused spec can answer the agent on the same call. Fence-lifting was rejected because the agent can't hear about a failure and Claude retired that pattern. MCP Apps was rejected because the Claude Agent SDK reportedly drops the UI metadata.
- **Docked, never popping.** Auto-opening panels are the most-reported complaint about other products. The panel is always there, so a new visual simply appears.
- **Visual-first by default, with a dial.** The user wants liberal visuals. The dial and the "update, don't duplicate" rule are the guards against filler.
- **Versions, never overwrites.** Silent overwrites and lost history are the second most-reported complaint.
- **Builds up in complete steps.** Streaming half-parsed diagrams is a known flicker and broken-render trap. Every frame shown is a whole, valid render.
- **Agent script runs sandboxed with no network.** This widens native chat's earlier "no agent code" rule only for mockups and prototypes, and only inside a frame that can't reach the network, Quirky, files or other visuals.
- **Everything ships together.** The user chose one build over waves.

## Behaviour & scenarios

### Drawing liberally

1. **SC-1 A structured answer gets a visual without asking**
   - **Given** a Claude chat at the Visual-first level
   - **When** you ask how the session token gets from the app to the agent
   - **Then** the agent draws an "Auth flow" diagram in the panel. Its reply is a few lines that point at the diagram, and the message carries an "Auth flow v1" chip. You didn't ask for a visual.
   - **Data before:** **Panel**: empty
   - **Walkthrough:**
     1. You send "How does the session token get from the app to the agent?"
     2. Claude runs `quirky view open` with a diagram titled "Auth flow"; Quirky stores it as version 1
     3. Claude replies "It rides the lease env. The daemon is the only hop that checks it. See Auth flow."
   - **Data after:** **Panel**: ✓ "Auth flow" v1, focused; **Message**: ✓ chip "Auth flow v1"

2. **SC-2 Chit-chat stays text**
   - **Given** a chat at the Visual-first level
   - **When** you send "thanks, that's it for now"
   - **Then** the agent replies in text only and the panel doesn't change

3. **SC-3 The same subject updates the existing visual**
   - **Given** a panel holding "Auth flow" v1
   - **When** you ask the agent to add the refresh path
   - **Then** the agent updates "Auth flow" to v2. ✗ It doesn't draw a second auth diagram.
   - **Data before:** **Auth flow**: v1 (Client app, Daemon, Agent runner)
   - **Walkthrough:**
     1. You send "Add the refresh path"
     2. Claude patches "Auth flow", adding a Token refresh box under Daemon
   - **Data after:** **Auth flow**: ✓ v2 adds Token refresh, shown in green with "changed in v2"; v1 still reachable; **Panel**: still one auth diagram

4. **SC-4 The dial changes how liberally the agent draws**
   - **Given** a chat at the Visual-first level
   - **When** you set the dial to (a) Balanced or (b) Off and send your next message
   - **Then** (a) the agent draws only when a picture clearly beats prose; (b) the agent draws nothing unless you ask. In both cases visuals already in the panel stay. The setting applies to this chat only, and new chats start at your global default.
   - **Screen states:**

     | Dial | Your next message | Agent draws |
     |---|---|---|
     | Visual-first | "compare the three approaches" | ✓ a matrix |
     | Balanced | "compare the three approaches" | ✓ a matrix, since it clearly beats prose |
     | Balanced | "what does this function return?" | ✗ nothing |
     | Off | "compare the three approaches" | ✗ nothing |
     | Off | "draw the three approaches" | ✓ a matrix, because you asked |

5. **SC-5 Visualize turns a message into a visual**
   - **Given** an agent message with no visual
   - **When** you hover over the message and click its ◈ Visualize icon
   - **Then** Quirky sends the agent a request to visualize that message. The agent draws the visual in the panel. If the agent is mid-turn, the request queues like a typed message.
   - **Screen states:**

     | Moment | ◈ icon |
     |---|---|
     | not hovering, not focused | ✗ hidden |
     | hovering or keyboard focus | ✓ shown, tooltip "Visualize" |
     | after a click, until the visual arrives | ✓ shown as busy |

6. **SC-6 Every agent can draw**
   - **Given** a native chat with (a) Claude, (b) Codex, (c) pi or (d) omp
   - **When** the session starts
   - **Then** the agent has the visual guidance for the chat's level and can draw every kind with `quirky view`. Each visual is tagged "by <agent>".

### Arriving, changing and breaking

7. **SC-7 A visual builds up in complete steps**
   - **Given** the agent is drawing a three-step "Migration plan"
   - **When** it adds the steps one update at a time
   - **Then** the visual appears with its first complete version and gains one step per update. Each frame is a whole, valid diagram. The card shows "drawing Migration plan" until the agent's turn ends.

8. **SC-8 Stepping through versions**
   - **Given** "Auth flow" has versions 1 and 2
   - **When** you click ‹ on its stepper, or click the "Auth flow v1" chip on the first message
   - **Then** the panel shows v1 with the stepper at "v1 of 2" and no change highlight. The latest version is still v2, and ›, or the newest chip, returns to it.

9. **SC-9 A refused version answers the agent and keeps the picture**
   - **Given** "Auth flow" is at v2
   - **When** the agent sends a v3 with a syntax error
   - **Then** the agent gets the error on the same call and a refused row shows in the transcript. The panel keeps showing v2 with a "v3 didn't render" badge. When the agent's next attempt works, it becomes v3 and the badge clears.
   - **Data before:** **Auth flow**: v2 shown
   - **Walkthrough:**
     1. Claude runs `quirky view update` for "Auth flow" with a sequence arrow inside a flowchart
     2. Quirky refuses it; ✗ the command fails with "line 4: unexpected '-->>'"
     3. Claude fixes the arrow and updates again
   - **Data after:** **Auth flow**: ✓ v3 shown; ✓ badge gone; the refused attempt is listed in the transcript but not in the stepper
   - **Screen states:**

     | Moment | Panel | Transcript |
     |---|---|---|
     | after step 2 | ✓ v2 with "v3 didn't render" badge; clicking shows error and source | ✓ refused row naming the error |
     | after step 3 | ✓ v3, highlight on what changed | ✓ refused row stays |

10. **SC-10 A failure only visible on screen still reaches the agent**
    - **Given** a version that passed Quirky's checks
    - **When** it fails to draw in the window
    - **Then** the panel keeps the last good version with the didn't-render badge, and the agent gets the same error as a message right after

### Talking back

11. **SC-11 Pointing at part of a visual**
    - **Given** "Auth flow" v2 in the panel
    - **When** you click its Daemon box and type "why does every call go through this hop?"
    - **Then** the composer shows the chip "◈ Auth flow › Daemon" before your text. The agent receives the visual, the version you were looking at and the element. You can add more chips, or remove one with ✕.
    - **Data before:** **Composer**: empty
    - **Walkthrough:**
      1. You click Daemon in "Auth flow"; the box is outlined
      2. You type your question and send
    - **Data after:** **Message**: ✓ reference to "Auth flow" v2 › Daemon, plus your text

12. **SC-12 A prototype is clickable and contained**
    - **Given** the agent drew a "Settings › Visuals" prototype
    - **When** you switch its tabs and flip its toggles
    - **Then** the prototype responds. It's tagged "sandboxed · no network", and nothing in it can reach the network, Quirky, your files or other visuals. Clicking a region the agent labelled points at it like any other element.

13. **SC-13 A live preview shows the dev server**
    - **Given** the worktree's dev server runs on localhost
    - **When** the agent shows a live preview of a page
    - **Then** the panel shows that page through the browser pane, with reload and pop out

### The panel

14. **SC-14 The panel adapts to its width**
    - **Given** a chat with the plan and three visuals
    - **When** the panel is (a) wide enough for two visuals side by side or (b) narrower
    - **Then** (a) the visuals show at once in a grid; (b) one visual is big and the rest sit in a filmstrip above it. In both, the plan comes first, and the newest visual takes focus when it's drawn.

15. **SC-15 Resizing and collapsing**
    - **Given** a chat with visuals
    - **When** you drag the divider, or click ⟩ to collapse the panel
    - **Then** a drag sets the width, and the width is remembered across chats and restarts. Collapsing leaves a rail. Anything drawn while the panel is collapsed adds to a "N new" badge on the rail, and clicking the rail reopens the panel. When the window is too narrow, the panel starts collapsed.

16. **SC-16 Expand and pop out stay live**
    - **Given** "Auth flow" in the panel
    - **When** you click ⤢, or ⧉
    - **Then** ⤢ fills the chat window with the visual, the composer stays underneath, and Esc returns to the chat. ⧉ opens the visual in its own window. Both show new versions as the agent makes them.

17. **SC-17 Inline placement still works**
    - **Given** the agent opens a small decision view with buttons, placed inline
    - **When** you move it to the panel, or move a panel visual inline
    - **Then** it moves and stays there through later updates, as today. Visuals with no placement go to the panel.

18. **SC-18 Visuals survive a restart**
    - **Given** a chat with visuals at several versions and the dial at Balanced
    - **When** Quirky restarts and you reopen the chat
    - **Then** every visual, version, placement, chip and the dial setting are as you left them

## Screens

The signed-off mock (v2) is [mock/mock.html](mock/mock.html), and its inventory is [mock/screens.md](mock/screens.md). It's the visual target. The build recreates it in Quirky's components and never lifts code from it.

Each item below must match the mock:

- **Chat, default:** the plan and three visuals in a grid; the green change highlight on "Auth flow" v2; chips on the messages; ◈ Visualize on hover only.
- **Chat, empty:** the empty panel explains what will appear and shows the visual level.
- **Chat, building:** the growing visual shows "drawing <title>" and a pending step.
- **Chat, broken:** the last good version with the "didn't render" badge, and the refused row in the transcript.
- **Chat, pointing:** the clicked element is outlined, with its reference chip in the composer.
- **Narrow window, default:** a filmstrip with the plan pinned first, and one focused visual.
- **Narrow window, collapsed:** the rail with its "new" badge.
- **Expanded visual, default:** the visual fills the window, with Back (Esc), the stepper, Pop out and the composer.
- **Prototype, default:** a clickable prototype with the sandbox tag, beside a live preview.
- **More kinds, default:** timeline, board, matrix, annotated code, file map, plot, sketch and screenshot, each as it sits in the panel.

Open questions from mock gaps, meaning mocked elements with no Quirky component today. All need new components, and the tech spec decides how each is built:

- message visual chips
- the Visualize icon
- reference chips
- the dial
- the divider
- collapse and the rail
- the filmstrip
- the version stepper and change highlight
- expand and pop out
- the empty and building panel states
- the sandbox frame and tag
- the timeline, board, matrix, file map, plot and sketch kinds

## Scope & non-goals

**In scope:** everything above, shipped together, for all four agents in native chat.

**Non-goals:**
- The mobile app.
- Editing visuals by hand. You point and ask, and the agent edits.
- Exporting or sharing visuals outside Quirky.
- Agents running in plain terminal panes.

**Success looks like:**
- You rarely type "draw this", because most substantive answers already come with a useful visual.
- You can follow what the agent is doing from the panel, and you read the transcript only for detail.
- You never see a broken visual. A failed render never replaces a good one, and the agent fixes it without you.
- Visuals aren't filler. Looking back, almost every one helped, and you don't reach for the dial to turn it down.

## Decisions Locked

**Interaction style**
- The panel is docked by default. New visuals appear in place, and nothing pops open.
- You react to a visual by clicking it, which drops a reference chip in the composer.
- A chip on each message that drew or changed a visual opens that version.
- A Visualize action sits on any agent message. After mock review it's a small icon shown on hover or focus.

**Layout style**
- The panel adapts: several visuals side by side when there's room, and one big visual plus a filmstrip when narrow.
- It's resizable, starts at about 45%, and remembers its width.
- The plan lives in the panel, pinned first.
- A visual can expand to fill the window, or pop out to its own live window.

**Information density**
- Visual-first is the default: any structured answer gets a visual.
- A dial in the composer (Off, Balanced, Visual-first) sets the level per chat. The global default is Visual-first.
- Kinds: diagrams, UI mockups, data, images, live previews and interactive prototypes, annotated code and file maps, timelines, boards and matrices, and math, plots and sketches.
- The written reply is shorter and points at the visual.

**Loading pattern**
- A visual builds up in complete steps, and every frame is a valid render.
- An update keeps the same visual, highlights what changed, and keeps every version behind a stepper.
- On a failed render the panel keeps the last good version with a badge, and the agent gets an error response so it can fix it.

**Scope**
- Everything ships at once.
- Agent-written script is allowed only sandboxed, with no network and no access to Quirky or files, and talks back through point and click actions.
- Not doing: mobile, editing visuals by hand, export and sharing, terminal agent sessions.
- Success: you rarely ask, you can follow from the panel, you never see a broken visual, and the visuals aren't filler.
- All four agents (Claude, Codex, pi, omp) get this. This was assumed from the codebase, since they already share `quirky view`.

**Approach**
- Grow `quirky view` into the visual tool: new kinds, Quirky-assigned ids, errors back to the agent, patch, and visual guidance in every session.

**UX review**
- Signed off at mock v2. The one change from v1 made Visualize icon-only and visible on hover.

## Industry Insights

- **Auto-opening panels annoy people.** ChatGPT Canvas kept opening unasked, and users wanted it on request only ([OpenAI community](https://community.openai.com/t/canvas-opens-automatically-how-to-prevent-that/1055091)). This led to the docked panel.
- **Silent overwrites and lost version history** are the top trust complaints about Claude artifacts ([claude-code #79901](https://github.com/anthropics/claude-code/issues/79901), [#96718](https://github.com/anthropics/claude-code/issues/96718)). This led to immutable, enumerable versions.
- **Tools go unused unless named.** A model given a render tool but no instruction about it answers in prose ([CopilotKit](https://docs.copilotkit.ai/openai-agents-python/generative-ui/tool-based)). This led to visual guidance in every session.
- **Model-chosen artifact ids drift.** In one sample, 53 of 81 updates started a new artifact instead of reusing one, and about 1 in 12 directives lacked a closing fence ([LibreChat PR #17024](https://github.com/LibreChat-AI/LibreChat/pull/17024)). This led to Quirky-assigned ids, and is why fence-lifting was rejected.
- **Claude retired inline artifact tags** for new artifacts in September 2026 ([Claude help](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)).
- **Validate each spec, retry with the error, fail visibly**, and use one catalog copy for agent and renderer ([A2UI](https://a2ui.org/concepts/overview/), [A2UI in Angular](https://dev.to/ggalassi/a2ui-in-angular-your-zod-catalog-is-the-trust-boundary-3n89)).
- **MCP Apps is the cross-vendor standard**, with `ui://` resources in sandboxed frames ([spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)). But Claude Code drops the widgets ([#95149](https://github.com/anthropics/claude-code/issues/95149)), and the Agent SDK reportedly loses the UI metadata ([report](https://github.com/raffaelefarinaro/ciaobot/issues/1984)). This is why it was rejected for now.
- **Streaming re-renders flicker.** Reassigning a frame's content per chunk re-parses the page, and partial Mermaid fences throw ([Lobe UI](https://ui.lobehub.com/components/html-preview), [Orca #26156](https://github.com/stablyai/orca/issues/26156)). This led to building up in complete steps.
- **Rewriting a whole artifact for a small change** costs several times the output tokens of a targeted edit ([agentpatterns](https://agentpatterns.ai/tool-engineering/llm-edit-format-selection/)). This led to patch.
- **Sandboxing alone doesn't stop image or link exfiltration** ([nhimg](https://nhimg.org/iframe-sandbox-and-srcdoc-security-guide)). This is why prototypes have no network and require inline images.

## Deferred Ideas

None from the user. The discussion stayed within scope. These build-only questions go to the tech spec:

- [tech-spec] How the visual guidance reaches each runner: an appended system prompt for the Claude SDK, developer instructions for Codex, and the pi/omp equivalents. Also how a dial change reaches a live session.
- [tech-spec] Version storage. The views table keeps one spec and an update counter today, so it needs per-version history.
- [tech-spec] The patch format, and how it is checked.
- [tech-spec] Whether Mermaid and the other new kinds can be fully checked in the daemon, so failures answer on the same call (SC-9), and which cases fall to the on-screen path (SC-10).
- [tech-spec] How the sandbox is isolated in the Electrobun webview (a separate origin, CSP), and how a prototype's labelled regions report a point.
- [tech-spec] How each kind exposes pointable elements with stable labels across versions.
- [tech-spec] Pop-out window mechanics and keeping it live.
- [tech-spec] Size limits for HTML, images and the new kinds, beside the current 256 KiB and 500-node limits.
- [tech-spec] How the plan moves from PlanPanel into the panel without changing plan mode's behavior.

## Glossary

- **Visual panel:** the docked column on the right of native chat that holds visuals.
- **Visual:** one titled thing in the panel, with a Quirky-assigned id.
- **Version:** one stored state of a visual. Versions are numbered from 1 and never overwritten.
- **Refused version:** a new version Quirky rejected. It's never shown or numbered, and the agent gets its error.
- **Pointing:** clicking an element of a visual to add a reference chip to your message.
- **Reference chip:** the composer chip naming a visual and an element, for example "◈ Auth flow › Daemon".
- **Visual chip:** the chip on a message that opens the visual version it made.
- **Visual level:** Off, Balanced or Visual-first. It's set by the dial.
- **Filmstrip:** the row of thumbnails above the focused visual when the panel is narrow.
- **Rail:** the thin strip left when the panel is collapsed.
- **Sandboxed:** running in a frame with no network and no access to Quirky, files or other visuals.
- **Live preview:** the worktree's running dev server shown in the panel through the browser pane.
