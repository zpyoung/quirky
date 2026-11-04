<!-- generated from logic.json by render_spec.py — do not edit -->

# Avatar

## Status & amendments

**Status:** Approved · Tech spec: authored (tech.md; gate fired: crosses subsystems, >3 files)

**Amendments:**
none

## Purpose

The avatar stands in for you over the worktrees you hand it. It supervises the agents working there while you're away: it answers their questions, decides their permission requests, gets stuck ones moving, has their work reviewed by another model family, and merges when the mandate allows it. When you come back, a report puts the few things only you can decide at the top.

## Conceptual model

**The avatar is a built-in plugin, `quirky.avatar`, and it never writes code itself.** It supervises the agents that do. Every decision it makes is journaled with the mandate clause or rule it relied on.

It has two parts:

- **The gate** is plain code that decides permission requests by fixed rules.
- **The brain** is one structured agent session (Claude, Codex, pi or omp) that handles everything the rules don't settle. It has no shell or file tools of its own and acts only through the avatar's methods.

The things you deal with:

- **Mandate**, one per worktree: goal, done when, guidelines, level and floor switches. Several worktrees can share one goal, with notes for each. Only you change a mandate. The avatar can propose an edit.
- **Level**, set per worktree from a Settings default (Full, unless you change it). *Shadow* logs what it would do and acts on nothing, *Local* allows nothing that leaves the machine, *Own branch* adds pushing and draft PRs, and *Full* adds whatever the mandate allows, merge included.
- **Floor**, which every level sits above. The fixed core (anything outside the handed-off worktrees, and credentials) is always held. The switches (messaging people, history rewrites and remote branch deletes, deploys and migrations) are held unless Settings or the hand-off turns one on.
- **Hand-off**: the worktree is the avatar's until you take it back, whether you're at your desk or not.
- **Needs-you queue**: held actions, open questions, unconfirmed guesses, proposed mandate edits, parked worktrees and failed gate checks. It's the top of your report and the only reason the avatar notifies you.

The avatar is separate from Heimdall, and Heimdall is unchanged. To keep two supervisors off one worktree, the first version refuses to hand off a worktree that has a live Heimdall watcher.

**Where you see it.** The avatar uses Quirky's existing places and adds no new kind of window. The approved mock is `ux-mock.html` beside this spec.

- **Window bar pill**: `Avatar · 4 handed off`. It turns amber with a count (`Avatar · 3 need you`) when the needs-you queue has items. One click opens the report.
- **Avatar panel**, in the left-bottom slot by default and movable like any tool: each handed-off worktree with its state and level, plus **Hand off…** and **Take back all**.
- **Worktree sidebar**: handed-off rows get an accent ring on the status dot and an `Avatar ·` prefix.
- **Avatar view**, a center tab with Live, Report and Log.
- **Hand-off sheet**, a table that opens from the panel, the pill, a worktree's context menu or a sidebar multi-select.
- **Questions**: the avatar's questions are ordinary quirky asks, so they appear in the Questions panel and on your phone like any agent's.
- **Settings → Avatar** for defaults, and `quirky avatar handoff | status | report | log | take-back [--all]` on the CLI.

## Data flow

Every tool call a worker makes blocks on its hook before it runs: Claude's and Codex's PreToolUse hooks, and the pi-family extension's tool call handler for omp and pi. These fire on every call, including calls the agent's own settings would allow without asking, so the agent's permission mode never decides for the avatar. The gate answers from the floor, the level and the fixed rules. Only what's left goes to the brain, which sees the mandate, the house rules and the proposed call, and never the worker's explanation. The answer goes straight back to the waiting worker.

Everything else is an event. A worker settles, waits or blocks, a worker asks a question, a check finishes, a PR gets a review, or you answer one of the avatar's asks. Each wakes the brain, which acts only through Quirky's public methods: sending a message, answering an ask, asking you a question, starting a session, running a check, opening or merging a PR. It can also step into any supervised session through its terminal to interrupt the worker and tell it to stop or change course, whenever it judges something shouldn't be done. A slow watchdog also wakes it so that silence gets noticed.

Pushes, PRs and merges go through an outbox, where each is recorded before it happens. Anything the avatar can't do alone goes into the needs-you queue, which feeds the pill count, the report, and the one notification sent when every handed-off worktree is waiting on you.

## Behavior & scenarios

### The sheet hands off any eligible worktree with its own mandate, alone or in bulk

1. **SC-1**
   - **Given** The hand-off sheet is open, with worktrees grouped by project group, then project
   - **When** You tick a project's checkbox, change one row's level, fill in each row's goal and done when, and press Hand off
   - **Then** Every eligible worktree under that project is handed off with its own mandate, the sheet closes, and each worktree starts without waiting for the others
   - **Alternatives** The sheet stays open until the avatar has asked its questions, and you press a second button to start
   - **Data before:** **Project quirky**: provider-host (Codex running), fix-desktop (Claude running), sa-browser (Claude running), all yours    
     **Settings**: default level Full
   - **Walkthrough:**
     1. You tick **Project quirky**; 3 rows are selected
     2. You set sa-browser to Own branch from its row
     3. You fill in goals and done when, for example provider-host: done when `bun scripts/suite.ts plugins/quirky.agents`* passes
     4. You press Hand off
   - **Data after:** **provider-host**: ✓ handed off, Full    
     **fix-desktop**: ✓ handed off, Full    
     **sa-browser**: ✓ handed off, Own branch    
     **Pill**: ✓ `Avatar · 3 handed off`
   - Each row holds a goal, done when and level, and expands for guidelines, switches and the agent to start if none is running. House rules from Settings apply to every mandate without being retyped. The sheet has a filter, a sort and an *only with a running agent* toggle, and a bulk bar that sets level, switches or one shared goal for the selection. Done when should be something the avatar can run; when it's prose, the avatar judges it and says so in the report.

2. **SC-2**
   - **Given** The sheet lists every worktree you can see
   - **When** A worktree has a live Heimdall watcher, its running agent has no permission hook the avatar can use, it isn't a git worktree, or it lives on another machine
   - **Then** Its row stays visible with the reason and can't be selected, and selecting its project or group skips it
   - **Alternatives** Ineligible worktrees are hidden from the sheet
   - **Row reasons:**

     | Worktree | Shown |
     |---|---|
     | kestrel main* | ✗ "Can't hand off: a Heimdall watcher supervises it" |
     | orca agent-tabs* with Gemini | ✗ "Can't hand off: Gemini has no permission hook" |
     | provider-host* with Codex | ✓ eligible, with a note that hosted tools aren't gated |

   - A worktree that's already handed off opens its mandate for editing instead. The sheet also names agents that have paths no hook sees, such as Codex's hosted tools, so you know what isn't gated.

3. **SC-3**
   - **Given** You've given several selected worktrees one shared goal from the bulk bar
   - **When** The avatar supervises them
   - **Then** Each keeps its own notes under the shared goal, and the avatar coordinates them: it decides merge order and carries a change one worktree needs from another
   - **Alternatives** Each worktree gets an independent copy of the goal and the avatar doesn't coordinate them
   - Shared goals are how one feature split across worktrees lands in a sensible order.

4. **SC-4**
   - **Given** You've handed off every eligible worktree
   - **When** You create a new worktree afterwards, or the avatar creates one because a mandate allows splitting the work
   - **Then** The one you created stays yours, and the one the avatar created joins the hand-off with the parent's mandate
   - **Alternatives** Handing off all also covers worktrees created later
   - Handing off all takes a snapshot of the worktrees that exist at that moment.

5. **SC-5**
   - **Given** Some worktrees are already handed off
   - **When** You hand off another from its context menu, a one-row sheet, or the CLI
   - **Then** It joins with its own mandate, and the existing hand-offs don't change
   - **Data before:** **sa-browser**: yours
   - **Walkthrough:**
     1. You run `quirky avatar handoff sa-browser --goal "Fix the two failing checks"* --done-when "PR checks green"* --level own-branch`
   - **Data after:** **sa-browser**: ✓ handed off, Own branch    
     **Pill**: ✓ count up by one
   - The CLI takes the same fields as the sheet.

### Each handed-off worktree starts on its own once its gate is proven

1. **SC-6**
   - **Given** You've just handed off a worktree
   - **When** The avatar checks that the worktree's agent routes its permission requests to the gate, and the check fails, for example because the agent started before the avatar's hook was installed
   - **Then** The avatar doesn't supervise that worktree, and the needs-you queue gets *Restart to hand off*, which restarts the agent with a recovery note and runs the check again
   - **Alternatives** The avatar supervises the worktree anyway and answers only questions and events, without deciding permissions
   - Supervising a worker whose permission requests never reach the gate would mean the floor isn't enforced there. The other worktrees in the same hand-off aren't affected.

2. **SC-7**
   - **Given** You've handed off worktrees whose mandates leave something open
   - **When** The brain reviews each mandate
   - **Then** It asks as many questions as the mandate needs, with no fixed limit, as quirky asks, or none when a mandate is clear; each is focused and sharp, and work the questions don't touch starts at once while work they do touch waits for your answer
   - **Alternatives** It asks at most about three questions per worktree; There's an *Ask me first* button, and the avatar asks nothing unless you press it
   - **Data before:** **fix-desktop**: goal "Show command badges on tabs"*; nothing says what the tooltip shows
   - **Walkthrough:**
     1. The brain asks one question: "Should the badge tooltip show the full command or just its name?"*
     2. The worker starts on the badge layout, which the question doesn't touch
     3. You answer "full command" from your phone an hour later
     4. The brain sends the answer to the worker
   - **Data after:** **fix-desktop**: ✓ layout started at hand-off; ✓ tooltip work released after your answer
   - A focused, sharp question is one the mandate and the repo can't answer, and whose answer changes what the worker does. Questions are batched per worktree. Unanswered questions wait in the report, so leaving without answering holds only the parts they affect.

