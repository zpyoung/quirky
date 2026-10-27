# m1-agent-status-scripting decisions

## D1: The item covers the roadmap's five bullets for scripts; the dot, the Activity view and `quirky terminal` stay as they are
- **Question:** which flows this item owns (brainstorming, scope check)
- **Options:** the five roadmap bullets only; also feed screen rules into the dot; also retrofit names into every command that takes a session
- **Chose:** explain, detection rules as data, a guarded send, the two waits and session names. The status dot keeps its hook, title and OSC 7501 sources (m1-agent-status). `quirky terminal read/send/write` keep taking session IDs only.
- **Why:** the roadmap's "Agent status for scripts" bullets name exactly these. The doc flows 1 to 5 belong to m1-agent-status, which landed them. LOOP.md says a slice item names the doc's other flows as non-goals.
- **Evidence:** docs/roadmap.md M1 "Agent status for scripts"; agent-status.md "What the user can do"; docs/loop/decisions/m1-agent-status.md D1
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D2: Screen rules decide what scripts see, never the dot (approach A)
- **Question:** where the new screen detection rules apply (brainstorming, approaches)
- **Options:** (A) rules feed only send, the waits and explain, as Orca's agent-state-rules feed `terminal wait` and composer readiness; (B) rules also drive the status row as a fallback for every agent session, as herdr does when no integration reports; (C) A plus rewriting the coded title classifier as rule data
- **Chose:** A
- **Why:** hooks already drive the dot, and the doc keeps Orca's rules off it ("not by the sidebar dot"). B needs the screen of every agent session re-read after each output burst; research found scraping cost per pane per tick and no tool that documents a debounce, and screen rules break silently with each agent UI change, so a wrong rule would show on every dot. C would rewrite m1-agent-status's ported title classifier (D21 there) for no script-visible gain; Orca's own rule files keep code predicates beside the data for the same reason.
- **Evidence:** agent-status.md "Other status producers" (agent state rules); research: herdr docs agents.mdx, stablyai/orca PR #33485, #24387, omnigent #2702; docs/loop/decisions/m1-agent-status.md D21, D23
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** hookless agents (aider, goose and the other sixteen with no installer) need a live dot, or m7-parity-sweep asks for one
- **Source:** supersedes m1-agent-status D23 (the rules engine is now built, for scripts)

