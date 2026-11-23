# Visual deck: one visual at a time

## Status & amendments

**Status:** Draft, awaiting review.

**Amendments:** none yet.

This spec replaces SC-14 ("The panel adapts to its width") of [the chat visual panel spec](../2026-11-19-chat-visual-panel/logic.md). The rest of that spec still holds.

## Purpose

When a chat's visual panel is wide, it puts every open visual in a two-column grid, each at full height. In a chat with four long visuals (a brainstorm, a UX mock, a logic spec and an SDD board), the panel was about 12,800 pixels tall. Each column was about 330 pixels wide, so the SDD board's kanban broke its words one letter per line and the card buttons wrapped. Nothing stood out, and the visual you needed was somewhere down a long scroll.

The reader of this spec is the person approving what gets built. The tech spec, written at execution, owns where the code lives and its contracts.

## Conceptual model

A **visual deck** shows one visual at a time, using the full width and height of the space it sits in, with a row of tabs to switch between visuals. The chat's visual panel and the standalone Views pane both use the same deck, so they behave the same and can't drift apart.

- An **entry** is one tab in the deck. In the chat panel, the plan comes first as a pinned entry with no close button. After it come the session's pane visuals that are still open.
- Each entry has a **label**. That's the visual's short label when the agent gave one, and otherwise its title cut to about 24 characters. The full title shows on hover.
- Each visual is **live** or **done**. Done means its work is over: a signed-off mock, a finished brainstorm, a superseded spec. A done visual stays readable, with its tab dimmed and sorted after the live ones.
- The deck is either **following** or **steered**. Following, it moves to whatever visual the agent draws or updates. Steered, it stays where you put it, and changed entries get an **attention dot** instead.
- **Closed** visuals leave the tab row, and the overflow menu lists them so you can reopen them.

Inline cards in the transcript aren't part of the deck. They get the same slimmer header, and a height cap so a long card can't push the conversation off screen.

## How it fits together

The agent draws and updates visuals with `quirky view` as before. A visual's spec gains two optional fields: a short `label`, and a done flag the agent sets when the visual's work is over. You can also set or clear done, and close or reopen a visual, from the deck.

The deck reads the session's visuals, works out the order (plan, live by creation, done by creation) and shows as many tabs as fit, with the rest in a **+N** menu. Whether it's following or steered decides which visual is focused when one is drawn or updated. Your next message puts it back to following. The focused visual is drawn with the panel's full width, under one slim row of controls.

## Key decisions

- **One visual at a time at every width.** Every artifact panel we looked at (Claude, Notion side peek, VS Code) shows one item and lists the rest, and none of them grids. Narrow columns crushing boards and tables is a well-known pitfall. Extra panel width goes to the one visual, and there's never a side-by-side split.
- **One deck shared by the chat panel and the Views pane.** The Views pane already used tabs while the chat panel used a grid. Sharing one implementation stops that split from coming back. The plan goes in as a pinned first entry, which only the chat panel has.
- **Following stops when you steer.** Today the newest visual always takes focus. With only one visual on screen, that would pull you off the page you're reading. Your next message hands control back, because by then you've finished with what you were reading.
- **Done is a state the agent can set, not a timer.** Dimming visuals after a few idle turns would also dim a reference visual you still use. The agent knows when a mock is signed off or a spec is replaced, so it marks it, and you can override that from the menu.
- **Short labels come from the agent.** Long titles that share a tail ("…: subagents in native chat") make useless tabs. Stripping the shared part automatically would make labels change as visuals come and go.

## Behavior & scenarios

### The deck

1. **SC-1 One visual fills the panel**
   - **Given** a chat panel with the plan and four pane visuals, at any panel width above the collapse threshold
   - **When** the panel shows
   - **Then** one visual is shown using the panel's full width and height. A tab row above it lists the plan and the four visuals, and the panel shows no grid or second visual.
   - **Screen states:**

     | Element | Shown |
     |---|---|
     | Tab row | ✓ "Plan v3", "Brainstorm", "UX mock", "Logic spec", "SDD run" |
     | Focused visual | ✓ SDD run, full width |
     | "Visuals" heading | ✗ hidden while any tab exists |
     | Other visuals | ✗ not drawn |

2. **SC-2 Tab order**
   - **Given** the plan, live visuals created in the order Brainstorm, UX mock, Logic spec, SDD run, and UX mock marked done
   - **When** the tab row is drawn
   - **Then** the order is the plan, then live visuals oldest first, then done visuals oldest first. A visual only changes position when it becomes done or live.
   - **Data before:** **Brainstorm** live, created 1st; **UX mock** done, created 2nd; **Logic spec** live, created 3rd; **SDD run** live, created 4th
   - **Data after:** **Tab row**: ✓ Plan, Brainstorm, Logic spec, SDD run, UX mock (dimmed)