3. **SC-8**
   - **Given** A worktree has just been handed off and passed its gate check
   - **When** An agent is already running there, or nothing is running
   - **Then** (a) A running agent keeps its pane and gets the mandate at its next idle prompt, never mid-turn; (b) where nothing runs, the avatar starts the row's agent (your default agent unless you picked another) with the mandate as its first prompt
   - **Alternatives** The avatar stops any running agent and starts a fresh one with the mandate
   - Keeping the running agent preserves its context and anything you were watching in its pane.

4. **SC-9**
   - **Given** At least one handed-off worktree has active work
   - **When** You leave the Mac idle
   - **Then** The system stays awake while the display may sleep, and it may sleep again once every handed-off worktree is done, parked or taken back
   - **Alternatives** The avatar doesn't manage sleep, and a sleeping Mac pauses the work
   - If you're on battery, or closing the lid without an external display, the sheet warns that macOS will sleep anyway. Any sleep that happened appears in the report.

### Every permission request takes one fixed path, and code decides before judgment

1. **SC-10**
   - **Given** A supervised worker makes a permission request
   - **When** The gate receives it
   - **Then** The first step that decides wins, in this order: floor core, floor switches, level, fixed rules, then judgment; an action above the worktree's level is denied with that reason and isn't queued
   - **Alternatives** An action above the level is held for you instead of denied
   - **Decision table:**

     | Request | Decided by | Result |
     |---|---|---|
     | Read a file in the worktree | Fixed rules | ✓ allowed, no brain call |
     | Write to `~/.ssh/config` | Floor core | ✗ held for you |
     | `git push --force-with-lease`* with the history-rewrite switch off | Floor switch | ✗ held for you |
     | `git push` at Local | Level | ✗ denied: pushing is above this hand-off's level |
     | `bun test --update-snapshots`* | Judgment | ✗ denied by guideline 1 |

   - The first four steps are code. The fixed rules allow reads, edits inside the worktree, tests and builds, and deny piping downloads into a shell, skipping git hooks, and editing any agent's hook or permission settings. Settings can extend both lists. A level is denied rather than queued because it was your explicit choice.

2. **SC-11**
   - **Given** sa-browser's mandate has guideline 1, "Don't update snapshots to make failing tests pass", at level Own branch
   - **When** Its worker asks to run a command that updates snapshots
   - **Then** The brain denies it, the worker gets the reason, and the log entry shows the path, the clause relied on, and that the judgment saw only the mandate and the command
   - **Alternatives** The judgment also reads the worker's explanation of why it wants the call
   - **Log entry:**

     | Field | Shown |
     |---|---|
     | Request | `bun test --update-snapshots`* |
     | Path | Floor core: no → Switches: no → Level: Own branch, ok → Fixed rules: no match → Judgment: deny |
     | Relied on | Mandate, guideline 1: "Don't update snapshots to make failing tests pass." |
     | Judgment saw | The mandate and the command. Not the worker's explanation. |

   - Claude Code's auto mode keeps its classifier blind to the agent's reasoning for the same reason: a worker shouldn't be able to argue its way past the gate. The log entry is what makes every decision traceable in under a minute.

3. **SC-12**
   - **Given** A worker is waiting on a permission request
   - **When** Quirky's daemon is down, the avatar is stopped, or the brain hasn't decided within about a minute
   - **Then** The call is refused with a reason to try again shortly and is never allowed, these refusals don't count toward stuck detection, and a late answer from the brain is remembered for that exact call so the retry is answered at once
   - **Alternatives** The call is allowed when the gate can't answer, so work never stalls on the avatar
   - Agent hooks fail open by default. A gate that lets calls through when it's down would make the floor depend on uptime.

4. **SC-13**
   - **Given** A worktree is handed off at Shadow
   - **When** Its worker makes a permission request, asks a question, or finishes
   - **Then** The gate doesn't answer and the agent's own prompts appear as usual, and the avatar logs what it would have decided and marks where it agreed with you
   - Shadow never sends a message, restarts a worker, pushes or merges. It's how you build trust in the avatar's judgment before giving it a higher level.

5. **SC-32**
   - **Given** A worker's own settings would allow a call without asking: an allow rule, an accept-edits mode, or omp's default yolo mode
   - **When** The worker makes the call
   - **Then** The gate still decides it by the same path as every other call
   - **Alternatives** The avatar only decides calls the agent would have asked you about
   - Claude's PermissionRequest hook, and Codex's, only fire when the agent is about to ask. A gate built on them would never see anything the worker's settings already allow, and omp allows everything by default. The gate therefore sits on the hook that fires for every call.

### What the avatar can't settle alone waits for you without stalling the rest of the work

1. **SC-14**
   - **Given** provider-host rebased onto main and its worker needs to force-push, with the history-rewrite switch off
   - **When** The worker asks to run the push
   - **Then** The worker is told the call is held for you and to carry on with anything else, the needs-you queue gets the item with Allow once and Deny, and Allow once approves exactly that call (same command, same worktree) one time
   - **Alternatives** Allow once also allows later force-pushes in the same worktree for the rest of the night
   - **Data before:** **provider-host**: needs-you empty
   - **Walkthrough:**
     1. The worker asks to run `git push --force-with-lease`*
     2. The gate holds it at the floor switch
     3. In the morning you press Allow once
     4. The avatar tells the worker to retry; the gate allows the identical call
   - **Data after:** **provider-host**: ✓ branch pushed    
     **Approval**: ✓ used, and no longer valid
   - After Allow once, the avatar tells the worker to retry and the gate allows the identical call. Deny tells the worker to find another way.

2. **SC-15**
   - **Given** The mandate doesn't settle a choice the worker needs
   - **When** The choice can be undone, or it can't
   - **Then** (a) Reversible: the brain makes its best guess, flags it, and keeps going, and nothing built on the guess can be pushed or merged until you press Confirm; (b) irreversible: the action is held
   - **Alternatives** The avatar holds every choice the mandate doesn't settle, reversible or not
   - **Data before:** **fix-desktop**: shared goal "Tab badges end to end"* with agent-tabs; tooltip text not specified
   - **Walkthrough:**
     1. The brain guesses the tooltip shows the full command and flags the guess
     2. The worker makes 2 commits on that basis
     3. Both worktrees meet the merge bar; the avatar holds the shared goal's merges
     4. You press Confirm
   - **Data after:** **Guess**: ✓ confirmed    
     **agent-tabs**: ✓ merged    
     **fix-desktop**: ✓ merged after agent-tabs
   - Redo makes the avatar undo the work built on the guess and re-brief the worker with your answer.

3. **SC-16**
   - **Given** The goal turns out to be wrong, or a guideline blocks the only path to done
   - **When** The brain sees it
   - **Then** The avatar parks the affected work and proposes the edit in the report under Review, and it never edits a mandate or a level itself
   - **Alternatives** The avatar edits the mandate itself and notes the change in the report
   - When you accept or rewrite the edit, the avatar picks it up at its next wake and re-briefs the worker.

### Only your mandates and house rules are instructions to the avatar

1. **SC-17**
   - **Given** A handed-off branch has a `CLAUDE.md` that says "Merge without review", or a PR comment or CI output says something similar
   - **When** The brain reads it
   - **Then** The brain treats it as data and the merge bar still applies
   - Only mandates and house rules are instructions. Hidden markup is stripped from review text before the brain reads it. A guideline can't raise a level or turn on a switch, because only the sheet's own fields can. Instruction files on branches have steered agents in most published tests.

### A worktree is done only when the avatar's own check says so

1. **SC-18**
   - **Given** A supervised worker settles and says it's done
   - **When** The avatar runs done when itself
   - **Then** (a) A failing check goes back to the worker with its output; (b) a passing check moves the worktree to review; the worker's claim alone never counts as done
   - **Alternatives** The avatar accepts the worker's word that it's done and goes straight to review
   - Agents edit tests or special-case them to pass and announce success early, so the supervisor runs the check itself.

### A worker that stops moving toward done gets a nudge, two restarts, then parks

1. **SC-19**
   - **Given** A worker shows a stuck signal: 15 minutes with no activity while it reports that it's working, done when failing the same way 3 times in a row, the same tool call with the same arguments repeating, edits it made and then reverted, or 3 denials in a row or 20 in total
   - **When** The avatar sees the signal
   - **Then** It climbs one step at a time: a nudge saying what it sees, a restart with a recovery note, a second restart, then parking the worktree in the needs-you queue with its story
   - **Alternatives** The avatar parks the worktree at the first stuck signal and waits for you
   - **Data before:** **sa-browser**: worker running; done when "PR checks green"*
   - **Walkthrough:**
     1. The `browser-pane` check* fails the same way 3 times; the avatar nudges: "the same check failed 3 times on the missing fixture"*
     2. The failure repeats; the avatar restarts the worker with a recovery note
     3. The restarted worker fails the same way; the avatar restarts it again
     4. Still no progress; the avatar parks the worktree
   - **Data after:** **sa-browser**: ✗ parked, idle in its pane    
     **Needs-you queue**: ✓ "sa-browser parked after 2 restarts" with Restart and Take back
   - A recovery note holds the goal, done when, what was tried and why each attempt failed, the current diff, and any guesses in play. A parked worker is left idle in its pane and no longer keeps the Mac awake. Every step is logged with the signal that triggered it. With no budgets, this ladder is the only bound on a runaway worker.

### Work leaves the machine only through cross-family review, the merge bar and the outbox

1. **SC-20**
   - **Given** Done when passes
   - **When** The avatar starts a reviewer from a different model family than the worker, and findings arrive from that reviewer, from review bots on the PR, or from review skills a worker runs
   - **Then** The avatar judges every finding: valid ones go to the worker to fix, invalid ones are dismissed with a reason in the log, and there's no fixed number of review rounds, so open findings alone never send the worktree to you
   - **Alternatives** After 2 review rounds that still have blocking findings, the worktree goes to the needs-you queue; Every finding goes to the worker, and the avatar dismisses none
   - **Data before:** **provider-host PR***: 3 findings; Codex reviewer: "missing null check on the session id"*; review bot: "rename `tmp` to `pending`"*; review bot: "unused import `path`"*
   - **Walkthrough:**
     1. The avatar judges the null check valid and sends it to the worker
     2. It judges the rename valid and sends it too
     3. It judges the import finding invalid because `path` is used further down*, and dismisses it with that reason
     4. The worker fixes both; the reviewer runs on the new commit and raises nothing new
   - **Data after:** **provider-host PR***: ✓ 2 findings fixed; ✓ 1 dismissed with a reason, its bot thread answered and resolved; ✓ moves to the merge bar
   - The cross-family reviewer gets the mandate and the diff, not the worker's own summary, and it can't edit. Judges approve self-authored work about 12 points more often, which is why the reviewer comes from another family. When the avatar dismisses a bot's finding, it answers the bot's thread with the reason and resolves it. A human reviewer's thread is different, because answering a person needs the messaging switch (SC-21). A valid finding the worker still can't fix is a stuck signal and climbs the ladder in SC-19.

