# Native chat header

Every native chat in the desktop app gets a header row above its transcript. It shows the chat's status, how many tokens it has used and how long its prompt cache stays warm, and its ⋯ menu lets you rename the chat, fork it or open Session info.

This spec is for whoever builds and checks the header. It says what the person in the chat sees and does, not how it's built. It extends the [agent chat](../2026-11-16-agent-chat/logic.md) spec and replaces the thin row `ChatView` shows today (title, plan chip, Show all events checkbox).

## The model

The **header** is one row at the top of every native chat (Claude, Codex, pi, omp). It takes its own space above the transcript and never covers the start of a reply. Reading left to right:

- **Title.** The chat's readable label. Click it to rename.
- **Plan chip.** Only when the chat has a plan. Unchanged from today.
- **Status.** A dot plus a label, with elapsed time while the agent works.
- **Session tokens.** One total. Hover for the breakdown.
- **Cache timer.** How long the prompt cache stays warm after the agent's last API call.
- **⋯ menu.** Rename, Fork chat, Session info, Show all events.

Behind the header sits a **usage summary** for each chat, kept by the daemon. It holds token totals by category (input, output, cache read, cache write) and the chat's cache state: which lifetimes the last API call used (5-minute, 1-hour or both) and when that call started. The header, the Session info panel and the tab tooltip all read this one summary, so they always agree. Session info starts covering native chats as part of this work.

The **title** becomes yours. A rename shows everywhere the chat is listed, survives restarts and resume, and nothing overwrites it. **Fork** makes a new chat that continues from this conversation in its own tab, and the original is left untouched.

## How the numbers reach the header

1. **Agents report usage.** All four agents report input, output and cache tokens through their own channels. Quirky keeps the full breakdown instead of collapsing it into one context figure, as it does today. For Claude it also keeps which cache lifetimes each call wrote or read and when the call started.
2. **The daemon keeps the summary.** It folds each report into the chat's usage summary, saves it with the session so it survives a restart, and announces the change.
3. **Screens read it.** The header and Session info load the summary when they open and update on each change. The cache countdown is worked out on screen from the start time of the last call plus its lifetimes, and it ticks every second. It counts from the start of the call because Anthropic measures the lifetime from the start of the request.
4. **Rename.** The header sends the new title. The daemon saves it on the session, and the tab and every list showing the chat update.
5. **Fork.** The ⋯ menu asks the daemon to fork. The daemon uses the agent's own fork (Claude `forkSession`, Codex `thread/fork`, pi and omp `fork`), creates a new chat linked to the original, and opens it in a new tab.

**Totals across resume and fork.** A resumed chat shows one running total for the whole conversation you see, including the chats it was resumed from, and never counts the same spend twice. A fork starts its own total at zero, because the spend before the fork belongs to the original.

## Key decisions

- **The daemon keeps the usage summary.** The header and Session info have to agree. Long chats load in pages of 1,000 messages, so a total added up on screen would be wrong until every page loaded.
- **A fixed row, never an overlay.** Cursor and Claude Code both have reports of sticky bars covering the first lines of a reply.
- **One fixed-width ⋯ instead of icon buttons.** Other chat headers shift when an icon appears and clip trailing buttons in narrow panes.
- **Cache time counts from the start of the last API call.** That's how Anthropic measures it. Community timers that count from the end of the reply overstate the time left.
- **Missing data is hidden, not shown as a dash,** so the bar only says what's true.
- **A renamed title is never overwritten.** Auto-titles clobbering a rename are the most-reported title bug in other agents.
- **Fork works on all four agents,** through each agent's own fork.

## Scenarios

### Status

1. **SC-1 Working shows elapsed time**
   - **Given** a chat whose agent is mid-turn
   - **When** the user looks at the header
   - **Then** the status shows a pulsing dot and "Working" with the elapsed time of the turn, ticking every second. The cache timer is hidden while the agent works.
   - **Data before:** **Chat** "Fix flaky worktree window test"*: turn started 72 seconds* ago; 184k* tokens
   - **Data after:** **Header**: ✓ "Working · 1m 12s"; ✓ "184k tokens"; ✗ no cache timer
2. **SC-2 Status labels**
   - **Given** a chat in any state
   - **When** its state changes
   - **Then** the status shows the matching dot and label from the table below, and a screen reader announces the new label without moving focus. The ticking elapsed time is never announced.
   - **Status labels:**

     | Chat state | Dot | Label |
     |---|---|---|
     | Agent working | accent, pulsing | Working · elapsed time |
     | Waiting on an approval or question | amber | Waiting on you |
     | Turn finished | green | Done |
     | New chat, no turn yet | green | Ready |
     | Agent exited cleanly | grey | Ended |
     | Agent process died | red | Stopped unexpectedly |
     | Daemon connection lost | amber | Reconnecting… |