3. **SC-3 Tab labels**
   - **Given** a visual titled "SDD run: subagents in native chat"
   - **When** its tab is drawn (a) with the short label "SDD run" set, or (b) without a short label
   - **Then** (a) the tab reads "SDD run"; (b) the tab reads the title cut to about 24 characters with an ellipsis. In both cases the full title shows on hover.
   - **Data after:** (a) **Tab**: ✓ "SDD run"; (b) **Tab**: ✓ "SDD run: subagents in n…"*

4. **SC-4 The slim row**
   - **Given** a focused visual in the deck with 6 versions and interactive HTML
   - **When** the deck draws the area above it
   - **Then** one row shows the version stepper on the left and, on the right, a sandbox shield icon (with "Sandboxed, no network" on hover) and a ⋯ menu holding Expand, Pop out, Move inline, Mark done and Close. The row has no title and no author badge. With one version, the stepper is hidden. On a done visual, the menu shows Mark live instead of Mark done.

5. **SC-5 Wide content scrolls sideways**
   - **Given** a four-column board or a wide table in a panel too narrow to fit it at a readable width
   - **When** the visual is shown
   - **Then** columns and cells keep a minimum readable width and the visual scrolls sideways inside itself, with a fade on the edge that has more. Words aren't broken across lines to make the content fit.

### Focus

6. **SC-6 Following a new visual**
   - **Given** a following deck focused on Logic spec
   - **When** the agent draws a new visual, Token use
   - **Then** ✓ a Token use tab is added and focused.

7. **SC-7 Steering stops following**
   - **Given** a following deck, and you click the Logic spec tab
   - **When** the agent updates SDD run and then draws Token use
   - **Then** focus stays on Logic spec. SDD run and Token use each get an attention dot. Focusing a tab clears its dot.
   - **Data before:** **Deck**: following, focused SDD run
   - **Walkthrough:**
     1. You click Logic spec. **Deck**: steered, focused Logic spec
     2. The agent updates SDD run. **SDD run** tab: ✓ dot; focus ✗ unchanged
     3. The agent draws Token use. **Token use** tab: ✓ added with a dot; focus ✗ unchanged
   - **Data after:** **Deck**: steered, focused Logic spec; dots on SDD run and Token use

8. **SC-8 Your next message resumes following**
   - **Given** a steered deck
   - **When** you send a message
   - **Then** the deck is following again. Nothing moves until the agent next draws or updates a visual, and that visual then takes focus.

9. **SC-9 Asked-for focus always wins**
   - **Given** a steered deck
   - **When** you (a) click a visual's chip in a message, (b) move a visual into the pane, or (c) a new plan version arrives
   - **Then** that visual (or the plan) takes focus, whatever the mode. A chip click also shows the version the chip names, as it does today. The mode stays steered.

10. **SC-10 Using the stepper or the +N menu steers**
    - **Given** a following deck
    - **When** you step to an older version, or pick a visual from the +N menu
    - **Then** the deck becomes steered.

### Overflow, closing and done

11. **SC-11 Tabs overflow by width**
    - **Given** the plan and seven visuals in a panel that fits four tabs, focused on SDD run
    - **When** the tab row is drawn
    - **Then** four tabs are shown in order and the rest go into a +N menu. Done visuals sort last, so they move into the menu first. The focused tab is always visible: if it would overflow, it takes the last visible slot.
    - **Data before:** **Visuals**: Plan; Brainstorm (done); UX mock (done); Skill audit; Logic spec; SDD run (focused); Token use
    - **Data after:** **Tab row**: ✓ Plan, Logic spec, SDD run, Token use; **+3 menu**: Skill audit, Brainstorm (done), UX mock (done)

12. **SC-12 The +N menu lists closed visuals**
    - **Given** two closed visuals, Auth flake causes and Research findings
    - **When** you open the +N menu and pick Auth flake causes from its Closed section
    - **Then** ✓ Auth flake causes reopens as a tab in its creation-order place and takes focus. The deck becomes steered. When nothing overflows but closed visuals exist, the menu button still shows, without a count.
    - **Screen states:**

      | Menu part | Shown |
      |---|---|
      | Overflowing open visuals | ✓ listed in tab order; done ones marked "done" |
      | Closed section | ✓ divider "Closed", then closed visuals, newest closed first* |

13. **SC-13 Closing a tab**
    - **Given** a deck focused on Logic spec, which sits between Plan and SDD run
    - **When** you close Logic spec with the × on its tab (shown on hover, keyboard focus or selection) or from the ⋯ menu
    - **Then** ✓ Logic spec moves to the Closed section and focus moves to the tab on its left (Plan). Closing doesn't change whether the deck is following or steered. The plan has no ×.