2. **SC-21**
   - **Given** A worktree at Full whose mandate allows merging
   - **When** Required checks are green, every review finding on the final commit is fixed or dismissed with a reason, and no review threads are unresolved, human ones included
   - **Then** The avatar merges the exact commit that was reviewed and checked, and anything pushed after the review sends the worktree back through the merge bar
   - **Alternatives** The avatar merges the branch head at merge time, whatever it is
   - A failed check that looks flaky gets one rerun, and a second failure goes back to the worker. At Own branch the avatar stops at a draft PR, and at Local it stops at a commit. A human reviewer's unresolved thread can only be answered by the avatar when the messaging switch is on, so with it off the merge waits for you.

3. **SC-22**
   - **Given** Several worktrees share a goal and each meets the merge bar
   - **When** The avatar merges them
   - **Then** It merges in dependency order and brings the others up to date by merging main into them, so no force-push is needed, and a worker that rebases anyway hits the history-rewrite switch
   - **Alternatives** The avatar rebases the others onto main and force-pushes them
   - Merging main in keeps shared goals moving without needing the history-rewrite switch turned on.

4. **SC-23**
   - **Given** The avatar recorded a merge in its outbox and Quirky then quit
   - **When** Quirky starts again
   - **Then** The avatar checks GitHub for whether the merge happened before doing anything else, and never repeats it blindly
   - Pushes, PRs and merges are recorded before they run, so a crash between recording and running is always visible on restart.

### The avatar notifies you once, and only when the whole hand-off is waiting on you

1. **SC-24**
   - **Given** You're away
   - **When** Every handed-off worktree is waiting on you, or a floor-held action is the only way forward
   - **Then** The avatar sends one notification through Quirky's normal desktop notification, its questions also reach your phone whenever the phone is connected, and an answer from either place resumes work at once
   - **Alternatives** The avatar notifies you for every held action as it happens
   - **Notification:**

     | Element | Shown |
     |---|---|
     | Title | "Avatar needs you" |
     | Body | "All 4 handed-off worktrees are waiting on you: 1 held force-push, 1 guess to confirm, 1 mandate edit."* |
     | Action | Open report |

   - Nothing else notifies you; it waits for the report. Quirky has no phone push, so the phone only sees questions while it's connected.

### The brain can restart at any time without losing the night's work

1. **SC-25**
   - **Given** A long night of supervising
   - **When** The brain's context grows long, or its session dies
   - **Then** The avatar starts a new brain session that rebuilds its picture from the journal and carries each mandate over word for word, workers keep running meanwhile, and calls that need judgment are refused until the brain is back
   - Rebuilding from the journal on each wake keeps a long-running brain from drifting. The refusals follow SC-12. SC-29 sets when context counts as long.

2. **SC-29**
   - **Given** The brain is supervising, and its session's context reaches 300k tokens
   - **When** It finishes the event or decision it's handling
   - **Then** The avatar ends that session before the next event and starts a new one rebuilt from the journal, so the brain's context stays under 300k, and no permission request, event or answer is lost or handled twice across the switch
   - **Alternatives** The avatar compacts the session in place instead of starting a new one
   - **Data before:** **Brain session 3***: 296k tokens*; 4 worktrees handed off
   - **Walkthrough:**
     1. A permission request from fix-desktop arrives; the brain decides it and the session reaches 301k*
     2. The avatar ends session 3 and starts session 4 from the journal
     3. A worker question that arrived during the switch goes to session 4 first
   - **Data after:** **Brain session 4***: ✓ 38k tokens* after the rebuild; ✓ the question answered once; **Log**: ✓ "Rotated at 301k"*
   - Rotation happens between events, never in the middle of a decision. Events that arrive during the switch wait in the journal and go to the new session first. The log records each rotation with the context size that triggered it.

3. **SC-30**
   - **Given** The avatar starts a new brain session
   - **When** It rebuilds the brain's picture from the journal
   - **Then** The new session gets each mandate and the house rules word for word, plus a brief per handed-off worktree and per shared goal, and everything else stays in the journal for the brain to look up when it needs it
   - **Alternatives** The new session replays the whole journal
   - A worktree's brief holds its state, progress against done when, open needs-you items, guesses in play, the dead ends tried so far, and its last few decisions. A shared goal's brief adds its merge order and which worktree is waiting on which. Projects and groups only organize the sheet, so they carry no memory of their own. Keeping memory per worktree in the journal stops one busy worktree from crowding out the rest.

4. **SC-31**
   - **Given** The brain runs on a model whose context window is smaller than 300k tokens
   - **When** Its context grows
   - **Then** The rotation point drops to 80% of that model's window, and everything else in SC-29 applies unchanged
   - **Alternatives** Settings refuse a brain model with a window under 300k
   - Some models in the supported agents have 200k windows, where 300k could never be reached and the session would fail first.

### When a call slips past the gate, the avatar steps into the session rather than trusting the hook alone

1. **SC-33**
   - **Given** A worktree is handed off and its worker passed the gate check
   - **When** (a) The avatar finds a tool call in the worker's session record that never reached the gate, or (b) a file that controls the agent's hooks or permissions changes, such as a `.claude/settings.json`, `.codex` config or omp project extension arriving on the branch
   - **Then** (a) A skipped call the fixed rules would have allowed is only logged, while one the floor, the level or judgment would have stopped makes the avatar step into the session through its terminal to stop the worker and tell it why, and that call heads the report; (b) the avatar runs the gate check again, and only a failed check stops the worker with *Restart to hand off*, as in SC-6
   - **Alternatives** Any call that skipped the gate stops the worker until you restart it; Skipped calls are only flagged in the report, whatever they were
   - **Data before:** **provider-host**: Claude worker, gate check passed; level Own branch
   - **Walkthrough:**
     1. The worker runs `bun test`* and `git push origin main`*; the hook misfires and neither call reaches the gate
     2. The avatar compares the session record with the gate's receipts and finds both calls unmatched
     3. Running tests is on the allow list, so the avatar only logs it
     4. Pushing to main is above Own branch, so the avatar interrupts the worker through its terminal and tells it the push wasn't allowed
   - **Data after:** **Log**: ✓ 2 calls that skipped the gate    
     **Report**: ✓ "A push to main ran without the gate" at the top    
     **provider-host**: ✓ worker redirected, still supervised
   - Most skipped calls are reads, edits and tests the gate would have allowed anyway, so they aren't worth interrupting a worker for. The ones that matter are calls the avatar would have stopped. Stepping in can't undo something that already left the machine, such as a push, which is why that call heads the report. Hooks can be switched off by a repo's own settings, and some agents have reported hooks silently not firing, so comparing the session record with what the gate saw is the check that doesn't depend on the hook.

2. **SC-34**
   - **Given** A handed-off worktree runs Codex
   - **When** The worker uses a hosted tool such as web search or image generation, which runs on OpenAI's side and never reaches the hook
   - **Then** Hosted tools stay on, the avatar watches each use in the session record, and when it judges a use shouldn't happen it steps into the session through its terminal to stop or redirect the worker
   - **Alternatives** The avatar turns hosted tools off for supervised Codex sessions where Codex allows it; Hosted tools stay on and are only logged
   - Codex's docs say hosted tools don't use the local hook path, so the avatar can't refuse them in advance. They read from the web and can't touch the worktree, so watching and stepping in is enough. Every use is logged either way.

### Coming back changes nothing until you act, and the report puts your decisions first

1. **SC-26**
   - **Given** The needs-you queue has items
   - **When** You return to your desk
   - **Then** Nothing opens by itself, the pill turns amber with the count, and one click opens the report, which reads needs-you items with one-click answers, then a short story per worktree, then one summary line with the full log one click deeper
   - **Alternatives** The report tab takes focus the first time you unlock
   - **Report:**

     | Part | Shown |
     |---|---|
     | Needs you | ✓ "Allow a force-push?" with Allow once and Deny; ✓ "Confirm a guess?" with Confirm and Redo; ✓ "Mandate edit proposed" with Review |
     | Stories | ✓ "Tab badges end to end: both pass done when, Codex approved both diffs. Will merge agent-tabs, then fix-desktop, once you confirm the guess above."* |
     | Summary | ✓ "186 decisions: 171 allowed, 9 denied, 3 held, 3 guesses. Mac kept awake all night."* |

   - Floor switches you turned on for a worktree are listed at the top of that worktree's entries.

2. **SC-27**
   - **Given** You're at your desk and a worktree is handed off
   - **When** You type into its agent's pane
   - **Then** The avatar keeps working, never sends into the pane while you have unsent text there, doesn't countermand what you told the worker, and proposes a mandate edit if your instruction conflicts with the mandate
   - **Alternatives** Typing into a supervised pane pauses the avatar for that worktree until you resume it
   - Hand-off is ownership, so presence changes nothing. The alternative was the recommended option you passed on.

### Taking back is explicit and leaves every agent running