### Tokens

3. **SC-3 One total that matches Session info**
   - **Given** a chat that has finished at least one turn
   - **When** the user looks at the header and at Session info for the same chat
   - **Then** both show the same token total, and so does the chat tab's tooltip. Hovering the header's total shows input, output, cache read, cache write and the total.
   - **Data before:** **Usage summary**: input 12.4k*; output 9.8k*; cache read 141.2k*; cache write 20.6k*
   - **Walkthrough:**
     1. The total is 12.4k + 9.8k + 141.2k + 20.6k = 184k
     2. The user hovers "184k tokens" in the header
   - **Data after:** **Header**: ✓ "184k tokens"; ✓ hover lists the four categories and 184k; **Session info**: ✓ total 184k
4. **SC-4 No tokens before the first turn ends**
   - **Given** a new chat whose first turn hasn't finished
   - **When** the user looks at the header
   - **Then** no token total shows, and no cache timer shows. The status reads Ready.
5. **SC-5 Totals across resume**
   - **Given** a chat resumed from an earlier chat
   - **When** the resumed chat finishes a turn
   - **Then** the total covers the whole conversation shown, including the earlier chat, and no spend is counted twice.
   - **Data before:** **Earlier chat**: 120k* tokens; **Resumed chat**: no turns yet
   - **Walkthrough:**
     1. The resumed chat's first turn uses 15k* new tokens
     2. Claude's result for that turn also repeats the earlier 120k
   - **Data after:** **Header**: ✓ "135k tokens" (120k + 15k); ✗ never 255k
6. **SC-6 A fork starts at zero**
   - **Given** a chat forked from another
   - **When** the fork finishes its first turn
   - **Then** its total counts only the fork's own spend, and the original's total is unchanged.

### Cache timer

7. **SC-7 Both lifetimes in one timer**
   - **Given** a Claude chat whose last API call wrote both a 5-minute and a 1-hour cache, and whose turn has ended
   - **When** time passes with no new message
   - **Then** the timer counts down in m:ss to the 5-minute mark and turns amber in its last minute. At 5 minutes it goes back to its normal color and counts down in whole minutes to the 1-hour mark. After 1 hour it reads "Cache cold". Hovering shows the time left on each lifetime that is still warm.
   - **Walkthrough:**
     1. 48 seconds after the call started: ✓ "Cache 4:12", normal color
     2. At 4 minutes 12 seconds: ✓ "Cache 0:48", amber
     3. At 5 minutes 1 second: ✓ "Cache 55m", normal color
     4. At 1 hour: ✓ "Cache cold"
8. **SC-8 Only a 5-minute cache**
   - **Given** a chat whose last call used only a 5-minute cache, as with API-key billing
   - **When** 5 minutes pass after that call started
   - **Then** the timer is amber in its last minute and reads "Cache cold" at 5:00.
9. **SC-9 Only a 1-hour cache**
   - **Given** a chat whose last call used only a 1-hour cache
   - **When** its turn ends
   - **Then** the timer counts down in whole minutes to the 1-hour mark, then reads "Cache cold". It doesn't turn amber.
10. **SC-10 Counts from the start of the call**
    - **Given** an agent call that streamed for 4 minutes on a 5-minute cache
    - **When** the turn ends
    - **Then** the timer shows about 1 minute left, not 5.
11. **SC-11 A cache hit restarts the clock**
    - **Given** a chat with a warm cache
    - **When** the user sends a message and the agent's next call reads the cache
    - **Then** the timer hides while the agent works and starts again from that call's start when the turn ends.
12. **SC-12 No timer without an exact lifetime**
    - **Given** a Codex chat, or a pi or omp chat whose agent reports no exact cache lifetime
    - **When** a turn ends
    - **Then** no cache timer shows. Tokens still show.
13. **SC-13 Announcements**
    - **Given** a screen reader user in a chat with a running cache timer
    - **When** the timer turns amber or goes cold
    - **Then** that change is announced once, and the per-second ticks are never announced.

### Ended, crashed, offline

14. **SC-14 Ended and crashed**
    - **Given** a chat whose agent process has exited
    - **When** the user looks at the header
    - **Then** (a) a clean exit shows a grey dot and "Ended"; (b) a crash shows a red dot and "Stopped unexpectedly". The header adds no Resume or Restart button: Resume stays in the composer and Restart in the transcript's error row, as today. Tokens stay, and the cache timer keeps counting down.