## D3: Scripts see four states: working, blocked, idle and unknown, plus exited
- **Question:** the state vocabulary for send and wait (brainstorming, gray area "output format")
- **Options:** the row's four states; the eleven display states; herdr's three (idle, working, blocked) plus unknown and exited
- **Chose:** `working`; `blocked` (a human must act: the row is waiting or blocked, or a screen rule found an approval or question); `idle` (the turn is over, whatever its outcome: done, failed or interrupted); `unknown` (no evidence anyone trusts); `exited` (the session's process ended). Blocked carries a kind, `approval` or `question`.
- **Why:** a script decides one thing: may it type, must it wait, or must a person act. herdr's three states answer that and its waits use them. The display states mix freshness and outcome into the state, which a script would have to re-group. `unknown` keeps a stale or restored row from reading as idle (Orca issue #14561, a false idle).
- **Evidence:** research: herdr CLI reference (`agent wait --until`), herdr SKILL.md; stablyai/orca issue #14561; plugins/quirky.agent-status/src/model.ts:146 (displayOf)
- **Reversibility:** hard
- **Confidence:** medium
- **Source:** assumed — autonomous

## D4: A fresh hook row decides working and idle; the screen may only add blocked, and decides alone without one
- **Question:** precedence between the row and the screen rules (brainstorming, gray area "error-recovery")
- **Options:** hooks always win; the screen always wins; hooks win for working and idle, a screen blocked match wins over anything, and with no fresh hook row the screen decides, then a title or OSC 7501 row
- **Chose:** the third. A hook row is fresh while its last hook is within 30 minutes and it isn't restored unconfirmed.
- **Why:** hooks are the authority the doc names, but several agents' hooks can't report an approval (Cursor has no approval hook; Gemini, Kiro and DSH approvals read as working), and typing into an approval prompt is the one mistake send must never make. Research: "bias the screen check toward blocked" (Orca PR #33485).
- **Evidence:** agent-status.md "Exact hook-to-state mapping" (gemini, kiro, dsh, cursor); research: Orca codex.json `profile.hooks: "turn-end"`, PR #33485; plugins/quirky.agent-status/src/fallbacks.ts:23 (hasFreshHooks)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a screen rule's false blocked stops sends that should go through
- **Source:** assumed — autonomous

## D5: One JSON rule file per agent, first match wins, title or screen regions, regex and contains matchers
- **Question:** the rule file format (brainstorming, gray area "input-format")
- **Options:** herdr's TOML with numeric priorities; Orca's JSON with anchors, strengths and code predicates; a small JSON format with ordered rules
- **Chose:** `<agent>.json` holding `agent` and an ordered `rules` list. A rule has an `id`, a `why`, a `state` (`working`, `blocked` or `idle`), a `kind` for blocked (`approval` or `question`), a `region` (`title` or `screen`), an optional `lastLines` (the bottom N non-blank screen lines), `all` and `none` lists of matchers (`{regex, ignoreCase?}` or `{contains}`, contains ignoring case) and an optional `quietMs` (the screen must not have changed for that long). The first rule whose matchers hold wins; no match gives no verdict.
- **Why:** JSON needs no new parser and matches every other Quirky data file. One file per agent with no merging makes file order an explicit ranking, so priorities add nothing; research found order bugs come from merging catalogs. `quietMs` is Orca's `requiresQuiet`, the guard against a false idle while a spinner still animates. Code predicates are left out because a user couldn't override them.
- **Evidence:** research: herdr agents.mdx; Orca agent-state-rules-schema.ts, codex.json, cursor.json; neopi #249 (catalog order); alacritree #305 (herdr priorities)
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** a built-in agent's ready or approval screen can't be told apart without a predicate
- **Source:** assumed — autonomous

## D6: A user file replaces the whole rule set; then a plugin's contribution; then the built-in file
- **Question:** where rules come from and how an override applies (brainstorming, gray area "conflict-resolution")
- **Options:** merge rule lists by id; replace the whole file per agent
- **Chose:** for each agent the first valid source wins whole: `$QUIRKY_HOME/agent-rules/<agent>.json`, then an `agent-rules` manifest contribution whose name is the agent id (from any enabled plugin, the kernel's override rules choosing among plugins), then `rules/<agent>.json` shipped with `quirky.agent-status`. An invalid user file is ignored with a warning that `rules list` and explain show, and the next source is used. A changed file is read again on next use; no restart, no reload command.
- **Why:** herdr's model (local override always wins, invalid override ignored with a warning). Replacing whole files keeps ordering readable; a merge would reorder rules the author ranked. Reading on change is how "override locally without a new release" works; Orca's memoized classifier that ignored reloads is the bug to avoid.
- **Evidence:** research: herdr agents.mdx; Orca PR #24387 (memo bug); packages/daemon/src/plugins/kinds.ts:197 (other kinds are free-form); packages/protocol/src/plugins.ts:33 (ContributionInfo)
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D7: Rules are never downloaded
- **Question:** live rule updates (brainstorming, scope)
- **Options:** Orca's and herdr's server updates; local files only
- **Chose:** local files only. Nothing in the plugin opens a network connection for rules.
- **Why:** the roadmap says so. herdr drew complaints for undocumented fetches (herdr #677).
- **Evidence:** docs/roadmap.md M1 "Agent status for scripts"; agent-status.md "Other status producers" (downloaded rules); research: herdr #677
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D8: Unsafe patterns reject the file they are in
- **Question:** validating user regexes (brainstorming, gray area "error-recovery")
- **Options:** trust them; cap length only; reject backreferences, lookbehind and repeated variable groups at load, as Orca does
- **Chose:** a pattern that doesn't compile, is over 512 characters, uses a backreference or lookbehind, or repeats a group that can match in more than one way makes its file invalid, with the reason. The same check applies to `wait --output` patterns, which fail with `invalid-params`.
- **Why:** the daemon's regex engine has no timeout, and a rule runs on every poll. Research: caps alone don't stop `(a+)+$`; Orca rejects these shapes at load.
- **Evidence:** research: Orca agent-state-rule-pattern-safety.ts; TechDebtMCP PR #48; regular-expressions.info ReDoS
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D9: Built-in rules ship for the agents whose screens Orca's published rules describe
- **Question:** which agents get built-in rule files (brainstorming, scope)
- **Options:** every one of the 45 agents; only those with known anchors
- **Chose:** claude, codex, cursor, gemini, opencode, opencode2, pi, omp, prime-agent, cline, antigravity and hermes, written from the screens and titles Orca's published rule files describe, simplified where Orca uses a code predicate. Cursor's approval menu and Codex's plan menu are the blocked rules that matter most: their hooks can't report them.
- **Why:** a rule nobody has seen a screen for would be a guess that fails silently. The rest of the agents work through hooks and can gain rules from a user file or plugin.
- **Evidence:** research: github.com/stablyai/orca/tree/main/src/main/runtime/agent-state-rules (claude, codex, cursor, gemini, opencode, opencode2, pi, omp, prime-agent, cline, antigravity, hermes); agent-status.md "Exact hook-to-state mapping" (cursor)
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** an agent's UI changes and its rule stops matching (the fixture tests show which)
- **Source:** assumed — autonomous

## D10: Rows record the evidence that decided them, and explain reads it
- **Question:** what explain can say (brainstorming, gray area "output-format")
- **Options:** recompute a reason at explain time from the row; record the deciding evidence on the row as it changes
- **Chose:** each row carries `because`: the source (hook, replay, title, program-status, inference), the rule (the hook's event and what it mapped to, the title text and its reading, the OSC 7501 state and kind, the inferred key), and its time. Explain adds what it computes now: the fold over children, freshness decay, the screen rule that matches, and which of them decided the script state under D4.
- **Why:** a row only holds its result; the event that produced it is gone once applied. herdr logs the matched rule with each transition for the same reason.
- **Evidence:** plugins/quirky.agent-status/src/types.ts:35 (AgentRow has `source` but no rule); research: herdr `agent explain`
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D11: Explain answers for any session, with or without a row
- **Question:** explain's edge cases (brainstorming, gray area "error-recovery")
- **Options:** fail without a row; explain the absence
- **Chose:** a session with no row gets an explanation that says no hook, title or OSC 7501 report has arrived, names the rule file that applies (or none) and what it reads now. An exited session says so. An unknown session is `not-found`.
- **Why:** "why does this say idle?" is asked most when nothing reports.
- **Evidence:** docs/roadmap.md M1 "An explain command that names the source and rule behind a session's current state"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D12: Send refuses only a blocked agent; a working agent gets the prompt
- **Question:** what send does in each state (brainstorming, gray area "error-recovery")
- **Options:** refuse unless idle; refuse blocked only
- **Chose:** blocked is refused with reason `agent-blocked` and nothing is typed. Working, idle and unknown are typed into. Sending to a shell session with no agent and no row is refused with `not-an-agent`; to an exited session with `session-exited`.
- **Why:** herdr's prompt guard refuses only blocked. Agents queue input typed mid-turn, and a third refusal would make every loop wait first. The roadmap names exactly two errors. "Idle isn't permission to type" is honoured by checking the screen even when the row says idle (D4).
- **Evidence:** docs/roadmap.md M1 "Sending a prompt to an agent never types into one waiting for approval"; research: herdr SKILL.md (`agent_blocked`)
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** an agent drops input typed while it works
- **Source:** assumed — autonomous

## D13: Send waits up to 5 seconds for the agent to start, then fails with `prompt-stalled`
- **Question:** the start check (brainstorming, gray area "progress-reporting")
- **Options:** fire and forget; wait for working; wait for working or blocked
- **Chose:** after submitting, send waits up to 5 seconds (a `startTimeoutMs` param changes it) for the script state to be working or blocked on evidence newer than the submission, or for an agent that was already working to stay working. Otherwise it fails with reason `prompt-stalled` and a message that says the text was typed and may still be picked up.
- **Why:** herdr's 5 second window and its stalled error. A blocked start counts because the agent took the prompt and then asked something. Saying the text was typed stops a script from resending blindly.
- **Evidence:** research: herdr SKILL.md (`agent_prompt_stalled`, 5 s); docs/roadmap.md "when it hasn't started working within a few seconds"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D14: Send types through the agent's own paste and submit settings
- **Question:** how text reaches the agent (brainstorming, gray area "data-mapping")
- **Options:** text then Enter in one write; `quirky terminal send`'s fixed 300 ms; the agent entry's delivery settings that first-prompt delivery uses
- **Chose:** a bracketed paste, then Enter as a separate write after the agent entry's submit delay, with its Enter retry. Line breaks inside the text stay inside the one prompt.
- **Why:** research: text and Enter in one burst leaves long prompts unsubmitted in Claude Code and Codex; m1-providers already tuned the delay per agent.
- **Evidence:** research: groundnuty/macf #1442, Ark0N/Codeman #627/#628; plugins/quirky.agents/src/delivery.ts:48; plugins/quirky.agents/src/core/paste.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D15: Sends to one session run one at a time
- **Question:** two sends at once (brainstorming, gray area "error-recovery")
- **Options:** interleave; queue per session
- **Chose:** a second send to the same session waits for the first to settle, then checks the state afresh.
- **Why:** two pastes interleaved would merge into one prompt, and the second send's check must see the first's effect.
- **Evidence:** plugins/quirky.agent-status/src/service.ts:183 (per-session queue already used for events)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D16: `wait` waits for script states, defaulting to idle or blocked, and returns at once when already there
- **Question:** the state wait's contract (brainstorming, gray area "flag-design")
- **Options:** a single target state; a set with a default
- **Chose:** `--until` takes one or more of working, blocked, idle, unknown and exited; the default is idle and blocked ("stopped needing the agent"). A state already reached returns at once. A session that exits while `exited` isn't wanted fails with `session-exited`.
- **Why:** herdr's `agent wait` defaults to its rest and blocked states; Playwright's waitFor returns at once when the condition holds. Send's start check (D13) is what makes "send, then wait for idle" safe from the previous turn's idle.
- **Evidence:** research: herdr CLI reference; Playwright Locator.waitFor
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D17: `wait --output` matches a pattern line by line in the rendered text, existing text included
- **Question:** what the output wait reads (brainstorming, gray area "input-format")
- **Options:** the raw byte stream stripped of escapes; the rendered screen and recent scrollback
- **Chose:** the rendered visible screen plus the last 200 scrollback lines (`--lines` changes it), with a wrapped line read as one line, checked when the wait starts and again as output arrives. The pattern is a JavaScript regex with an `--ignore-case` flag. The result is the matching line and its groups.
- **Why:** TUI agents redraw by cursor movement, so the stripped byte stream is not the text a person sees; research: escape sequences split across reads and per-chunk regexes miss. herdr's `wait-output` checks existing output first and reads recent lines. Wrapped lines split a match at the seam otherwise (tmux `-J`).
- **Evidence:** research: herdr CLI reference (`pane wait-output --source --lines`); crystl.dev tmux guide; packages/protocol/src/plugins.ts:98 (`pty.read`)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** text scrolls past more than 200 lines between checks often enough to miss matches
- **Source:** assumed — autonomous

## D18: Waits long-poll like `quirky ask wait`; a timeout exits 1 with the last state
- **Question:** how long waits work over the daemon API and what a timeout looks like (brainstorming, gray area "exit-codes")
- **Options:** one long call; long-poll in chunks of at most 60 seconds with a CLI loop
- **Chose:** each method call waits at most 60 seconds and returns `pending` with the current state; the CLI loops until `--timeout-ms` (default: no limit) and then prints a `timeout` result with the last state and exits 1. A match exits 0; usage errors exit 2.
- **Why:** the pattern m2-ask-parity built, reconnecting across daemon restarts; herdr's timeout exits 1 and usage 2, which is Quirky's existing split.
- **Evidence:** plugins/quirky.ask/cli.ts:31; plugins/quirky.ask/asks.ts:8; packages/cli/src/main.ts:192; research: herdr CLI reference
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D19: Distinct failures are plugin errors with a machine-readable reason
- **Question:** how send and wait report their distinct errors (brainstorming, gray area "error-responses")
- **Options:** new error codes in the protocol; `conflict` with `data.reason`
- **Chose:** `conflict` with reason `agent-blocked`, `prompt-stalled`, `not-an-agent`, `session-exited` or `name-taken`; `not-found` for an unknown session or name; `invalid-params` for a bad pattern or state.
- **Why:** the plugin API offers three kinds and a `data.reason` the CLI prints under `--json` (`quirky.git` does this). New kernel codes would change the protocol for one plugin.
- **Evidence:** packages/protocol/src/plugins.ts:186; packages/cli/src/main.ts:161-182; plugins/quirky.git/main.ts:26
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D20: Sessions get an optional unique name, and every session parameter in this item takes a name or an ID
- **Question:** named sessions (brainstorming, gray area "naming-convention")
- **Options:** herdr's named servers; a name on each Quirky session; a selector syntax such as `name:x`
- **Chose:** a session may carry a name: 1 to 64 characters of lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit, and never starting with `s_`, so a name can't look like an ID. Names compare case-insensitively and are stored lowercase. `quirky session new --name`, `quirky session name <session> <name>` and `--clear`. Where a session is asked for (session get, close, and every command in this item) a bare name works because IDs and names can't collide.
- **Why:** the roadmap asks for names "to address them by"; herdr's names are whole servers, which Quirky's one daemon doesn't have. Refusing the `s_` prefix removes the need for a selector syntax.
- **Evidence:** docs/roadmap.md M1 "Sessions can be given unique names"; plugins/quirky.session/src/sessions.ts:477 (`s_` IDs); research: herdr CLI reference (`--session <name>`)
- **Reversibility:** hard
- **Confidence:** medium
- **Source:** assumed — autonomous

## D21: A name is unique among sessions still running; an exited session's name can be taken
- **Question:** name uniqueness and reuse (brainstorming, gray area "duplicate-handling")
- **Options:** unique forever; unique among all stored sessions; unique among running sessions, reuse taking the name from an exited holder
- **Chose:** the third. Naming a session with a name a running session holds fails with `name-taken`. If an exited session holds it, the name moves and the exited one loses it. An exited session keeps its name until then, so `explain reviewer` works after the agent quits.
- **Why:** a loop that restarts its "reviewer" each round must be able to reuse the name without cleanup, and a name must never point at two sessions.
- **Evidence:** docs/roadmap.md "Loops, automations and orchestration send prompts through this path"
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D22: Names stay out of the window and out of `quirky terminal`
- **Question:** where names show (brainstorming, scope)
- **Options:** show the name in tab titles; CLI and API only
- **Chose:** CLI and API only: `session list` and `get` show it. Tab titles, and the `quirky terminal` commands that take session IDs, are unchanged.
- **Why:** the roadmap item is for scripts. Tab titles already have their own rename in m1-term-ui.
- **Evidence:** docs/roadmap.md M1 "Agent status for scripts"; plugins/quirky.terminal/quirky-plugin.json (renameTab)
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** users name sessions and then can't find them in the window
- **Source:** assumed — autonomous

## D23: Orca defects for this slice: downloaded rules, and a nested helper's hooks
- **Question:** which of the doc's Orca defects this item must prove absent (LOOP.md step 4)
- **Options:** every defect in the doc; the ones this slice's flows could show
- **Chose:** two tests. Rules never come from the network (Orca updates rules from a server). A nested helper process's hooks can't make send report started or change explain's "because" (the doc's "Helper processes can overwrite a row"). The doc's other defects (the dashboard's raw payload and "0 total") belong to views this item doesn't touch and m1-agent-status covered the payload.
- **Why:** LOOP.md asks for a test per recorded defect the item's flows touch.
- **Evidence:** agent-status.md "Verified in the app" (helper processes, dashboard), "Other status producers" (downloaded rules); docs/loop/decisions/m1-agent-status.md D11, D28, D31
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D24: Gray areas and fast-track
- **Question:** which gray areas to resolve and how (brainstorming steps 0 to 6)
- **Options:** the standard CLI and Integration catalog areas; adhd additions
- **Chose:** the standard set without adhd (LOOP.md), all areas that matter: output-format (D3, D10), flag-design (D16, D20), progress-reporting (D13), error-recovery (D4, D11, D12, D15), exit-codes (D18), input-format (D5, D17), conflict-resolution (D6), data-mapping (D14), duplicate-handling (D21). The Essential six are covered by the roadmap text, the feature docs and the code; the rest was fast-tracked to the recommended options above. No visual companion: nothing in this item is visual.
- **Why:** LOOP.md "Answering a skill's questions"
- **Evidence:** docs/loop/LOOP.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D25: No UI scenarios and no native scenarios
- **Question:** whether step 6's UI pass and native hand-off apply
- **Options:** add a window surface for names or explain; none
- **Chose:** none. Every flow is CLI or daemon API, so the UI pass and `docs/loop/native/` are skipped.
- **Why:** D22; the roadmap bullets are all script-facing.
- **Evidence:** docs/loop/LOOP.md step 6
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D26: The tech spec's reviewer step is folded into the one adversarial review of both specs
- **Question:** the tech-spec rubric's default reviewer dispatch (writing-specs, tech-spec.md "After authoring")
- **Options:** run the tech-spec reviewer and the adversarial review; run only the adversarial review LOOP.md asks for
- **Chose:** only the adversarial review, over both specs together, with Codex, whose criteria include the rubric's checks (pointer precision, back-links, no pasted code, contract completeness)
- **Why:** LOOP.md step 4 replaces the user's spec review with one pass; m1-agent-status D42 did the same
- **Evidence:** docs/loop/LOOP.md step 4; docs/loop/decisions/m1-agent-status.md D42
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D27: Spec review: accept eleven findings, reject the pre-pass's heading and reference findings
- **Question:** how to rule on the Codex review of both specs (adversarial-review, deep, gpt-6.1-sol, independence full; verdict NEEDS_FIXES, 20 blocking, 5 suppressed)
- **Options:** accept all; accept the reproduced and reasoned ones and reject the pre-pass false positives
- **Chose:** accept F1 (a retried Enter can land on an approval), F2 (an earlier working rule hides an approval rule), F3 (`a+a+a+a+$` passes the shape check and stalls), F4 (a turn that ends inside the retry delay reads as stalled), F7 (no wakeup when freshness alone changes the state), F8 (SC-4 (c) needed Claude Esc inference on a hookless row, which locked behavior forbids), F9 (SC-7 (c) screen still matched `busy`), F10 (send printed working when it reached blocked), F11 (output timeout had no state to print), F12 (wait couldn't name its rule), F15 (output waits had no exit rule). Reject F17 (the pre-pass wants a "Purpose" or "Overview" heading; the writing rules forbid "Overview" and Conceptual model states the purpose) and F18 to F25 (method IDs, CLI prose and planned files flagged as unresolved paths).
- **Why:** each accepted finding carried a reproduction or a quote that shows the defect; the rejected ones are the same pre-pass false positives m1-agent-status D43 rejected
- **Evidence:** scratchpad sr1/gate.json; docs/loop/decisions/m1-agent-status.md D43; plugins/quirky.agents/quirky-plugin.json:1936 (`submitRetryMs: 1200`); plugins/quirky.agent-status/src/inference.ts:32-41
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D28: Blocked rules are tried before working and idle rules
- **Question:** F2: with first-match-wins, an earlier working rule could hide an approval
- **Options:** reject files that order a working rule before a blocked one; try blocked rules first; evaluate all rules and prefer blocked
- **Chose:** try the file's blocked rules first in file order, then the rest in file order
- **Why:** the precedence table promises that any matching blocked rule wins; validating order would reject reasonable files, and trying blocked first keeps file order meaningful within each group
- **Evidence:** logic.md "The script state" table; scratchpad sr1 F2
- **Reversibility:** easy
- **Confidence:** high
- **Source:** supersedes m1-agent-status-scripting D5 (ordering only)

## D29: Patterns run in a worker with a 250 ms budget per evaluation
- **Question:** F3: the shape checks don't stop polynomial backtracking like `a+a+a+a+$`, and the daemon has no regex timeout
- **Options:** a linear-time regex engine (a new dependency); stricter static checks (still incomplete); run matching off the event loop with a time budget
- **Chose:** one long-lived Bun Worker runs every rule evaluation and wait-pattern match with a 250 ms budget; on overrun it is terminated and respawned, a rule source is ignored with a reason until its file changes, and a wait pattern fails as too slow. The shape checks stay as a first filter.
- **Why:** research found caps and shape checks insufficient and recommends a linear engine or a timeout; a worker gives the timeout with no new dependency
- **Evidence:** scratchpad sr1 F3 reproduction; research: regular-expressions.info ReDoS, TechDebtMCP PR #48
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** worker start-up or message cost shows in send or wait latency
- **Source:** supersedes m1-agent-status-scripting D8 (adds the time limit)

## D30: Send writes each Enter itself and re-checks for an approval before every one
- **Question:** F1: `quirky.agents/deliver` retries Enter after `submitRetryMs` with no state check
- **Options:** let deliver re-check through a callback (no callbacks across plugin RPC); drop Enter retries; have send paste through deliver with `submit: false` and write Enter itself after a fresh check, using a new `quirky.agents/submitPlan` for the agent's timing
- **Chose:** the third; for agents whose entry sends Enter with the paste, the single write follows the first check
- **Why:** the only way to guarantee no Enter reaches an approval prompt is to check right before each write; the per-agent timing stays owned by quirky.agents
- **Evidence:** scratchpad sr1 F1 reproduction; plugins/quirky.agents/src/delivery.ts:125-158
- **Reversibility:** easy
- **Confidence:** high
- **Source:** supersedes m1-agent-status-scripting D14 (who writes Enter)

## D31: The start check watches row commits from the first Enter
- **Question:** F4: polling only after delivery settles misses a turn that starts and ends inside the retry delay
- **Options:** poll after delivery; observe commits and the screen from the first Enter, counting a turn that already ended
- **Chose:** the observer starts at the first Enter and counts a committed row with evidence after it in working, waiting or blocked, a row whose turn started after it, or a screen verdict of working or blocked; send then reports the state at that moment, which may be idle
- **Why:** the prompt was taken in that case, and reporting `prompt-stalled` would make a script resend it
- **Evidence:** scratchpad sr1 F4 reproduction; plugins/quirky.agent-status/src/types.ts (`turnStartedAt`)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** supersedes m1-agent-status-scripting D13 (when the window starts)

## D32: The matcher runs in a killable child process, not a Bun Worker
- **Question:** how to enforce D29's time budget (subagent-driven development, wave 1, task T3)
- **Options:** a Bun `Worker` terminated on overrun; a child process killed on overrun
- **Chose:** a child process started like the PTY host (`Bun.spawn` with IPC), killed with SIGKILL and respawned on overrun
- **Why:** the T3 implementer measured that `worker.terminate()` returns but the regex thread keeps spinning and the process never exits; a child process dies in about 1 ms. A daemon killed with SIGKILL mid-match can leave the child spinning until its regex ends.
- **Evidence:** packages/daemon/src/pty-client.ts:413 (same spawn shape); T3 report in the run journal
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the orphan case shows up in practice
- **Source:** supersedes m1-agent-status-scripting D29 (mechanism only)

## D33: Build pairing and waves
- **Question:** subagent-driven development preflight: implementer/reviewer pairing and wave plan
- **Options:** claude-task + codex (recommended), other cross-family pairs; any decomposition
- **Chose:** Claude Sonnet subagents implement, Codex (`pi-watch`, verified reachable) reviews, Gemini tiebreaks. Wave 1: PTY unwrap (T1), session names (T2), rule engine (T3), `because` (T5), agents delivery and fake outbox (T6). Wave 2: built-in rules (T4) beside the chain script state and explain (T7), send (T8), waits (T9). Wave 3: end-to-end scenario tests by area. Checkpoint reviews after waves 1 and 2, then Final Round 1.
- **Why:** LOOP.md's pairing for a Claude Code lane; the waves follow the real dependencies (the engine and the rows before the state, the state before send and the waits) and keep scopes disjoint within a wave
- **Evidence:** docs/loop/LOOP.md step 5
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D34: A done row never goes stale for scripts
- **Question:** the script state of a done row older than 30 minutes (build, wave 2, raised by the T7 implementer)
- **Options:** apply the 30 minute limit to every row (a long-finished agent reads unknown); exempt done rows, as the dot does
- **Chose:** a done row is always fresh, so it reads idle however old it is; restored unconfirmed rows are only ever non-done (hydrate keeps done rows as they were)
- **Why:** with the limit, `wait --until idle` on an agent that finished an hour ago would never return; m1-agent-status D16 never decays a done row
- **Evidence:** docs/loop/decisions/m1-agent-status.md D16; plugins/quirky.agent-status/src/model.ts:146 (displayOf decays only live rows)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** supersedes m1-agent-status-scripting D4 (freshness of done rows)

## D35: Wave 2 splits: T7 lands first, then the send and wait chain runs beside the checkpoint fixes
- **Question:** how to run the wave-1 checkpoint fixes without waiting for the whole wave 2 chain
- **Options:** fix after wave 2; merge the accepted T4 and T7 and run T8 and T9 beside four scoped fixers
- **Chose:** the second; the fixers own the PTY host's read, `src/rules/matcher.ts` and `sources.ts`, quirky.session's create, and `src/script-state.ts`, none of which T8 or T9 touch
- **Why:** scopes are disjoint, so nothing can collide at merge, and the checkpoint review of wave 2 then sees the fixed code
- **Evidence:** run journal (scopes)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D36: Wave 1 checkpoint: accept all nine findings, which collapse to four defects
- **Question:** how to rule on the Codex checkpoint review of wave 1 (three lenses, standard depth, 9 blocking, none suppressed)
- **Options:** accept; reject
- **Chose:** accept all: unwrapped reads dropped the space at a wrap point (C1, HIGH); disposing the matcher while its child starts leaves it running and answers after disposal (C2, S2, X2); a filesystem error on a rule source made `effective` reject instead of falling back (C3, S1, X1); creating a named session stripped an exited holder's name before a launch that might fail (X3). Fixed by FA, FB, FC beside T8.
- **Why:** each came with a reproduction against the code
- **Evidence:** scratchpad cp1/{C,S,X}/gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D37: Wave 2 landed; the gate passed with two unrelated files flaky under load
- **Question:** whether wave 2 (built-in rules, script state and explain, send, waits) and the four checkpoint-1 fixes are accepted
- **Options:** accept; rework
- **Chose:** accept. Every task passed its acceptance in its own tree; the merged gate passed (`bun run test` 321 files on the remote host, scripts, typecheck). `packages/pty-host/test/host.test.ts` and `plugins/quirky.ask/test/core/spec.test.ts` failed only under load and passed alone. Implementer calls kept: send writes paste and Enter itself for an agent that both sends Enter with the paste and retries it, so the retry gets its own check; send waits one poll after a start before reporting the state; `--until` with `--output` is a usage error; an empty prompt is `invalid-params`.
- **Why:** the calls follow D30 and D31's intent; the flaky files are outside this item and recovered on their own
- **Evidence:** run journal; scratchpad gate-w2.log
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D38: Catching up with build/roadmap brought m1-notifications, m2-source-control-core and m3-terminal-dock; no decision conflicts
- **Question:** LOOP.md step 5's catch-up merge and its decision logs
- **Options:** merge before the final review; merge later
- **Chose:** merged before wave 3 so the end-to-end tests run on the combined code. Ten files conflicted and keep both sides: the session record has both `unread` (theirs, store migration 6) and `name` (ours, now migration 7); agent-status keeps notifications' settled events and the OSC fold fix beside `because` and the scripting wiring. Read m1-notifications D1-D62 and m2-source-control-core D1-D56: notifications moved announcing to `quirky.notifications` fed by agent-status events (no effect on scripts); m2 D38 puts an error's `data` in the CLI's JSON error, which carries this item's reasons.
- **Why:** LOOP.md step 5
- **Evidence:** merge eeb6ed4; docs/loop/decisions/m1-notifications.md D5, D6, D31; docs/loop/decisions/m2-source-control-core.md D38
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D39: Wave 2 checkpoint: accept all seven findings, which collapse to five defects
- **Question:** how to rule on the Codex checkpoint review of wave 2 (three lenses, standard; 7 blocking, 1 suppressed)
- **Options:** accept; reject
- **Chose:** accept all: inspection judged with the row read before the screen sample, so an approval committed meanwhile could pass send's check (C1, S1, X1, HIGH); for Enter-with-paste delivery the start observer began after deliver returned (S2); explain's because line printed the newest evidence's age instead of the deciding event's (S3); a wait could overrun its timeout by a rule's quiet time (X2); a failed launch's rollback overwrote a concurrent rename (C3). Fixed by G1 and G2 while wave 3 writes the end-to-end tests.
- **Why:** each came with a reproduction
- **Evidence:** scratchpad cp2/{C,S,X}/gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D40: Wave 3 landed: end-to-end tests for every scenario; SC-7 stays a unit-level scenario
- **Question:** whether each acceptance criterion has a test that drives Quirky through the CLI or the daemon API (LOOP.md step 6)
- **Options:** add an end-to-end test for SC-7; keep SC-7 in unit tests
- **Chose:** SC-1 to SC-41 each have a named test in `plugins/quirky.agent-status/test/e2e/{explain,send,waits,names}.e2e.test.ts` except SC-7, the rule-evaluation semantics, which `test/rules-match.test.ts` covers case by case and SC-9 and SC-10 exercise end to end through user rule files. The end-to-end tests found no product bugs.
- **Why:** SC-7 is a property of the evaluator, and every path it feeds is already driven through the daemon
- **Evidence:** test/rules-match.test.ts; test/e2e/explain.e2e.test.ts (SC-9, SC-10)
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D41: Final Round 1: accept twelve findings that collapse to six defects; dismiss one
- **Question:** how to rule on Final Round 1 (Codex, deep, three lenses over the item's non-test source on top of build/roadmap; 10 blocking, 1 advisory, 1 suppressed, nothing contested)
- **Options:** accept; reject
- **Chose:** accept: an approval that appears while send looks up the submit plan, or during deliver's liveness check, gets the paste and an Enter (C1, S2, X1, HIGH); inspect refreshed the row but not the session after sampling (C2); a timeout from an older rule-file version could blacklist a corrected one (C3); text `rules show` omitted the matchers (S4); output waits queued behind slow matcher requests overran their deadline (X2); the pre-pass suite failed on `packages/pty-host/test/host.test.ts` "reports alt", a race in the test (it stops reading when the alt flag flips, before its second printf lands; 6 of 6 local runs pass) (C4, S5, X3). Dismiss S3 (LOW): `session list` hides the NAME column when nothing is named so v1's table stays as it was, which the v1 exit test requires.
- **Why:** each accepted finding came with a reproduction; S3 describes the chosen behavior
- **Evidence:** scratchpad fr1/{C,S,X}/gate.json; packages/cli/test/v1-words.e2e.test.ts:82
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D42: Send writes the paste and Enter itself, right after its check
- **Question:** closing D41's HIGH: deliver's own awaits sit between send's check and the write
- **Options:** keep using `quirky.agents/deliver` with another check before it; write the bytes directly
- **Chose:** send takes the submit plan first, then its fresh check, then writes the bracketed paste (and the Enter for agents that take it with the paste) with `context.pty.write` with no await in between; `quirky.agents/deliver`'s `ready` option stays for other callers
- **Why:** any await between the check and the write is a window for an approval to appear; the paste bytes are a fixed encoding
- **Evidence:** scratchpad fr1 C1/X1 reproductions
- **Reversibility:** easy
- **Confidence:** high
- **Source:** supersedes m1-agent-status-scripting D30 (who writes the paste)

## D43: The final fix batch closed every Final Round 1 finding; nothing goes to BLOCKERS.md
- **Question:** LOOP.md step 5: which Final Round 1 findings stay open after the one fix batch
- **Options:** run closure rounds; confirm closure by tests and the gate
- **Chose:** each accepted finding has a test that fails without its fix (the implementer reverted the send, inspect and timeout-version fixes to check; the matcher-deadline and `rules show` tests assert the new behavior directly), and the gate after the batch passed: `bun run test` 0 failures and no flaky files, `bun test scripts`, `bun run typecheck`. No finding is left open, so BLOCKERS.md gets no entry. Known residual, recorded in D32: a daemon killed with SIGKILL mid-match can leave the matcher child spinning until its regex ends.
- **Why:** LOOP.md replaces Final Rounds 2-5 with this check
- **Evidence:** scratchpad gate-f1.log (head 2d20a80)
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by docs/loop/LOOP.md

## Progress
Step 7 (land). Build, Final Round 1, its fix batch and the final gate are done (head 2d20a80 plus this note). No UI or native scenarios (D25). If this iteration stopped before landing: run `bun install`, the gate (`bun run test && bun test scripts && bun run typecheck`), commit, `git switch --detach`, check `pgrep -fl "queue.ts land"` is empty, then `bun scripts/build-loop/queue.ts land m1-agent-status-scripting`.