1. **SC-28**
   - **Given** Worktrees are handed off
   - **When** You take back one from its row, or all with Take back all or `quirky avatar take-back --all`
   - **Then** The gate stops deciding for those worktrees and the agents' own prompts return, including for a request waiting right now, every agent keeps running, outbox actions not yet started are cancelled, and the mandate is kept so handing off again opens the sheet already filled in
   - **Alternatives** Taking back stops the agents the avatar started
   - **Data before:** **provider-host**: handed off; needs-you: 1 held force-push; outbox: 1 PR not started
   - **Walkthrough:**
     1. You press Take back on provider-host's row
   - **Data after:** **provider-host**: ✓ yours, agent still running    
     **Outbox**: ✗ PR cancelled    
     **Report**: ✓ "handed back with: 1 held force-push"    
     **Mandate**: ✓ kept for next time
   - An outbox action already in flight finishes and is reported. The worktree's needs-you items leave the queue and are listed in the report as *handed back with: …*, and guesses keep their flag in the log.

## Constraints

| ID | Kind | Text | Ruling |
|---|---|---|---|
| C-plugin | placement | The avatar is a standalone built-in plugin, `quirky.avatar`, beside Heimdall, with its own journal, outbox, sheet, panel and report. Heimdall's code and enrollment rules are unchanged. | approved |
| C-panel | placement | The Avatar panel sits in the left-bottom slot under Worktrees by default and moves like any tool. | approved |
| C-pill | placement | A window-bar pill shows the hand-off count, turns amber with the needs-you count, and opens the sheet or the report. | approved |
| C-asks | placement | The avatar's questions are ordinary quirky asks, shown in the existing Questions panel and on the phone. The avatar adds no question UI of its own. | approved |
| C-agents | other | The first version supervises Claude, Codex where its hooks allow, and omp and pi through the pi-family extension. | approved |
| C-brain | other | The brain runs on any agent with a structured mode: Claude, Codex, or pi or omp in rpc mode, chosen in Settings. | approved |
| C-floor | other | The floor's fixed core (outside the handed-off worktrees, credentials) can never be lowered. Its switches (messaging people, history rewrites and remote branch deletes, deploys and migrations) default to held in Settings, and a hand-off can turn one on for that worktree. | approved |
| C-levels | naming | The levels are named Shadow, Local, Own branch and Full, and the Settings default is Full. | approved |
| C-cli | naming | The CLI is `quirky avatar handoff \| status \| report \| log \| take-back [--all]`, and `handoff` takes the same fields as the sheet. | approved |
| C-budgets | other | There are no token or spend budgets. The stuck ladder is the only runaway guard. | approved |
| C-attribution | other | The avatar's work is marked only in its own log, with no commit trailers or PR notes. | approved |
| C-success | verification | After a night away: most handed-off worktrees moved forward (merged, PR-ready, or closer to done when), nothing went outward that you'd have refused and no floor-held action was taken, every decision traces to its mandate clause or rule in under a minute, and handing off a handful of worktrees takes a couple of minutes. | approved |
| C-ng-remote | non-goal | Other machines and remote runtimes. | approved |
| C-ng-hookless | non-goal | Agents without a permission hook, meaning anything beyond Claude, Codex, omp and pi. | approved |
| C-ng-scheduled | non-goal | Scheduled or recurring hand-offs. | approved |
| C-ng-nongit | non-goal | Folders that aren't git worktrees. | approved |
| C-ng-heimdall | non-goal | Worktrees with a live Heimdall watcher. | approved |

## Requirements

### In scope