15. **SC-15 Offline**
    - **Given** an open chat
    - **When** the app loses its connection to the daemon
    - **Then** the status reads "Reconnecting…", tokens and the cache timer freeze at their last values and dim, and Rename and Fork chat are disabled with the reason "Reconnecting…". When the connection returns, the figures refresh and the actions turn back on.

### ⋯ menu

16. **SC-16 Menu contents**
    - **Given** a chat
    - **When** the user opens ⋯
    - **Then** it lists Rename, Fork chat, Session info, a separator, and Show all events as a checked item that reflects and toggles the current setting. Session info opens the Session info panel for this chat.
17. **SC-17 Fork waits for the turn**
    - **Given** a chat whose agent is mid-turn
    - **When** the user opens ⋯
    - **Then** Fork chat is disabled with "Available when the turn ends".

### Rename

18. **SC-18 Rename in place**
    - **Given** a chat titled "Fix flaky worktree window test"*
    - **When** the user clicks the title (or picks Rename), types a new title and presses Enter
    - **Then** the new title shows in the header, the tab and every list that shows the chat, and it survives restarts and resume.
    - **Walkthrough:**
      1. The user clicks the title. ✓ It becomes a field with the text selected
      2. The user types "Worktree test flake: wait on view event"* and presses Enter
    - **Data after:** **Chat**: ✓ title "Worktree test flake: wait on view event" in the header and the tab
19. **SC-19 Cancel, empty and click-away**
    - **Given** the title field is open
    - **When** the user (a) presses Esc; (b) clears the field and presses Enter; (c) clicks elsewhere
    - **Then** (a) the old title comes back unchanged; (b) the old title comes back, because an empty title isn't saved; (c) the typed title is saved as if Enter was pressed.
20. **SC-20 Rename fails**
    - **Given** the title field is open
    - **When** the save fails
    - **Then** the typed text stays in the field with the error under it, and pressing Enter tries again.
21. **SC-21 Nothing overwrites a rename**
    - **Given** a renamed chat
    - **When** the chat is resumed, restored after a restart, or forked
    - **Then** a resumed or restored chat keeps the user's title, a fork takes that title with " (fork)" added, and nothing in Quirky replaces either automatically.

### Fork

22. **SC-22 Fork opens a new chat**
    - **Given** an idle chat titled "Fix flaky worktree window test"* on any of the four agents
    - **When** the user picks Fork chat
    - **Then** a new chat opens in a tab beside this one and becomes the active tab. It's titled "Fix flaky worktree window test (fork)", carries the conversation so far, and continues independently. The original chat is unchanged.
23. **SC-23 Fork fails**
    - **Given** an idle chat
    - **When** the user picks Fork chat and the agent refuses or the fork fails
    - **Then** an error row under the header says why and offers Retry, and no new tab opens. Retry tries the fork again and removes the row on success.

### Layout

24. **SC-24 The header never covers the transcript**
    - **Given** a chat scrolled anywhere in its transcript
    - **When** the user scrolls
    - **Then** the header stays visible in its own row, and the transcript starts below it.
25. **SC-25 Narrow pane**
    - **Given** a chat whose pane narrows, or whose plan panel opens beside it
    - **When** the header runs out of room
    - **Then** items drop in this order: tokens, then the cache timer, then the status label and time. The dot stays and shows its label on hover, the title truncates with an ellipsis, and ⋯ never clips. Figures the header dropped show at the top of the ⋯ menu.
    - **Header at each width:**

      | Room | Shown |
      |---|---|
      | Wide | title, plan chip, dot + label, tokens, cache timer, ⋯ |
      | Less | title, plan chip, dot + label, cache timer, ⋯ |
      | Narrow | title, plan chip, dot + label, ⋯ |
      | Narrowest | truncated title, plan chip, dot, ⋯ |

## Screens

The signed-off mock is [mock/mock.html](mock/mock.html), with its inventory in [mock/screens.md](mock/screens.md) and review history in [mock/review.json](mock/review.json). It was approved at v2 with no pins, after v1's cache timer was changed to track both lifetimes. It's the target for layout and flow. Its neutral palette isn't the product's, so the build uses Quirky's graphite tokens and shared components.