14. **SC-14 Marking done**
    - **Given** a live UX mock
    - **When** (a) the agent marks it done, or (b) you pick Mark done from its ⋯ menu
    - **Then** its tab dims, shows "done" and moves after the live tabs. It stays fully readable when focused, and its version stepper still works.

15. **SC-15 An update makes a done visual live**
    - **Given** a done UX mock
    - **When** the agent updates or patches it
    - **Then** it's live again, back in its creation-order place, and the update follows the focus rules (SC-6, SC-7). You can also pick Mark live from its ⋯ menu.

### The chat panel's edges

16. **SC-16 Collapsed and empty stay as they are**
    - **Given** a chat narrower than 720 units, or a chat with no plan and no pane visuals
    - **When** the panel shows
    - **Then** it behaves as today: the collapsed rail with its "N new" badge, or the empty message with the visual level. Expanding the rail opens the deck.

17. **SC-17 The Views pane uses the same deck**
    - **Given** the standalone Views pane for a session with four pane visuals
    - **When** it shows
    - **Then** it has the same deck as the chat panel (labels, order, done, following and steered, +N with Closed, slim row, sideways scroll) without a plan entry.

### Inline cards

18. **SC-18 Long inline cards are capped**
    - **Given** an inline card in the transcript whose content is taller than 60% of the transcript's visible height
    - **When** it's shown
    - **Then** it stops at that height with a fade at the bottom and a Show more row. Show more opens it to full height in place and becomes Show less. A card shorter than the cap shows no fade and no button.

19. **SC-19 The inline header**
    - **Given** an inline card
    - **When** its header is drawn
    - **Then** it shows the title, the version stepper when there's more than one version, the sandbox shield icon when it has interactive HTML, and a ⋯ menu holding Expand, Pop out, Move to pane, Mark done and Close. It shows no author badge. Inline cards don't dim when done. Done only shows once the visual is in the pane.

### What the agent can set

20. **SC-20 Short label and done in a visual's spec**
    - **Given** an agent drawing a pane visual
    - **When** it runs `quirky view open` or `update` with a short label, or marks a visual done
    - **Then** the deck uses the label for the tab and the +N menu, and shows the visual as done. `quirky view --help` and the Quirky visual instructions describe both, ask for a label on every pane visual, and say to mark a visual done when its work is over (a signed-off mock, a finished brainstorm, a superseded spec). A label longer than about 24 characters is refused, with an error that says so. [ASK: Should an over-long label be refused, or accepted and cut on display? This spec assumes refused, matching how the spec checks other fields.]

21. **SC-21 Closed visuals stay reachable**
    - **Given** an agent closes a visual with `quirky view close`
    - **When** the deck next draws
    - **Then** ✓ the visual leaves the tab row and appears in the +N menu's Closed section.

## Screens

The signed-off mock is in [mock/mock.html](mock/mock.html), with the inventory in [mock/screens.md](mock/screens.md). The mock was signed off at v1 with no pins.

| Screen | State | Acceptance |
|---|---|---|
| Chat visual panel | default | Matches mock: tab row, slim row, SDD board full width |
| Chat visual panel | overflow | Matches mock: 4 tabs, +3 menu with the Closed section |
| Chat visual panel | steering | Matches mock: focus on Logic spec, dots on SDD run and Token use |
| Chat visual panel | done | Matches mock: Brainstorm and UX mock dimmed, last |
| Chat visual panel | empty | Matches mock: today's empty message |
| Chat visual panel | collapsed | Matches mock: today's rail with "2 new" |
| Inline card | capped | Matches mock: fade and Show more |
| Inline card | short | Matches mock: no fade, no button, no stepper |
| Inline card | expanded | Matches mock: full height with Show less |
| Views pane | default | Matches mock: same deck, no plan tab |

**Open questions from mock gaps** (elements with no existing component):

- Tab close ×: the shared Tabs component has no close button, so the deck needs one, or Tabs gains one.
- Attention dot on a tab: no existing component.
- Dimmed done tab: no existing component.
- Sideways scroll with edge fade: no existing component.
- Inline height cap fade: no existing component.

## Scope & non-goals

**In scope:** the chat's visual panel, the standalone Views pane, inline cards in the transcript, and the agent-facing short label and done fields.

**Not in scope:**

- the mobile app
- the collapsed rail's behavior and the 720-unit threshold
- the expanded view and pop-out windows
- the visual renderers, beyond a minimum width and sideways scroll for boards and tables

## Success

Replay the chat from the original screenshot: the plan plus Brainstorm, UX mock, Logic spec and SDD run.

- The panel fits one screen. The only scrolling is inside the focused visual.
- The SDD board's column text reads as whole words.
- Any visual is at most two clicks away (its tab, or +N and then pick).
- A visual drawn while you're reading a tab you picked doesn't move you.