| ID | Area | Requirement | Summary | Detail | Group | Derived from |
|---|---|---|---|---|---|---|
| R-1 | Hand-off | The hand-off sheet lists every worktree grouped by project group, then project, with a filter, a sort and an only-with-a-running-agent toggle. Group and project checkboxes select every eligible worktree beneath them, and a bulk bar sets level, switches or one shared goal for the selection. | Grouped sheet with bulk select | The hand-off sheet lists every worktree grouped by project group, then project, with a filter, a sort and an only-with-a-running-agent toggle. Group and project checkboxes select every eligible worktree beneath them, and a bulk bar sets level, switches or one shared goal for the selection. | min | SC-1 |
| R-2 | Hand-off | Each sheet row edits goal, done when and level inline, and expands to guidelines, switches and the agent to start when none is running. House rules from Settings apply to every mandate without being retyped. | Mandate fields per row | Each sheet row edits goal, done when and level inline, and expands to guidelines, switches and the agent to start when none is running. House rules from Settings apply to every mandate without being retyped. | min | SC-1 |
| R-3 | Hand-off | Pressing Hand off closes the sheet and starts every handed-off worktree independently, so no worktree waits on another. | Hand off starts each worktree on its own | Pressing Hand off closes the sheet and starts every handed-off worktree independently, so no worktree waits on another. | min | SC-1 |
| R-4 | Hand-off | A worktree with a live Heimdall watcher, a running agent with no usable hook, no git worktree, or a home on another machine stays in the sheet with its reason, can't be selected, and is skipped by group and project selection. An already handed-off worktree opens its mandate for editing. The sheet names agents whose paths no hook sees. | Ineligible rows stay visible | A worktree with a live Heimdall watcher, a running agent with no usable hook, no git worktree, or a home on another machine stays in the sheet with its reason, can't be selected, and is skipped by group and project selection. An already handed-off worktree opens its mandate for editing. The sheet names agents whose paths no hook sees. | min | SC-2 |
| R-5 | Hand-off | A shared goal covers several worktrees, each with its own notes, and the avatar coordinates them by deciding merge order and carrying a change one worktree needs from another. | Shared goals | A shared goal covers several worktrees, each with its own notes, and the avatar coordinates them by deciding merge order and carrying a change one worktree needs from another. | i3 | SC-3 |
| R-6 | Hand-off | Handing off all covers only the worktrees that exist at that moment. Worktrees you create later stay yours. A worktree the avatar creates, which it does only when a mandate allows splitting the work, joins the hand-off with the parent's mandate. | Hand off all is a snapshot | Handing off all covers only the worktrees that exist at that moment. Worktrees you create later stay yours. A worktree the avatar creates, which it does only when a mandate allows splitting the work, joins the hand-off with the parent's mandate. | i2 | SC-4 |
| R-7 | Hand-off | You can hand off one more worktree at any time from its context menu or a one-row sheet, with its own mandate, and existing hand-offs don't change. | Add one worktree later | You can hand off one more worktree at any time from its context menu or a one-row sheet, with its own mandate, and existing hand-offs don't change. | min | SC-5 |
| R-8 | Hand-off | The CLI offers `quirky avatar handoff \| status \| report \| log \| take-back [--all]`, and `handoff` takes the same fields as the sheet. | CLI | The CLI offers `quirky avatar handoff \| status \| report \| log \| take-back [--all]`, and `handoff` takes the same fields as the sheet. | i2 | SC-5, SC-28, C-cli |
| R-9 | Starting | Before supervising a worktree, the avatar proves its agent's tool calls reach the gate. A failed check leaves the worktree unsupervised and puts Restart to hand off in the needs-you queue, which restarts the agent with a recovery note and checks again. Other worktrees aren't affected. | Gate check at hand-off | Before supervising a worktree, the avatar proves its agent's tool calls reach the gate. A failed check leaves the worktree unsupervised and puts Restart to hand off in the needs-you queue, which restarts the agent with a recovery note and checks again. Other worktrees aren't affected. | min | SC-6 |
| R-10 | Starting | The brain reviews each mandate and asks focused, sharp questions as ordinary quirky asks, batched per worktree, with no fixed limit and none when the mandate is clear. Work the questions don't touch starts at once, work they touch waits for your answer, and unanswered questions wait in the report. | Focused questions as quirky asks | The brain reviews each mandate and asks focused, sharp questions as ordinary quirky asks, batched per worktree, with no fixed limit and none when the mandate is clear. Work the questions don't touch starts at once, work they touch waits for your answer, and unanswered questions wait in the report. | min | SC-7, C-asks |
| R-11 | Starting | A running agent keeps its pane and receives the mandate at its next idle prompt, never mid-turn. Where nothing runs, the avatar starts the row's agent, your default agent unless you picked another, with the mandate as its first prompt. | Briefing the worker | A running agent keeps its pane and receives the mandate at its next idle prompt, never mid-turn. Where nothing runs, the avatar starts the row's agent, your default agent unless you picked another, with the mandate as its first prompt. | min | SC-8 |
| R-12 | Starting | While any handed-off worktree has active work, the system stays awake and the display may sleep. Sleep is allowed again once every handed-off worktree is done, parked or taken back. The sheet warns when you're on battery or closing the lid without an external display, and the report lists any sleep. | Keep the Mac awake | While any handed-off worktree has active work, the system stays awake and the display may sleep. Sleep is allowed again once every handed-off worktree is done, parked or taken back. The sheet warns when you're on battery or closing the lid without an external display, and the report lists any sleep. | i3 | SC-9 |
| R-13 | Deciding | The gate sits on the hook that fires before every tool call (PreToolUse for Claude and Codex, the tool call handler for pi and omp), so calls the agent's own settings would allow still go through the gate. | Gate on every tool call | The gate sits on the hook that fires before every tool call (PreToolUse for Claude and Codex, the tool call handler for pi and omp), so calls the agent's own settings would allow still go through the gate. | min | SC-32, C-agents |
| R-14 | Deciding | Every call is decided in this order, and the first step that decides wins: floor core, floor switches, level, fixed rules, judgment. An action above the worktree's level is denied with that reason and isn't queued. | Fixed decision order | Every call is decided in this order, and the first step that decides wins: floor core, floor switches, level, fixed rules, judgment. An action above the worktree's level is denied with that reason and isn't queued. | min | SC-10, C-floor, C-levels |
| R-15 | Deciding | The fixed rules allow reads, edits inside the worktree, tests and builds, and deny piping downloads into a shell, skipping git hooks, and editing any agent's hook or permission settings. Settings can extend both lists. | Fixed allow and deny lists | The fixed rules allow reads, edits inside the worktree, tests and builds, and deny piping downloads into a shell, skipping git hooks, and editing any agent's hook or permission settings. Settings can extend both lists. | min | SC-10 |
| R-16 | Deciding | The floor's fixed core (anything outside the handed-off worktrees, and credentials) is always held and can't be lowered. Its switches (messaging people, history rewrites and remote branch deletes, deploys and migrations) default to held in Settings, a hand-off can turn one on for that worktree, and switched-on items head that worktree's report entries. | Configurable floor | The floor's fixed core (anything outside the handed-off worktrees, and credentials) is always held and can't be lowered. Its switches (messaging people, history rewrites and remote branch deletes, deploys and migrations) default to held in Settings, a hand-off can turn one on for that worktree, and switched-on items head that worktree's report entries. | min | C-floor, SC-14, SC-26 |
| R-17 | Deciding | The levels are Shadow, Local, Own branch and Full. Settings hold the default, which is Full, and each hand-off can raise or lower it. | Four levels | The levels are Shadow, Local, Own branch and Full. Settings hold the default, which is Full, and each hand-off can raise or lower it. | min | C-levels |
| R-18 | Deciding | Judgment sees the mandate, the house rules and the proposed call, never the worker's explanation. Every decision's log entry shows the path it took, the clause or rule relied on, and what the judgment saw. | Reasoning-blind judgment, traceable | Judgment sees the mandate, the house rules and the proposed call, never the worker's explanation. Every decision's log entry shows the path it took, the clause or rule relied on, and what the judgment saw. | min | SC-11 |
| R-19 | Deciding | When Quirky's daemon is down, the avatar is stopped, or the brain hasn't decided within about a minute, the call is refused with a reason to retry and never allowed. These refusals don't count toward stuck detection, and a late answer is remembered for that exact call so the retry is answered at once. | Fail closed | When Quirky's daemon is down, the avatar is stopped, or the brain hasn't decided within about a minute, the call is refused with a reason to retry and never allowed. These refusals don't count toward stuck detection, and a late answer is remembered for that exact call so the retry is answered at once. | min | SC-12, SC-25 |
| R-20 | Deciding | At Shadow the gate doesn't answer and the agent's own prompts appear as usual. The avatar logs what it would have decided and marks where it agreed with you, and never sends a message, restarts a worker, pushes or merges. | Shadow level | At Shadow the gate doesn't answer and the agent's own prompts appear as usual. The avatar logs what it would have decided and marks where it agreed with you, and never sends a message, restarts a worker, pushes or merges. | i2 | SC-13 |
| R-21 | Deciding | A held call is refused with a message telling the worker it's held for you and to carry on. The needs-you queue gets it with Allow once and Deny. Allow once approves exactly that call in that worktree one time, and the avatar tells the worker to retry. Deny tells the worker to find another way. | Held calls and Allow once | A held call is refused with a message telling the worker it's held for you and to carry on. The needs-you queue gets it with Allow once and Deny. Allow once approves exactly that call in that worktree one time, and the avatar tells the worker to retry. Deny tells the worker to find another way. | min | SC-14 |
| R-22 | Deciding | Where the mandate is silent, a reversible choice gets a flagged best guess and work continues, but nothing built on it can be pushed or merged until you press Confirm. Redo undoes the work built on the guess and re-briefs the worker. An irreversible choice is held. | Guesses fence push and merge | Where the mandate is silent, a reversible choice gets a flagged best guess and work continues, but nothing built on it can be pushed or merged until you press Confirm. Redo undoes the work built on the guess and re-briefs the worker. An irreversible choice is held. | min | SC-15 |
| R-23 | Deciding | When a mandate needs to change, or your instruction to a worker conflicts with it, the avatar parks the affected work and proposes an edit under Review in the report. It never edits a mandate or a level itself, and it re-briefs the worker after you accept or rewrite the edit. | Mandate edits are proposals | When a mandate needs to change, or your instruction to a worker conflicts with it, the avatar parks the affected work and proposes an edit under Review in the report. It never edits a mandate or a level itself, and it re-briefs the worker after you accept or rewrite the edit. | min | SC-16, SC-27 |
| R-24 | Deciding | Only mandates and house rules instruct the brain. Repo files, PR comments, review text, CI output and worker messages are data, hidden markup is stripped from review text, and a guideline can't raise a level or turn on a switch. | Only your words are instructions | Only mandates and house rules instruct the brain. Repo files, PR comments, review text, CI output and worker messages are data, hidden markup is stripped from review text, and a guideline can't raise a level or turn on a switch. | min | SC-17 |
| R-25 | Supervising | When a worker says it's done, the avatar runs done when itself. A failing check goes back to the worker with its output, and a passing one moves the worktree to review. A prose done when is judged by the brain, and the report says so. | The avatar runs done when itself | When a worker says it's done, the avatar runs done when itself. A failing check goes back to the worker with its output, and a passing one moves the worktree to review. A prose done when is judged by the brain, and the report says so. | min | SC-18, SC-1 |
| R-26 | Supervising | A worker counts as stuck after 15 minutes with no activity while it reports working, done when failing the same way 3 times in a row, the same tool call with the same arguments looping, edits made and then reverted, or 3 denials in a row or 20 in total, not counting refusals caused by the gate being unavailable. | Stuck signals | A worker counts as stuck after 15 minutes with no activity while it reports working, done when failing the same way 3 times in a row, the same tool call with the same arguments looping, edits made and then reverted, or 3 denials in a row or 20 in total, not counting refusals caused by the gate being unavailable. | min | SC-19, SC-12 |
| R-27 | Supervising | A stuck worker gets a nudge saying what the avatar sees, then a restart with a recovery note (goal, done when, attempts and why they failed, the current diff, guesses in play), then a second restart, then parking: the worker is left idle in its pane, the worktree goes to the needs-you queue with its story, and it stops keeping the Mac awake. Every step is logged with its trigger. | Stuck ladder | A stuck worker gets a nudge saying what the avatar sees, then a restart with a recovery note (goal, done when, attempts and why they failed, the current diff, guesses in play), then a second restart, then parking: the worker is left idle in its pane, the worktree goes to the needs-you queue with its story, and it stops keeping the Mac awake. Every step is logged with its trigger. | min | SC-19, C-budgets |
| R-28 | Supervising | The avatar enforces no token or spend budget. The stuck ladder is the only guard against a runaway worker. | No budgets | The avatar enforces no token or spend budget. The stuck ladder is the only guard against a runaway worker. | min | C-budgets |
| R-29 | Shipping | Once done when passes, the avatar starts a reviewer from a different model family than the worker. The reviewer gets the mandate and the diff, not the worker's summary, and can't edit. | Cross-family reviewer | Once done when passes, the avatar starts a reviewer from a different model family than the worker. The reviewer gets the mandate and the diff, not the worker's summary, and can't edit. | i3 | SC-20 |
| R-30 | Shipping | The avatar judges every review finding, whether from its reviewer, a review bot on the PR, or a review skill a worker runs. Valid findings go to the worker. Invalid ones are dismissed with a reason in the log, and a bot's thread is answered and resolved. There's no fixed number of rounds, and a valid finding the worker can't fix becomes a stuck signal. | The avatar judges findings | The avatar judges every review finding, whether from its reviewer, a review bot on the PR, or a review skill a worker runs. Valid findings go to the worker. Invalid ones are dismissed with a reason in the log, and a bot's thread is answered and resolved. There's no fixed number of rounds, and a valid finding the worker can't fix becomes a stuck signal. | i3 | SC-20 |
| R-31 | Shipping | At Full, the avatar merges only when required checks are green, every finding on the final commit is fixed or dismissed with a reason, and no review thread is unresolved, human ones included. It merges the exact commit that was reviewed and checked, and anything pushed later goes back through the bar. A flaky-looking check gets one rerun. A human reviewer's thread can be answered only with the messaging switch on, so otherwise the merge waits for you. | Merge bar at Full | At Full, the avatar merges only when required checks are green, every finding on the final commit is fixed or dismissed with a reason, and no review thread is unresolved, human ones included. It merges the exact commit that was reviewed and checked, and anything pushed later goes back through the bar. A flaky-looking check gets one rerun. A human reviewer's thread can be answered only with the messaging switch on, so otherwise the merge waits for you. | i3 | SC-21 |
| R-32 | Shipping | At Own branch the avatar stops at a draft PR, and at Local it stops at a commit. | Where each level stops | At Own branch the avatar stops at a draft PR, and at Local it stops at a commit. | min | SC-21, C-levels |
| R-33 | Shipping | Worktrees under a shared goal merge in dependency order, and the rest are brought up to date by merging main into them, so no force-push is needed. A worker that rebases anyway hits the history-rewrite switch. | Shared-goal merge order | Worktrees under a shared goal merge in dependency order, and the rest are brought up to date by merging main into them, so no force-push is needed. A worker that rebases anyway hits the history-rewrite switch. | i2 | SC-22 |
| R-34 | Shipping | Pushes, PRs and merges are recorded before they run. After a crash, the avatar checks GitHub for what actually happened before doing anything else and never repeats an action blindly. | Outbox for outward actions | Pushes, PRs and merges are recorded before they run. After a crash, the avatar checks GitHub for what actually happened before doing anything else and never repeats an action blindly. | min | SC-23, C-plugin |
| R-35 | Reaching you | The avatar sends one desktop notification, only when every handed-off worktree is waiting on you or a floor-held action is the only way forward. Its questions also reach your phone while the phone is connected, and an answer from either place resumes work at once. | One notification when fully blocked | The avatar sends one desktop notification, only when every handed-off worktree is waiting on you or a floor-held action is the only way forward. Its questions also reach your phone while the phone is connected, and an answer from either place resumes work at once. | i3 | SC-24 |
| R-36 | Supervising | The brain runs on any agent with a structured mode (Claude, Codex, or pi or omp in rpc mode), chosen in Settings. It has no shell or file tools of its own and acts only through the avatar's methods. | The brain | The brain runs on any agent with a structured mode (Claude, Codex, or pi or omp in rpc mode), chosen in Settings. It has no shell or file tools of its own and acts only through the avatar's methods. | min | C-brain |
| R-37 | Supervising | When the brain's session dies, the avatar starts a new one rebuilt from the journal with each mandate carried over word for word. Workers keep running, and calls that need judgment are refused until the brain is back. | Brain restarts from the journal | When the brain's session dies, the avatar starts a new one rebuilt from the journal with each mandate carried over word for word. Workers keep running, and calls that need judgment are refused until the brain is back. | min | SC-25 |
| R-38 | Supervising | The brain's context stays under 300k tokens, or 80% of the model's window when that's smaller. At the limit the avatar starts a new session between events, never mid-decision. Events that arrive meanwhile go to the new session first, nothing is lost or handled twice, and the rotation is logged with its size. | Context stays under 300k | The brain's context stays under 300k tokens, or 80% of the model's window when that's smaller. At the limit the avatar starts a new session between events, never mid-decision. Events that arrive meanwhile go to the new session first, nothing is lost or handled twice, and the rotation is logged with its size. | min | SC-29, SC-31 |
| R-39 | Supervising | A rebuilt session gets each mandate and the house rules word for word, a brief per worktree (state, progress against done when, open needs-you items, guesses, dead ends, last few decisions) and a brief per shared goal (merge order, who waits on whom). Everything else stays in the journal for lookup. Projects and groups carry no memory of their own. | What a rebuilt session holds | A rebuilt session gets each mandate and the house rules word for word, a brief per worktree (state, progress against done when, open needs-you items, guesses, dead ends, last few decisions) and a brief per shared goal (merge order, who waits on whom). Everything else stays in the journal for lookup. Projects and groups carry no memory of their own. | min | SC-30, SC-3 |
| R-40 | Supervising | The avatar compares each worker's session record with the gate's receipts. A skipped call the gate would have allowed is only logged. A skipped call the floor, level or judgment would have stopped makes the avatar stop the worker through its terminal and say why, and that call heads the report. | Session-record check | The avatar compares each worker's session record with the gate's receipts. A skipped call the gate would have allowed is only logged. A skipped call the floor, level or judgment would have stopped makes the avatar stop the worker through its terminal and say why, and that call heads the report. | i3 | SC-33 |
| R-41 | Supervising | When a file that controls an agent's hooks or permissions changes, the avatar runs the gate check again, and only a failed check stops the worker with Restart to hand off. | Hook config watch | When a file that controls an agent's hooks or permissions changes, the avatar runs the gate check again, and only a failed check stops the worker with Restart to hand off. | i3 | SC-33 |
| R-42 | Supervising | Codex's hosted tools stay on. The avatar logs every use from the session record and steps in through the terminal when it judges a use shouldn't happen. | Codex hosted tools | Codex's hosted tools stay on. The avatar logs every use from the session record and steps in through the terminal when it judges a use shouldn't happen. | i2 | SC-34 |
| R-43 | Supervising | The avatar can step into any supervised session through its terminal to interrupt the worker and tell it to stop or change course. It never sends into a pane while you have unsent text there. | Stepping in through the terminal | The avatar can step into any supervised session through its terminal to interrupt the worker and tell it to stop or change course. It never sends into a pane while you have unsent text there. | i3 | SC-27, SC-33, SC-34 |
| R-44 | Coming back | A window-bar pill reads `Avatar · 4 handed off`, turns amber as `Avatar · 3 need you` when the needs-you queue has items, and opens the sheet or the report. Nothing opens by itself. | Window-bar pill | A window-bar pill reads `Avatar · 4 handed off`, turns amber as `Avatar · 3 need you` when the needs-you queue has items, and opens the sheet or the report. Nothing opens by itself. | min | SC-26, C-pill |
| R-45 | Coming back | The report lists needs-you items first with one-click answers (Allow once and Deny, Confirm and Redo, Review, Answer, Restart and Take back, Restart to hand off), then a short story per worktree, then one summary line with decision counts, guesses and any sleep, with the full log one click deeper. | Needs-you-first report | The report lists needs-you items first with one-click answers (Allow once and Deny, Confirm and Redo, Review, Answer, Restart and Take back, Restart to hand off), then a short story per worktree, then one summary line with decision counts, guesses and any sleep, with the full log one click deeper. | min | SC-26 |
| R-46 | Coming back | The Avatar panel sits in the left-bottom slot by default, moves like any tool, and lists handed-off worktrees with state and level plus Hand off and Take back all. Handed-off sidebar rows get an accent ring and an `Avatar ·` prefix, and the Avatar center view has Live, Report and Log. | Panel, sidebar and view | The Avatar panel sits in the left-bottom slot by default, moves like any tool, and lists handed-off worktrees with state and level plus Hand off and Take back all. Handed-off sidebar rows get an accent ring and an `Avatar ·` prefix, and the Avatar center view has Live, Report and Log. | i2 | C-panel |
| R-47 | Coming back | Typing into a supervised pane doesn't pause the avatar, and it doesn't countermand what you tell a worker. | Presence changes nothing | Typing into a supervised pane doesn't pause the avatar, and it doesn't countermand what you tell a worker. | i2 | SC-27 |
| R-48 | Coming back | The avatar marks its work only in its own log, with no commit trailers or PR notes. | Attribution in the log only | The avatar marks its work only in its own log, with no commit trailers or PR notes. | min | C-attribution |
| R-49 | Taking back | Take back works for one worktree or all, from the panel or the CLI. The gate stops deciding and the agents' own prompts return, including for a waiting request. Every agent keeps running. Unstarted outbox actions are cancelled and one in flight finishes and is reported. The worktree's needs-you items leave the queue and appear in the report as handed back with: 1 held force-push, for example. Guesses keep their flag, the keep-awake hold is released when nothing is active, and the mandate is kept so the next hand-off opens prefilled. | Take back | Take back works for one worktree or all, from the panel or the CLI. The gate stops deciding and the agents' own prompts return, including for a waiting request. Every agent keeps running. Unstarted outbox actions are cancelled and one in flight finishes and is reported. The worktree's needs-you items leave the queue and appear in the report as handed back with: 1 held force-push, for example. Guesses keep their flag, the keep-awake hold is released when nothing is active, and the mandate is kept so the next hand-off opens prefilled. | min | SC-28 |
| R-50 | Hand-off | The avatar ships as the standalone built-in plugin `quirky.avatar` with its own journal, outbox, sheet, panel and report. Heimdall's code and enrollment rules don't change, and the avatar refuses worktrees a live Heimdall watcher supervises. | Standalone plugin beside Heimdall | The avatar ships as the standalone built-in plugin `quirky.avatar` with its own journal, outbox, sheet, panel and report. Heimdall's code and enrollment rules don't change, and the avatar refuses worktrees a live Heimdall watcher supervises. | min | C-plugin, SC-2 |
| R-51 | Coming back | After a night away, most handed-off worktrees moved forward (merged, PR-ready or closer to done when), nothing went outward that you'd have refused and no floor-held action was taken, every decision traces to its clause or rule in under a minute, and handing off a handful of worktrees took a couple of minutes. | Success check after a night away | After a night away, most handed-off worktrees moved forward (merged, PR-ready or closer to done when), nothing went outward that you'd have refused and no floor-held action was taken, every decision traces to its clause or rule in under a minute, and handing off a handful of worktrees took a couple of minutes. | min | C-success |