| Screen | State | Acceptance |
|---|---|---|
| Chat with header | working | matches mock: pulsing dot, "Working · 1m 12s" ticking, tokens, no cache timer |
| Chat with header | idle-warm | matches mock: "Done", tokens, "Cache 4:12" counting down; hover lists both lifetimes |
| Chat with header | cache-expiring | matches mock: amber in the 5-minute timer's last minute, then normal color and "Cache 55m" after 5:00 |
| Chat with header | cache-cold | matches mock: "Cache cold" chip |
| Chat with header | waiting | matches mock: amber dot, "Waiting on you", 1-hour timer in minutes |
| Chat with header | new-chat | matches mock: "Ready", no tokens, no cache timer |
| Chat with header | five-only | matches mock: 5-minute timer, amber in its last minute, cold at 5:00 |
| Chat with header | codex-idle | matches mock: tokens, no cache timer |
| Ended, crashed, offline, failed | ended | matches mock: grey dot, "Ended" |
| Ended, crashed, offline, failed | crashed | matches mock: red dot, "Stopped unexpectedly" |
| Ended, crashed, offline, failed | offline | matches mock: "Reconnecting…", figures frozen and dimmed, Rename and Fork disabled |
| Ended, crashed, offline, failed | fork-failed | matches mock: error row under the header with Retry |
| Overflow menu | default | matches mock: Rename, Fork chat, Session info, separator, Show all events checked item |
| Overflow menu | working | matches mock: Fork chat disabled, "Available when the turn ends" |
| Overflow menu | offline | matches mock: Rename and Fork chat disabled, "Reconnecting…" |
| Overflow menu | narrow | matches mock: dropped figures at the top of the menu |
| Rename in place | editing | matches mock: field with the title selected, "Enter to save · Esc to cancel" |
| Rename in place | saved | matches mock: new title in the header and the tab |
| Rename in place | failed | matches mock: typed text kept, error under the field |
| Narrow pane | wide | matches mock: everything fits beside the plan panel |
| Narrow pane | medium | matches mock: tokens dropped |
| Narrow pane | narrow | matches mock: tokens and cache timer dropped |
| Narrow pane | narrowest | matches mock: dot only, title truncated, ⋯ visible |

Open questions from the mock's gaps (elements with no existing component):

- **Click-to-rename title.** There's no shared inline-edit component, only a private one in the tasks plugin. Should the header get a shared one in `@quirky/ui`, or build on `TextField`?
- **Cache timer.** No existing component shows a ticking countdown with a tone change. Is it a new shared element, or plain text styled with existing tokens?
- **Narrow-pane figures in the menu.** `Menu` has no non-action line for dropped figures. Does it gain a header slot, or do the figures show as disabled items?
- **Token breakdown on hover.** There's no Tooltip component, and native `title` tooltips are the norm. Is a `Popover` on hover right here, or a native tooltip?

## Decisions Locked

**Purpose and scope**
- The header should look finished in the graphite style, show status at a glance, give session actions, and show usage and cache timing. Orienting you to agent, model or worktree isn't its job.
- Native chats only (Claude, Codex, pi, omp). Terminal sessions keep their current look.
- Gray areas: what it shows, what you can do from it, layout and narrow widths, and exited, error and offline states. Standard set only, no adhd run.

**What it shows**
- Status: dot, label, and elapsed time while working.
- Usage: session tokens, the same total as Session info; hover shows input, output, cache read and cache write.
- Cache timing supports 5-minute and 1-hour lifetimes at the same time, in one timer: m:ss to the 5-minute mark with amber in its last minute, then normal color in minutes to the 1-hour mark, then "Cache cold". Hidden while the agent works; hover shows both. (Changed during the UX review by your chat note.)
- No amber near the 1-hour mark — assumed, from your description of the timer; not asked directly.
- Agent and model stay in the composer and aren't repeated in the header.

**What you can do**
- One ⋯ menu at the right edge holds the actions.
- Actions: Rename, Session info, Fork chat, plus Show all events. New chat and Close aren't in the header.
- Rename by clicking the title: Enter saves, Esc cancels, and nothing overwrites a rename.
- A rename shows everywhere the chat's title shows and survives restarts and resume.
- The plan chip stays in the bar, and Show all events moves into the menu.
- Fork works where the agent's own channel can fork, and is disabled with the reason elsewhere. Research found that all four agents can.

**Layout**
- Always visible in its own row; never overlaps the transcript.
- Narrow pane: drop tokens, then the cache timer, then the status label; the dot and ⋯ always stay, the title truncates, and dropped figures show in the menu.

**States**
- Exited: status only. Resume stays in the composer.
- Offline: "Reconnecting…", figures frozen and dimmed, Rename and Fork disabled.
- Missing data: hidden until the agent reports it.
- Action errors: inline. Rename keeps the typed text with the error; Fork shows an error row with Retry.