## Decisions Locked

**Layout style**

- One visual at full width and height plus a switcher, at every width.
- The switcher is a row of title tabs, and tabs that don't fit go into a +N menu.
- Never side by side. Extra width goes to the one visual.
- The plan is the first tab, pinned left, and takes focus on a new plan version.

**Information density**

- Card chrome in the panel: one slim row with the version stepper on the left and a ⋯ menu on the right. No title.
- No author badge in the panel. The sandbox notice becomes an icon with hover text.
- Tab labels: an optional short label from the agent. Otherwise the title is truncated, with the full title on hover.
- Wide content keeps a minimum width and scrolls sideways with an edge fade.

**Interaction style**

- Follow new visuals until you click a tab. After that, new ones get a dot. Your next message resumes following.
- Updates follow the same rule as new visuals.
- Tab order: plan first, then order created, oldest left.
- Closing: × on tab hover, focus or selection, and Close in the ⋯ menu.

**Older visuals**

- A visual can be marked done, by the agent or from the ⋯ menu. Done tabs dim and sort to the end, and an update makes the visual live again.
- Tabs that don't fit the width go into +N. The focused tab is always visible.
- The +N menu lists closed visuals under a divider, and picking one reopens it.

**Scope and success**

- Surfaces: the chat visual panel, inline transcript cards and the standalone Views pane. Mobile is out.
- Success check: replay the screenshot's chat.
- Narrow chats keep the collapsed rail below 720 units.
- Inline cards are capped at about 60% of the transcript's height, with a fade and Show more.
- Inline header: title, version stepper and ⋯ menu. No author badge, and the sandbox notice is an icon.
- The Views pane follows the same rules as the chat panel.

**Approach and review**

- One shared visual deck. The Views pane wraps it, and the chat panel mounts it with the plan as a pinned first tab.
- UX review: signed off at mock v1, no pins.

## Industry Insights

- Artifact panels in Claude, Notion (side peek) and VS Code show one item at a time and list the rest, and none of them grids ([Claude artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them), [Notion](https://www.notion.com/help/views-filters-and-sorts)).
- An open Claude Code request (Oct 2026) asks for a quick switcher across a session's artifacts ([anthropics/claude-code#104709](https://github.com/anthropics/claude-code/issues/104709)).
- VS Code moves tabs that don't fit into a dropdown ([VS Code UI docs](https://code.visualstudio.com/docs/getstarted/userinterface)).
- Superseded artifacts usually stay readable but are marked old rather than removed ([Claude artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)).
- Narrow columns crushing kanban boards is a named pitfall. The fix is a minimum column width with scrolling, or one column with a switcher ([Pixso](https://pixso.net/tips/kanban-board-ui-design-pixso/)).
- Masonry layouts reshuffle when live content changes height, by as little as 1px ([Home Assistant](https://www.home-assistant.io/blog/2024/03/04/dashboard-chapter-1/)).
- A card should have one primary action and an overflow menu for the rest ([Stan.vision](https://www.stan.vision/journal/ui-card-design-examples-best-practices-and-common-patterns)).
- Show the most important item by default and keep the rest behind tabs. Designs with more than two levels of disclosure test poorly ([NN/g](https://www.nngroup.com/articles/progressive-disclosure/)).
- Live updates shouldn't wipe scroll position or focus. Patch in place rather than replacing the container ([MDN scroll anchoring](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll_anchoring/Overview)).
- I didn't research the three build approaches separately, because they differ only in internal structure.

## Deferred Ideas

No product ideas were deferred; the discussion stayed within scope. These build-level questions go to the tech spec:

- [tech-spec] Where the deck lives (quirky.view vs. the shared UI package), and how the chat panel passes the plan entry in.
- [tech-spec] Where the done flag and closed list live, so they survive a restart, and whether done belongs to the spec version or the visual record.
- [tech-spec] How the overflow measures tab widths without layout thrash when tabs change live.
- [tech-spec] Whether the Tabs component grows a close button and dot, or the deck draws its own tabs.
- [tech-spec] How the board, table and kanban renderers get a minimum width and sideways scroll.

## Glossary

- **Visual deck:** the one-at-a-time display with a tab row, shared by the chat panel and the Views pane.
- **Entry:** one tab in the deck, the plan or a pane visual.
- **Label:** a visual's short tab name, set by the agent.
- **Live / done:** whether a visual's work is ongoing or over. A done visual is dimmed and sorted last, but stays readable.
- **Following / steered:** whether the deck moves to visuals the agent draws or updates, or stays where you put it.
- **Attention dot:** marks a tab changed while the deck was steered.
- **+N menu:** the menu at the end of the tab row holding tabs that don't fit and the Closed section.
- **Slim row:** the single row of controls above a visual in the deck.