### Conditionally in scope

| ID | Area | Condition | Requirement | Summary | Detail | Group | Derived from |
|---|---|---|---|---|---|---|---|
| _None_ | | | | | | | |

### Out of scope

| ID | Area | Requirement | Summary | Detail | Group | Derived from |
|---|---|---|---|---|---|---|
| R-52 | Scope | Supervising worktrees on other machines or remote runtimes. | Other machines | Supervising worktrees on other machines or remote runtimes. | i1 | C-ng-remote |
| R-53 | Scope | Supervising agents without a permission hook, meaning anything beyond Claude, Codex, omp and pi. | Hookless agents | Supervising agents without a permission hook, meaning anything beyond Claude, Codex, omp and pi. | i1 | C-ng-hookless |
| R-54 | Scope | Scheduled or recurring hand-offs. | Scheduled hand-offs | Scheduled or recurring hand-offs. | i1 | C-ng-scheduled |
| R-55 | Scope | Handing off folders that aren't git worktrees. | Non-git folders | Handing off folders that aren't git worktrees. | i1 | C-ng-nongit |
| R-56 | Scope | Supervising worktrees that a live Heimdall watcher supervises. | Heimdall-watched worktrees | Supervising worktrees that a live Heimdall watcher supervises. | i1 | C-ng-heimdall |

## Assumptions & blind spots

### Assumptions

- **A-claude-hook — Claude Code's PreToolUse hook fires on every tool call, sub-agent and MCP calls included, can hold a call for up to about a minute, and fails closed with `"onFailure": "block"`.** (assumed)
  - Basis: Claude Code hooks documentation; `onFailure` needs v2.1.295 or later. A reported bug says PreToolUse didn't block in print mode or with a wildcard allowed-tools list, and it's unknown whether it's fixed.
  - If wrong: The gate can't hold Claude's requests, or Claude allows calls when the gate is down.
  - Affects: SC-10, SC-12
  - Meaning: Claude is the most common worker, so most of the floor rests on this hook.
  - Check: On the pinned Claude version, confirm a test hook blocks a normal call, a sub-agent call, an MCP call and an allow-listed call, and that a hook that times out blocks too. (cost: About two hours)
  - Reviewer ruling: build-on
- **A-codex-hook — Codex's PreToolUse hook, once trusted, blocks shell, apply_patch and MCP calls. It doesn't cover hosted tools, and Codex has no fail-closed setting, so the avatar's hook script must answer deny itself whenever it can't reach the gate.** (assumed)
  - Basis: Codex hooks documentation, which calls hooks a useful guardrail, not a complete enforcement boundary. A bug report says PreToolUse didn't fire for image generation.
  - If wrong: Codex worktrees can't be gated and must be ineligible on the sheet.
  - Affects: SC-2, C-agents, SC-12, SC-34
  - Meaning: Codex is in the first version only where its hooks allow.
  - Check: Trust a test hook in Codex and confirm it denies a shell call, an apply_patch and a sub-agent's call, and that the script's own deny wins when the gate is down. (cost: About two hours)
  - Reviewer ruling: build-on