**Approach**
- The daemon keeps a usage summary for each chat, and the header, Session info and the tab tooltip read it.

**Success**
- It matches the graphite UI (shared components and tokens only, passing the UI lint and screenshot review).
- Nothing clips in a narrow pane.
- The cache timer matches the real expiry, checked against a real Claude session.
- Fork opens a working chat on every agent that supports it.

**UX review**
- Looks right at mock v2. All five screens were visited, with no pins.

## Industry Insights

- **Headers in other agents are thin.** Claude Code desktop, Zed, Cursor and Warp keep a click-to-rename title and one to four buttons, with model, usage and cost near the composer. ([Claude Code desktop](https://code.claude.com/docs/en/desktop), [Zed agent panel](https://zed.dev/docs/ai/agent-panel), [Warp vertical tabs](https://docs.warp.dev/terminal/windows/vertical-tabs/))
- **Sticky bars that overlay the transcript hide the start of replies.** ([Cursor forum](https://forum.cursor.com/t/sticky-prompt-header-in-the-chat-pane-covers-the-first-lines-of-the-agents-response/171666))
- **Narrow panes clip trailing buttons, and icons appearing shift header text.** The fix is folding overflow into a menu and keeping widths fixed. ([cmux #30215](https://github.com/manaflow-ai/cmux/issues/30215), [GitLab #530584](https://gitlab.com/gitlab-org/gitlab/-/issues/530584))
- **Auto-titles overwriting renames is the most-reported title bug.** ([Archon #111](https://github.com/rajababa-io/Archon/issues/111), [VS Code #316994](https://github.com/microsoft/vscode/issues/316994), [Claude Code #94025](https://github.com/anthropics/claude-code/issues/94025))
- **Status changes must be announced without moving focus**, and a live region should be updated in place rather than remounted. ([WCAG 4.1.3](https://www.properaccess.nl/en/blog/wcag-4-1-3-status-messages/), [Cognigy webchat](https://github.com/Cognigy/Webchat/blob/main/docs/accessibility.md))
- **Anthropic's cache lifetime starts at the start of the request and refreshes on every hit.** Claude Code picks 1 hour for main-conversation turns on a subscription within plan limits and 5 minutes for API keys, cloud providers, subagents, compaction and forks, so one chat can hold both. Usage reports the 5-minute and 1-hour cache writes separately. ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching), [Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking))
- **Community cache timers often count from the end of the reply,** which overstates time left. ([claude-cache-timer](https://github.com/mileschintw/claude-cache-timer))
- **OpenAI only promises a minimum cache lifetime**, so a Codex countdown can't be exact. ([OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching))
- **All four agents can fork natively:** Claude Agent SDK `forkSession`, Codex `thread/fork`, pi `fork` and `clone`, omp `fork`. All four report input, output and cache tokens. ([Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [pi RPC](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc-commands.md), [omp RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md))
- **A resumed or forked Claude result includes earlier spend**, so summing naively double-counts. ([Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking))

## Deferred Ideas

- Automatic titles after the first turn.
- A context-used ring in the header.
- The plan window (5-hour limit) in the status bar.
- A header for terminal sessions.
- [tech-spec] Whether pi and omp report an exact cache lifetime (SC-12 hides the timer when they don't).
- [tech-spec] The open Claude SDK bug where forks of long sessions miss the prompt cache ([#528](https://github.com/anthropics/claude-agent-sdk-typescript/issues/528)).
- [tech-spec] Which Claude SDK version carries the separate 5-minute and 1-hour cache fields.
- [tech-spec] How resumed totals avoid double counting (SC-5).
- [tech-spec] Where the title is saved, and how a rename reaches tabs and lists.
- [tech-spec] New header states in `plugins/quirky.session/ui-scoreboard.json`.

## Glossary

- **Usage summary:** the daemon's running record for one chat: token totals by category plus the cache state.
- **Cache lifetime:** how long the agent's prompt cache stays warm after a call starts: 5 minutes or 1 hour. A chat can hold both at once.
- **Cache cold:** every lifetime has run out, so the next message re-reads the whole context at full price.
- **Fork:** a new chat that continues from this conversation in its own tab, leaving the original untouched.
- **Title vs name:** the title is the readable label you can rename. The name is the existing lowercase handle scripts use, and it doesn't change.

## Status & amendments

**Status:** Approved 2026-11-19 in the brainstorm companion. Tech spec: authored (gate: crosses subsystems, >3 files), see tech.md.

**Amendments:** none yet.