- **A-pi-ext — Quirky's pi-family extension can block every pi and omp tool call and return a reason, and its handler blocks when it errors.** (assumed)
  - Basis: pi's extension docs (`tool_call` returns block and reason; handlers should fail closed) and omp's docs (`tool_call` errors and timeouts block, with a 30-second default budget that the avatar must raise or stay under).
  - If wrong: omp and pi worktrees can't be gated.
  - Affects: C-agents, SC-10
  - Meaning: You added omp and pi to the first version.
  - Check: Block a test tool call from the extension in both pi and omp. (cost: About two hours)
  - Reviewer ruling: build-on
- **A-host-channel — Quirky's host can gain a channel that lets an agent's hook wait on a plugin's decision.** (unverified)
  - Basis: No such channel exists today; hooks report to Quirky but don't wait for an answer.
  - If wrong: The gate needs its own local endpoint outside the plugin system.
  - Affects: SC-10, SC-12
  - Meaning: This is new host work every design option needed.
  - Check: Prototype a hook that posts to the daemon and blocks on a plugin's reply. (cost: About a day)
  - Reviewer ruling: build-on
- **A-keep-awake — The host can hold a macOS idle-sleep assertion on the avatar's behalf.** (assumed)
  - Basis: `IOPMAssertion` is the documented mechanism; Quirky's plugin power API only reports sleep and wake today.
  - If wrong: The Mac sleeps during a hand-off and the work pauses.
  - Affects: SC-9
  - Meaning: Needed for the night-away case.
  - Check: Hold an assertion from the daemon and confirm the Mac stays awake on AC with the display off. (cost: About two hours)
  - Reviewer ruling: build-on
- **A-latency — The brain decides most judgment calls well within a minute.** (unverified)
  - Basis: Judgment sees only the mandate and one proposed call, so prompts are small.
  - If wrong: Many calls are refused for time, workers churn, and stuck detection sees noise.
  - Affects: SC-12, SC-11
  - Meaning: Fail-closed refusals are only cheap if they're rare.
  - Check: Measure judgment latency in Shadow over one real night. (cost: One night in Shadow)
  - Reviewer ruling: build-on
- **A-settled — agent-status's settled signal (done, waiting, blocked) works for Claude, Codex, omp and pi alike.** (assumed)
  - Basis: agent-status normalizes all four today.
  - If wrong: The avatar misses events for some agents and leans on the watchdog.
  - Affects: SC-18, SC-19
  - Meaning: It's the main wake signal.
  - Check: Run each agent to done, waiting and blocked and read the events. (cost: About two hours)
  - Reviewer ruling: build-on

### Blind spots

- **BS-ungated — Paths no hook sees**
  - After the research, the gate moves to the hook that fires on every call (SC-32), and a session-record check catches calls that skip it (SC-33). What's still not gated: Codex's hosted tools where they can't be turned off (SC-34), files you reference in a prompt with @, and processes a command keeps running after its own call was allowed. Sub-agents and MCP in pi and omp are likely covered but unconfirmed.
  - Sources: SC-2, SC-10, SC-32, SC-33, SC-34
  - **Research finding (2026-11-04T12:40:00Z)** Most gaps close once the gate moves from PermissionRequest to the hook that fires on every call (PreToolUse for Claude and Codex, `tool_call` for pi and omp). PermissionRequest only fires when the agent is about to ask, so anything its settings allow skips it, and omp allows everything by default. What stays ungated is Codex's hosted tools, files referenced with @ in a prompt, and processes that outlive an allowed command. Hooks can also be switched off by a repo's settings or silently misfire, so the avatar should compare each session record with what the gate saw. That's now SC-32 to SC-34. — | Agent | Gated on every call | Not gated, or unconfirmed | How the avatar closes or detects it |
|---|---|---|---|
| Claude Code | PreToolUse: built-in tools, sub-agent calls, MCP, WebSearch and WebFetch | PermissionRequest misses auto-allowed calls; @file references; a reported print-mode bug; hooks off via project `disableAllHooks` | Gate on PreToolUse with `onFailure: block` (SC-32); compare the session record and watch `.claude` (SC-33) |
| Codex | PreToolUse: shell, apply_patch, MCP, local tools | Hosted tools (web search, image generation); no fail-closed setting; `write_stdin` after an allowed command; sub-agent calls unconfirmed | Hook script denies when the gate is unreachable; turn hosted tools off or log them (SC-34) |
| pi | `tool_call` for built-in and registered tools | Sub-agents and MCP come only from extensions, unconfirmed; handler errors need a try/catch to fail closed | Wrap the handler to block on error; conformance test at hand-off |
| omp | `tool_call` for registry tools, rebound into sub-agent sessions; fails closed on error or timeout | Default approval mode is yolo; `eval` can spawn a shell; project extensions load without a trust prompt; MCP unconfirmed | Gate on `tool_call`, not approval mode (SC-32); raise or stay under its 30-second budget; watch project extensions (SC-33) |

Sources: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex #20616](https://github.com/openai/codex/issues/20616), [pi extensions](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md), [omp approval mode](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/approval-mode.md), [omp extensions](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/extensions.md), [Claude print-mode bug report](https://claudeissues.com/issue/36071-pretooluse-hooks-dont-block-in-headless-p-mode-or-with-allowedtools-wildcard).
- **BS-injection — Text written to steer the brain**
  - Repo files, PR comments, review text and CI output all reach the brain. Treating them as data and stripping hidden markup reduces the risk without removing it.
  - Sources: SC-17
  - Reviewer acceptance: We have a mitigation plan with stripping
- **BS-reviewer — A reviewer swayed by the diff**
  - The cross-family reviewer reads the diff, which the worker wrote. Comments or strings in it can steer the review.
  - Sources: SC-20
  - Reviewer acceptance: This is always a risk 
- **BS-drift — Hook behavior changing between agent versions**
  - The gate check proves the wiring at hand-off. An agent update mid-night could change what the hook sees or how it fails.
  - Sources: SC-6
  - Reviewer acceptance: Breaking changes are rare
- **BS-runaway — No budgets**
  - With no spend or token limit, a worker that keeps making slow progress, or a brain that's woken constantly, can run all night. The stuck ladder only catches no progress.
  - Sources: SC-19, C-budgets
  - Reviewer acceptance: I’m fine with slow progress. 
- **BS-costeer — You and the avatar steering one pane**
  - Typing doesn't pause the avatar, so a worker can get conflicting directions from you and from the avatar within minutes.
  - Sources: SC-27
  - Reviewer acceptance: Let’s wait for this to actually be an issue
- **BS-secrets — Secrets in proposed calls**
  - A proposed command can carry a token or password in its arguments. The brain sees it, and the journal and log keep it.
  - Sources: SC-11, SC-10
  - Reviewer acceptance: That’s on the user to mitigate
- **BS-samerepo — Independent mandates in one repo**
  - Two worktrees of the same repo with separate mandates can merge conflicting changes to main. Shared goals coordinate merge order, but independent mandates don't.
  - Sources: SC-21, SC-3
  - Reviewer acceptance: The avatar will need to work out the conflict or escalate if no resolution can be determined

## Decisions Locked

### Authority

- Default reach is the full mandate: whatever the worktree's mandate allows, merge included. Only the floor waits for you.
- Settings hold a default level, and each hand-off can raise or lower it.
- Permission requests go through a fixed deny list and allow list first, and the brain judges the middle seeing only the mandate and the proposed call.
- The avatar decides for terminal and background agents through hooks and extensions: Claude, Codex where its hooks allow, and omp and pi through the pi-family extension.
- The floor is configurable. Its fixed core is never lowered: anything outside the handed-off worktrees, and credentials. Its switches are held by default: messaging people, history rewrites and remote branch deletes, deploys and migrations. Defaults live in Settings, a hand-off can switch one on for that worktree, and switched-on items head that worktree's report.
- A merge needs required checks green, a review from a different model family than the worker with every finding fixed or dismissed with a reason, and no unresolved review threads. The avatar judges each finding from its reviewer, review bots and review skills, with no fixed number of rounds. (changed in spec review)
- Only you change mandates and levels. The avatar parks affected work and proposes an edit in the report.
- The lowest level, Shadow, logs every answer, approval, restart and merge it would have made, and acts on none.

### Hand-off

- You hand off through a sheet, per worktree or per batch, with goal, done when, guidelines, level and switches. The CLI takes the same fields.
- A mandate holds goal, done when (a runnable check where one exists), guidelines, level and switches, and standing house rules from Settings apply to every mandate.
- The avatar asks focused, sharp questions per worktree, batched, with no fixed limit, or none when the mandate is clear. (changed in spec review)
- Submitting the sheet triggers the avatar's review of each mandate, and it asks its questions automatically, with no separate Ask me first button. (assumed)
- A hand-off can give several worktrees one shared goal with per-worktree notes, and the avatar coordinates them.
- A running agent keeps its pane and is briefed at its next idle prompt. If none is running, the default agent starts.
- The avatar may start, restart or add agents inside handed-off worktrees. It creates a worktree only when a mandate allows splitting, and that worktree joins with the parent's mandate.
- Handing off all is a snapshot. Later worktrees stay yours, except ones the avatar creates for a handed-off mandate.
- If you leave before answering, the avatar starts what the open questions don't touch and holds the rest. Questions wait in the report.

### Escalation

- Where the mandate is silent, a reversible choice gets a flagged best guess and work continues, but anything built on a guess can't merge or leave the machine until you confirm. An irreversible choice is held.
- Stuck means no progress toward done: silence, done when failing the same way, looping errors, reverted edits, or repeated denials (3 in a row or 20 in total).
- The avatar notifies you only when every handed-off worktree is waiting on you or a floor-held action is the only way forward. Phone answers resume work at once, and everything else waits for the report.
- There are no budgets. You watch usage, and progress-based stuck detection is the only runaway guard. (not the recommended option)
- Unsticking goes nudge, then restart with a fresh context and recovery note, then park after a second failed restart.
- The Mac stays awake (the display may sleep) while any handed-off worktree has active work, may sleep once all are done or parked, and any sleep is reported.

### Coming back

- Hand-off is ownership. The avatar works handed-off worktrees until you take them back, and presence changes nothing.
- The report is needs-you first, with one-click answers, then a short story per worktree, then the full decision log one click deeper.
- Take-back is explicit only, for one worktree or all, from the panel or CLI. Typing into a supervised pane doesn't pause the avatar. (not the recommended option)
- The avatar's work is marked only in its own log, with no commit trailers or PR notes. (not the recommended option)

### The avatar

- The brain is any agent with a structured mode: Claude, Codex, or pi or omp in rpc mode. The pre-merge reviewer comes from a different family than the worker.
- The brain's context stays under 300k tokens. At that point the avatar starts a new session rebuilt from the journal. (added in spec review)
- It's built as a standalone quirky.avatar plugin beside Heimdall: code-enforced rules as the fast path, one event-woken brain session, its own journal and outbox for outward actions, and its own hand-off sheet, panel and report. Heimdall is untouched.

### UX

- The Avatar panel lives in the left-bottom slot under Worktrees by default, movable like any tool.
- Nothing opens by itself on your return. The window-bar pill turns amber with a needs-you count, and one click opens the report.
- The hand-off sheet is a table grouped by project group, then project, with filter, sort and an only-running-agents toggle. Group and project checkboxes bulk-select, a bulk bar sets level, switches or one shared goal, rows edit goal, done when and level inline and expand for guidelines, switches and agent, and ineligible rows stay visible with the reason.
- The avatar's questions are ordinary quirky asks in the Questions panel and on the phone. The sheet closes on Hand off and work starts at once.
- The standalone UX mock was approved: pill, panel, sidebar ring, Avatar view (Live, Report, Log), sheet, questions, report, decision trace, Settings and CLI.

### Success and scope

- Success after a night away: most worktrees moved forward, nothing outward-facing you would have refused and no floor-held action taken, every decision traceable in under a minute, and a handful of worktrees handed off in a couple of minutes.
- Not in the first version: other machines and remote runtimes, agents without a permission hook, scheduled or recurring hand-offs, and non-git folders.


## Industry Insights

- Claude Code's auto mode found people accept 93% of permission prompts. Its classifier sees the user's messages and the tool calls but not the agent's reasoning, and it escalates after 3 denials in a row or 20 in total. — https://www.anthropic.com/engineering/claude-code-auto-mode
- About 0.8% of agent tool calls look irreversible, and people auto-approve more as they gain experience, so the design should favor monitoring and an easy stop. — https://www.anthropic.com/research/measuring-agent-autonomy
- A database was deleted during a prompt-only code freeze, and the fix was enforced separation. A branch rule stopped a merge that a "do not merge" instruction didn't. — https://swarmproof.github.io/agent-postmortems/2025-replit-prod-db-deletion/, https://www.lumenova.ai/blog/agentic-ai-security-incidents/
- Agents edit tests or special-case them to pass, and reviewers often rubber-stamp, so a supervisor should run checks itself and end on the check's verdict. — https://arxiv.org/abs/2510.20270, https://arxiv.org/abs/2503.13657
- Judges approve self-authored answers about 12 points more often, and the binding constraint is the environment's executable signal. — https://neurips.cc/virtual/2026/173082
- About three grounded questions recover most of the success lost to underspecified tasks, with a plateau after that. — https://arxiv.org/html/2604.14624, https://www.alphaxiv.org/overview/2603.26233
- Instruction files on a branch steer agents in most published tests, and PR-branch instruction files were treated as authoritative in 11 cases. — https://dev.to/vishall/prompt-injection-in-ai-coding-agents-how-one-claudemd-or-agentsmd-can-hijack-them-5c26, https://arxiv.org/html/2606.09935
- An agent with untrusted input, sensitive access and outward actions needs a human approval on at least one leg. — https://simonw.substack.com/p/new-prompt-injection-papers-agents
- DeepSeek's super agent prototype separates a Router that talks to the person from Workers that execute, runs a deterministic fast path before the LLM, writes recovery notes, uses a watchdog session for progress, and defaults to observe-only. Its merge rule lives only in a prompt, and it has no budgets. — https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md, https://offloop.org/learn/exploring-deepseek-super-agent-design
- Claude Code and Codex hooks both default to a 600-second timeout and fail open. Claude Code can fail closed with "onFailure": "block". Codex hooks don't cover hosted tools, and Codex calls them a useful guardrail, not a complete enforcement boundary. — https://code.claude.com/docs/en/hooks, https://learn.chatgpt.com/docs/hooks
- pi extensions can block a tool call, and omp has approval modes with per-tool allow, deny or prompt. omp's default mode is yolo, which approves everything, and its tool_call handler fails closed with a 30-second default budget. — https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md, https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/approval-mode.md, https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/extensions.md
- Claude Code's and Codex's PermissionRequest hooks only fire when the agent is about to ask, so they miss every call the agent's settings already allow. PreToolUse fires before every call, sub-agent and MCP calls included in Claude Code. — https://code.claude.com/docs/en/hooks, https://learn.chatgpt.com/docs/hooks
- Hooks can be switched off by a repo's project settings, and some hook misfires have been reported (print mode, one working directory, the VS Code extension), so a supervisor should compare the agent's session record with what its hook saw. — https://code.claude.com/docs/en/hooks, https://claudeissues.com/issue/36071-pretooluse-hooks-dont-block-in-headless-p-mode-or-with-allowedtools-wildcard, https://claudeissues.com/issue/85430-bug-pretooluse-hooks-silently-do-not-fire-for-one-working-directory-while-permis
- Outward actions need an outbox with idempotency keys derived from durable state, and a retry should first check whether the action already happened. — https://tianpan.co/blog/2026-04-19-idempotency-agentic-tool-calling-saga-deduplication, https://agentfactory.panaversity.org/docs/Agent-Workflow-Primitives/21B-postgres-system-of-record/outbox-pattern, https://arxiv.org/abs/2606.17573
- Review loops should be capped (2 rounds, then escalate), hidden markup stripped, merges pinned to the expected head commit, and flaky checks rerun once. — https://dev.to/mjmirza/my-ai-agent-almost-merged-its-own-pull-request-23nk
- Loop detection fingerprints a tool call and its arguments over a sliding window, and recovery notes must carry dead ends. — https://www.agentpatterns.ai/observability/loop-detection/
- A long-running supervisor should rebuild its state from a journal on each wake and rotate its session, with key text pinned verbatim. — https://gist.github.com/sigalovskinick/e2e329bb37ecc74b9f15d5ba74ee1ee5
- macOS idle-sleep assertions keep the system awake, but closing the lid still sleeps without an external display and power. — https://ss64.com/mac/caffeinate.html
- Heimdall can't host the avatar: it ticks every 15 to 60 seconds, so it can't answer a blocking permission request; it allows one live enrollment per workspace; its approvals can't tell a brain approval from a human one; and it can't see sessions you started yourself. — plugins/quirky.heimdall/src/pacing.ts, plugins/quirky.heimdall/src/enrollment.ts, plugins/quirky.heimdall/src/control-plane.ts

## Scope & non-goals

- Other machines and remote runtimes.
- Agents without a permission hook (anything beyond Claude, Codex, omp and pi).
- Scheduled or recurring hand-offs.
- Folders that aren't git worktrees.
- Worktrees with a live Heimdall watcher.
- Budgets or spend caps.
- Marking the avatar's work in commits or PRs.

## Deferred Ideas

- Budgets or spend caps per mandate.
- Commit trailers or PR notes marking the avatar's work.
- Scheduled and recurring hand-offs.
- Supervising worktrees on other machines or remote runtimes.
- Push notifications to the phone when it isn't connected.
- Letting the avatar and a Heimdall watcher share a worktree.
- Agents without a permission hook, for example by answering their prompts through the terminal.
- [tech-spec] How the gate check proves a worker's hook reaches the gate, and how hooks reach agents started before the plugin.
- [tech-spec] The blocking permission channel and the keep-awake capability the host needs.
- [tech-spec] Routing later events for a shared goal straight to the right worker, and treating the brain's context as a cache over the journal.
- [tech-spec] How the brain's context size is measured for each agent, and how each worktree's brief is kept short.
- [tech-spec] Journal and outbox storage, and idempotency keys for pushes, PRs and merges.
- [tech-spec] Testing: deterministic rule tests, record and replay with a fake model, scripted fake agents, red-team repo text, and Shadow comparison with your own decisions.
- [tech-spec] Splitting the build into parts that can ship separately: the gate and hooks, the brain and journal, the UI, and the host additions.
- [tech-spec] A per-agent conformance test at hand-off on the pinned agent version: a normal call, a sub-agent call, an MCP call, a web call, print or exec mode, and an auto-approved call.
- [tech-spec] Where hooks are installed so a repo's own settings can't switch them off, without managed settings, which would change every Claude and Codex session on the machine, not just Quirky's.
- [tech-spec] Comparing each worker's session record with the gate's receipts, and watching the files that control each agent's hooks and permissions.
- An OS sandbox under each worker as a second layer that doesn't depend on the agent's hooks.

## Glossary

| Term | Definition |
|---|---|
| Mandate | One worktree's goal, done when, guidelines, level and switches. |
| Done when | The check that says the goal is met. The avatar runs it itself. |
| House rules | Standing guidelines from Settings that apply to every mandate. |
| Level | Shadow, Local, Own branch or Full, which sets how far the avatar may act. |
| Floor | What's held for you at every level: the fixed core plus the switches still off. |
| Switch | A floor item (messaging people, history rewrites, deploys) that Settings or a hand-off can turn on. |
| Gate | The code that decides permission requests by the floor, level and fixed rules. |
| Brain | The one agent session that judges what the rules don't settle. |
| Gate check | The test at hand-off that a worker's permission requests reach the gate. |
| Guess | A reversible choice made where the mandate is silent. It blocks push and merge until you confirm. |
| Held | Waiting for you in the needs-you queue. |
| Park | Stop trying after the second failed restart and hand the worktree to the needs-you queue. |
| Outbox | Where pushes, PRs and merges are recorded before they run. |
| Needs-you queue | Everything only you can settle, shown at the top of the report. |
