# m1-agent-status-scripting tech spec

**Status:** Draft for build. **Logic spec:** [logic.md](logic.md). **Decisions:** [m1-agent-status-scripting.md](../../../loop/decisions/m1-agent-status-scripting.md).

All paths are relative to the repo root. The tier gate fired on three criteria: the work crosses
the PTY host, kernel and plugin boundaries, touches far more than three files, and the logic spec's
Status records "Tech spec: requested". Orca's published rule files, the evidence for the built-in
rules, are copied for reading at
`/private/tmp/claude-502/-Users-zpyoung-orca-workspaces-quirky-build-roadmap/c54ccfdf-1198-49a4-b114-51da9b0707a2/scratchpad/orca-rules/`
and live upstream at `https://github.com/stablyai/orca/tree/main/src/main/runtime/agent-state-rules`.
Port facts about each agent's screen, never Orca's engine.

## Architecture

Four layers change ([Data flow](logic.md#data-flow)):

1. **Protocol** (`packages/protocol/src`): `PluginPty.read` and the PTY `read` request take an
   `unwrap` option; `Session` gains `name`.
2. **PTY host** (`packages/pty-host/src`): `read` joins wrapped rows into logical lines when asked.
3. **quirky.session**: the `name` column, `setName`, `create.name`, name resolution in `require`,
   the CLI `name` command and `--name` on `new`.
4. **quirky.agent-status**: `because` on rows; rule files and their sources; the screen sampler;
   the script state; explain, send, the two waits, `rules list|show`; the CLI for each. One small
   addition to **quirky.agents**: `deliver` takes `ready: true` to skip the startup ready wait.

No new runtime dependencies. No PTY protocol version bump ([m1-agent-status D34](../../../loop/decisions/m1-agent-status.md)):
an old host ignores `unwrap` and returns rows, which is the old behavior.

## Code references

### Protocol and PTY host

| File | Change |
|---|---|
| `packages/protocol/src/pty.ts:119` (`read` request) | add optional `unwrap?: boolean` |
| `packages/protocol/src/plugins.ts:98` `PluginPty.read` | `read(sessionId, lines, options?: { unwrap?: boolean })` |
| `packages/daemon/src/plugins/pty-api.ts:129-132` | forward `unwrap` in `pty.request('read', …)` only when true |
| `packages/pty-host/src/server.ts:194-195` | pass `request.unwrap === true` |
| `packages/pty-host/src/session.ts:275-289` `read`, `:922-926` `readResult` | with `unwrap`, rows whose `wrapped` flag is set are appended to the row before them, across the scrollback/screen seam; trailing-blank trimming as today |
| `packages/pty-host/src/history/reader.ts:423-445` `pageBefore`, `:482-486` `textLinesAbove` | a variant (or option) that keeps each text row's `wrapped` flag; `pageBefore`'s public `HistoryPage` stays `string[]` |
| `packages/protocol/src/model.ts:190-215` `Session` | add `name?: string \| null` after `agentStatus` |

### quirky.session

| File | Change |
|---|---|
| `plugins/quirky.session/src/records.ts:18-38` `Row`, `:49-69` `toSession` | `name: string \| null` |
| `records.ts:106-148` `sessionMigrations` | migration 6: `ALTER TABLE sessions ADD COLUMN name TEXT` (no unique index: uniqueness is among running sessions, enforced in code) |
| `records.ts:177-203` `insert`, `:209-247` `update` | carry `name` (update accepts `null` to clear) |
| `records.ts` | `byName(name): Session[]` (all records holding it, any status) |
| `plugins/quirky.session/src/sessions.ts:463-467` `require` | an argument that isn't a stored ID is looked up as a name (lowercased); a name held by several records resolves to the running one, else the most recently created; none is `not-found` `no such session: <arg>` |
| `sessions.ts:173-225` `create` | optional `name`, validated and taken before the record is inserted |
| `sessions.ts` | new `setName(params: { session, name: string \| null })` → `Session`; emits `changed` via `publish` (`:468`) |
| `sessions.ts:473-495` `newRecord` | `name: null`; `resume` (`:228-274`) does not copy the name |
| `plugins/quirky.session/quirky-plugin.json` | `setName` method; `name` param on `create`; `name` property beside `agentStatus` in the nine inline Session schemas (`list`, `get`, `create`, `resume`, `setProviderSession`, `register`, `restore`, `setStatus`, the `changed` event); `get`/`close` param descriptions say "ID or name"; cli-commands `name` (positionals `session`, `name` optional; flag `clear`) and flag `name` on `new` |
| `plugins/quirky.session/cli.ts:3-9` `recordRows`, `:54-65` `list`, `:74-101` `new` | a `name` row; a NAME column in `list` after ID; `--name` passed to `create`; new `name` handler |
| `plugins/quirky.session/test/records.test.ts:30,104-127,143` | fixtures gain `name: null` |
| `plugins/quirky.agent-status/test/fakes/quirky.session/*`, `plugins/quirky.terminal/test/fakes/quirky.session/main.ts` | `get` resolves names only where a test needs it |

### quirky.agents

| File | Change |
|---|---|
| `plugins/quirky.agents/src/delivery.ts:48` `deliver` | an `options.ready` flag: skip subscribing and the ready scanner; check liveness, then `writePaste('pasted')` and the entry's submit path (`submitDelayMs`, `submitRetryMs`, `enterWithPaste`) exactly as today |
| `plugins/quirky.agents/src/service.ts:300-304` | pass `params.ready === true` |
| `plugins/quirky.agents/src/service.ts` | new read-only `submitPlan({ agent, text }) → { enterWithPaste: boolean, delayMs: number, retryMs: number \| null }` from the entry: `enterWithPaste`, `submitDelayMs(text, entry)` (`src/core/paste.ts:22`), `submitRetryMs`; unknown agent → `not-found` |
| `plugins/quirky.agents/quirky-plugin.json` (`deliver`, new `submitPlan`) | `ready` boolean param on deliver, described "the agent already shows its input; paste without waiting for a ready signal"; the deliver description states the paste encoding (line breaks become CR, ESC becomes `␛`, wrapped in `ESC[200~`…`ESC[201~`); the `submitPlan` method with its schema |

### quirky.agent-status

| File | Change |
|---|---|
| `src/types.ts:35` `AgentRow` | `because?: Because` (see [Data models](#data-models)) |
| `src/apply.ts` `applyEvent`, `recordEvidence` | stamp `because` `{source: 'hook'\|'replay', event: n.eventName, rule, at}` whenever the event changes the row |
| `src/fallbacks.ts` `titleEvidence`, `programEvidence` | stamp `because` for title rows (the title text, capped at 120, and its reading) and OSC 7501 rows (state and kind) |
| `src/inference.ts:55` `interrupted`, `:76` `answered` | stamp `because` (`interrupt` with the key, `answered` with Enter) |
| `src/service.ts` | keeps the last title per session from `title` facts; owns the new pieces; serializes sends per session; wakes waiters on `commit` |
| `main.ts` | provide the new methods; read `rules/` from `context.dir`; subscribe `plugin.changed` to drop the contribution cache |
| `quirky-plugin.json` | methods `explain`, `send`, `wait`, `waitOutput`, `rules`, `ruleSet`; cli-commands `explain`, `send`, `wait`, `rules list`, `rules show` |
| `cli.ts` | printers and the long-poll loops |
| new `src/rules/format.ts` | parse and validate one rule file |
| new `src/rules/safety.ts` | `unsafePatternReason(pattern): string \| null`, used by format.ts, the CLI and `waitOutput` |
| new `src/rules/match.ts` | `evaluate(set, input) → Verdict \| null` (pure; runs inside the worker) |
| new `src/rules/matcher-worker.ts`, `src/rules/matcher.ts` | the worker entry and its client with the time budget ([Screen sampler and verdicts](#screen-sampler-and-verdicts)) |
| new `src/rules/sources.ts` | `RuleSources`: effective set per agent, with origin and ignored sources |
| new `src/screen.ts` | `ScreenSampler`: reads the screen and title, tracks output quiet per session |
| new `src/script-state.ts` | `scriptState(...)`, pure, per [Script state](#script-state) |
| new `src/explain.ts` | `explain(...)` → `Explanation` |
| new `src/send.ts`, `src/waits.ts` | the send and wait flows |
| new `rules/<agent>.json` | twelve built-in files ([D9](../../../loop/decisions/m1-agent-status-scripting.md)) |

## Contracts & interfaces

### Rule files

Back-link: [Detection rules](logic.md#detection-rules).

SCHEMA:
```
RuleFile = { agent: string, description?: string, rules: Rule[] }      // agent must equal the file's/contribution's name
Rule = {
  id: string                       // [a-z0-9][a-z0-9-]{0,63}, unique in the file
  why?: string
  state: 'working' | 'blocked' | 'idle'
  kind?: 'approval' | 'question'   // blocked only; default 'approval'
  region: 'title' | 'screen'
  lastLines?: integer 1..200       // screen only: the bottom N non-blank lines
  all?: Matcher[]                  // every matcher must hold; at least one of all/none is non-empty
  none?: Matcher[]                 // no matcher may hold
  quietMs?: integer 0..10000       // no output for at least this long
}
Matcher = { regex: string, ignoreCase?: boolean } | { contains: string }   // contains ignores case
```

- A matcher holds when it matches the region's text: the title, or the selected screen lines
  joined with `\n`. Regexes compile with the `m` flag (plus `i` when `ignoreCase`), so `^`/`$`
  are per line.
- Any unknown field, wrong type, out-of-range value, duplicate id, `kind` on a non-blocked rule,
  `lastLines` on a title rule, or unsafe pattern makes the whole file invalid with one reason
  naming the rule and field.
- `unsafePatternReason` rejects: no compile; longer than 512; a backreference (`\1`–`\9`, `\k<`);
  lookbehind (`(?<=`, `(?<!`); a group with a variable body followed by `*`, `+` or `{`. Port the
  shape of Orca's `agent-state-rule-pattern-safety.ts` (in the scratchpad copy).

### Rule sources

`RuleSources.effective(agent): { set: RuleFile, origin: Origin } | null` and
`RuleSources.list(): RuleListing[]`.

- Order per agent: `$QUIRKY_HOME/agent-rules/<agent>.json`; the effective `agent-rules`
  contribution named `<agent>` (from `plugin.contributions {kind: 'agent-rules'}`, status
  `effective`; its `data` holds `rules` and optional `description`); `<context.dir>/rules/<agent>.json`.
- Each file is re-read when its `mtimeMs` or size differs from the cached read; a deleted file
  drops out. Contributions are cached until a `plugin.changed` event.
- An invalid source is skipped and recorded as `{origin, path?, reason}` in the agent's listing;
  the next source is used. Never throws for a bad file.
- No network API is imported anywhere in `src/rules/` (SC-13's test checks the import graph and
  the absence of `fetch`).

SCHEMA:
```
Origin = { kind: 'user', path } | { kind: 'plugin', plugin, contribution } | { kind: 'built-in', path }
RuleListing = { agent, origin: Origin | null, rules: number, ignored: { origin: Origin, reason: string }[] }
```

### Screen sampler and verdicts

Back-link: [The script state](logic.md#the-script-state).

`ScreenSampler.sample(sessionId): Promise<Sample>` reads `pty.read(id, 0, { unwrap: true })` for
the visible screen, the last title (from `title` facts, else `pty.snapshot(id).title`), and the
session's output `offset` from `pty.list()`. It remembers per session the offset and the time that
offset was first seen.

SCHEMA:
```
Sample = { title: string, lines: string[], offset: number, quietForMs: number | null }   // null: not observed long enough to know
Verdict = { rule: string, state: 'working' | 'blocked' | 'idle', kind?: 'approval' | 'question', origin: Origin }
```

- `evaluate(set, sample)` tries the file's blocked rules first, in file order, then its working
  and idle rules in file order; the first whose region matchers hold and whose `quietMs` is met
  (`quietForMs !== null && quietForMs >= quietMs`) wins ([D28](../../../loop/decisions/m1-agent-status-scripting.md)).
- Matching runs in `src/rules/matcher-worker.ts`, one long-lived child process (`Bun.spawn` with
  IPC) per plugin activation, never on the daemon's event loop ([D29](../../../loop/decisions/m1-agent-status-scripting.md),
  [D32](../../../loop/decisions/m1-agent-status-scripting.md): a terminated Bun `Worker` keeps
  running a stuck regex). Each request (a rule file, or a single wait pattern, plus the text) has
  a 250 ms budget (`QUIRKY_TEST_AGENT_STATUS_TIME_SCALE` scales it). On overrun the process is
  killed and respawned; for a rule file the source is recorded as ignored with reason `a pattern ran longer
  than 250 ms` until the file changes, and the next source is used; for a wait pattern the call
  fails `invalid-params` `pattern is too slow`. A worker that can't start makes every evaluation
  return no verdict and explain says why.
- A rule that matches except for quiet is reported as `pendingQuiet: rule id` so explain can say
  so; explain, send and the waits re-sample until the quiet is known (at most the rule's
  `quietMs` plus one poll) before giving up on it.
- Samples are taken only on demand (explain, send, a running wait). No timer samples sessions
  nobody asked about ([D2](../../../loop/decisions/m1-agent-status-scripting.md)).

### Script state

PSEUDOCODE (justified, ≤3 lines): the precedence table in the logic spec, as a function of
`(session, row, verdict, now)`; written here because the "fresh hook" test is subtle:
`freshHook = row && (row.state === 'done' || (!row.restoredUnconfirmed && now - row.evidenceAt <= STALE_AFTER_MS)) && (row.source === 'hook' || row.source === 'replay')` ([D34](../../../loop/decisions/m1-agent-status-scripting.md); the same freshness test applies to title, OSC 7501 and inference rows).

CONTRACT:
```
scriptState(input: { session: Session, row: AgentRow | null, verdict: Verdict | null, now: number })
  → { state: ScriptState, kind?: 'approval' | 'question', decidedBy: 'session' | 'rule' | 'row' | 'none' }
type ScriptState = 'working' | 'blocked' | 'idle' | 'unknown' | 'exited'
```

- Row mapping: working → working; waiting or blocked → blocked (kind `question` when the row has
  a `question`, else `approval`); done → idle.
- `STALE_AFTER_MS` is `src/model.ts:21`; reuse it.

### Methods

All take `session` as an ID or a name, resolved through `quirky.session/get`. Back-links:
[Explain](logic.md#explain), [Send](logic.md#send), [Waits](logic.md#waits).

CONTRACT:
```
explain { session, at? }          → Explanation
send    { session, text, startTimeoutMs? = 5000 }
                                  → { session, state: 'working' | 'blocked' | 'idle', kind?, sentAt, startedAt }
wait    { session, until? = ['idle','blocked'], timeoutMs? = 60000 (max 60000) }
                                  → { status: 'matched' | 'pending', state, kind?, decidedBy, rule?, at }
waitOutput { session, pattern, ignoreCase?, lines? = 200 (0..2000), timeoutMs? = 60000 (max 60000) }
                                  → { status: 'matched', line, match, groups: string[], at } | { status: 'pending', at }
rules   {}                        → RuleListing[]
ruleSet { agent }                 → { agent, origin, set } | null
```

Errors (all `conflict` carry `data.reason`):

| Case | Kind | Reason |
|---|---|---|
| unknown session or name | `not-found` | — |
| send to a blocked agent; nothing written | `conflict` | `agent-blocked` |
| send typed, no start within `startTimeoutMs` | `conflict` | `prompt-stalled` |
| send to a session with `agent === 'shell'` and no row | `conflict` | `not-an-agent` |
| send to, or wait (without `exited` in `until`) on, an exited session | `conflict` | `session-exited` |
| bad `until` value, bad or unsafe `pattern` | `invalid-params` | — |

- **Send** ([D30](../../../loop/decisions/m1-agent-status-scripting.md),
  [D31](../../../loop/decisions/m1-agent-status-scripting.md)): per-session queue (one send at a
  time, after the session's event queue settles). `agent` is the row's agent when the session's
  own is `shell`. Order:
  1. Resolve; sample; script state; refuse blocked (`agent-blocked`, nothing written).
  2. Get the agent's submit plan from `quirky.agents/submitPlan {agent, text}`
     (`{ enterWithPaste, delayMs, retryMs }`); an agent quirky.agents doesn't know gets
     `{ enterWithPaste: false, delayMs: 500, retryMs: null }`.
  3. Take a fresh judgement (`inspect`); blocked → `agent-blocked`, nothing written. With no
     await between that check and the write, write the bracketed paste with `context.pty.write`
     (the bytes `encodeBracketedPaste` makes); for an agent whose plan has `enterWithPaste`, the
     `\r` goes in the same write and step 4 is skipped ([D42](../../../loop/decisions/m1-agent-status-scripting.md)).
  4. After `delayMs`: sample and re-check; blocked → `agent-blocked` with the message "pasted but
     not submitted"; else write `\r` and record `enterAt`. Start the observer now.
  5. If `retryMs` is set and the observer has seen no start by `enterAt + retryMs`: sample and
     re-check exactly as in 4, then write the retry `\r`. At most one retry.
  6. The observer, from `enterAt` until `enterAt + startTimeoutMs`, subscribes to the service's
     row commits for the session and samples the screen every 100 ms. Started is the first of: a
     committed row with `evidenceAt >= enterAt` whose state is working, waiting or blocked; a
     committed row with `turnStartedAt >= enterAt` (a turn that already ended still started); a
     screen verdict of working or blocked; or the agent was working before step 1. The result's
     `state` is the script state at the moment the observer settles (working, blocked or idle).
  - A write that throws is `session-exited`. The `agent-blocked` message names the
    detail (`Bash: rm -rf build`) or the question text, else the rule id.
- **Nested helpers** never count as a start because `decideIdentity` already drops their events
  before the row changes (`src/service.ts:230-240`); the observer reads only committed rows.
- **wait**: resolves at once when already matched. Otherwise re-evaluates on the service's
  `commit` for the session, on `quirky.session/changed` with an exited session, and every 250 ms
  (sampling the screen only when the session has a rule file), so freshness expiry is noticed.
  Returns `pending` at `timeoutMs`. `decidedBy` and `rule` come from `scriptState` and the verdict.
- **waitOutput**: samples `pty.read(id, lines, { unwrap: true })` at start and every 250 ms while
  the offset grows; matches every line of a sample in the matcher worker, returning the newest
  matching line. Regex compiled with no `g`, plus `i` for `ignoreCase`. When the session has
  exited (at start or during the wait) it reads the session's text once more after the exit and
  matches it; only if that fails is it `session-exited`.

### CLI

Back-link: [Scope and non-goals](logic.md#scope-and-non-goals).

CONFIG:
```
quirky agent-status explain <session> [--at MS] [--json]
quirky agent-status send <session> [<text>] [--file PATH|-] [--start-timeout-ms MS] [--json]
quirky agent-status wait <session> [--until S[,S…]] [--output PATTERN [--ignore-case] [--lines N]] [--timeout-ms MS] [--json]
quirky agent-status rules list [--json]
quirky agent-status rules show <agent> [--json]
quirky session new … [--name NAME]
quirky session name <session> [<name>] [--clear]
```

- `send` needs exactly one of `<text>` and `--file` (`-` reads stdin); otherwise usage (exit 2).
- `wait` loops the method like `plugins/quirky.ask/cli.ts:31` `waitForAsk` (reconnect on lost
  connection; RPC errors rethrown). With `--timeout-ms` exhausted it prints
  `{status: 'timeout', state, …}` (text: `timed out after Ns; <session> is <state>`) and exits 1
  via `ctx.fail`; with `--output` the timeout result is `{status: 'timeout', pattern}` (text:
  `timed out after Ns; no line matched <pattern>`). With `--output`, the pattern is checked with
  `unsafePatternReason` before any call; a bad one is `ctx.usage` (exit 2).
- Text output: explain prints the state line, a `because:` line, then `row:`, `fold:` (when the
  folded state differs from the lead's), `screen:` and any `warning:` lines; `--json` prints
  `Explanation`. Send prints `<session>: <state>`, with ` (<kind>)` after blocked. Rules list prints one line per agent
  (`agent  origin  path-or-contribution  N rules`) plus `  ignored <origin>: <reason>` lines.

## Data models

### Because

Back-link: [Data flow](logic.md#data-flow).

SCHEMA:
```
Because = {
  source: 'hook' | 'replay' | 'title' | 'program-status' | 'inference'
  rule: string        // e.g. 'claude PermissionRequest → waiting', 'title "✋ gemini" → permission',
                      // 'OSC 7501 blocked/permission → waiting', 'Esc settled with no hook → interrupted',
                      // 'Enter answered the question → working'
  event?: string      // the hook event name
  at: number          // evidence time
}
```

- Stamped only when the row's state, outcome or source changes, so tool pings don't move it;
  `rule` is one line capped at 200 characters. Producers copy `{...prev}`, so each producer that
  changes state, outcome or source must set `because` itself (the table of producers:
  `apply.ts:184` `applyEvent`, `fallbacks.ts:31` `titleEvidence`, `fallbacks.ts:76`
  `programEvidence`, `inference.ts:55` `interrupted`, `inference.ts:76` `answered`; `hydrate` and
  `attachFacet` keep it).
- Stored inside the existing row JSON (`src/store.ts:69-95`); no migration. A row without it
  explains with `because: null` and the text "no record (stored before explain existed)".

### Explanation

SCHEMA:
```
Explanation = {
  session: string, name: string | null, agent: string | null,
  state: ScriptState, kind?: 'approval' | 'question',
  decidedBy: 'session' | 'rule' | 'row' | 'none',
  row: null | { state, display, label, detail, source, fresh: boolean, ageMs: number,
                because: Because | null, lead: { state, since }, children: { agent: n, shell: n, cron: n } },
  screen: { origin: Origin | null, verdict: Verdict | null, pendingQuiet?: string,
            ignored: { origin: Origin, reason: string }[] },
  exit?: { code: number | null, signal: string | null },
  summary: string     // the one-line sentence the CLI prints first
}
```

### Session name

SCHEMA:
```
REGEX: ^(?!s_)[a-z0-9][a-z0-9._-]{0,63}$     // applied after lowercasing; 1..64 chars
setName { session, name: string | null } → Session
```

- `name-taken` when a running (status not `exited`) session other than this one holds it; an
  exited holder has its name set to null in the same store transaction and gets a `changed` event.
- `invalid-params` messages name the broken rule: empty, too long, bad character, must start with
  a letter or digit, can't start with `s_`.

## DO-NOT-CHANGE fences

- `plugins/quirky.agent-status/src/title.ts` and `src/title/**`: the dot's title classifier stays
  code ([D2](../../../loop/decisions/m1-agent-status-scripting.md)); rules never call it and it
  never reads rules. Built-in title rules may restate its facts.
- `src/model.ts` `displayOf`, `summaryOf`, `coarseStatus`: the dot and the session summary must
  not change; `because` is not part of `AgentStatusSummary`.
- `PTY_PROTOCOL_VERSION` (`packages/protocol/src/pty.ts:10`): a bump retires running hosts and
  kills sessions (m1-agent-status D34).
- `plugins/quirky.agents/src/delivery.ts` behavior when `ready` is absent: first-prompt delivery
  (m1-providers) depends on it.
- `quirky terminal send|write|read` semantics (D22).

## Always / Ask / Never

- **Always:** resolve sessions through `quirky.session/get`; stamp `because` in the same function
  that changes the row; run every timing through the existing `QUIRKY_TEST_AGENT_STATUS_TIME_SCALE`
  (`src/service.ts:52` `timingFrom`) for the 5 s start window, quiet times and poll intervals.
- **Ask (record a decision):** any change to the script-state precedence; any new error reason.
- **Never:** write anything to a session before the blocked check passes; open a network
  connection for rules; read or write the real `~/.quirky`, `~/.claude` or `~/.codex` in tests.

## Cross-cutting

- **Security:** user rule files and wait patterns are untrusted regexes, screened by
  `unsafePatternReason`; rule text is never executed. `rules show` prints file content as data.
- **Migration:** quirky.session migration 6 (nullable column). Agent rows need none.
- **Observability:** an ignored rule source is logged once per (path, mtime) through
  `context.log`.
- **Rollback:** reverting drops `name` (column stays, unused) and the new methods; rows keep an
  ignored `because`.
- **Platform:** `deferred: platform` for rule paths on Windows and for `pty.read` unwrap on remote
  hosts (no remote hosts exist yet).

## Testing strategy

| Test file (new unless noted) | Covers |
|---|---|
| `plugins/quirky.agent-status/test/rules-format.test.ts` | SC-7 format, SC-10 every invalid case, safety checker cases |
| `test/rules-match.test.ts` | SC-7 verdicts incl. quiet and `lastLines` |
| `test/rules-builtin.test.ts` | SC-8: every built-in rule has at least one fixture screen/title (under `test/fixtures/screens/<agent>/`) that matches it and one that must not |
| `test/script-state.test.ts` | the precedence table row by row, freshness edges |
| `test/because.test.ts` | stamping in apply, titles, OSC 7501, inference; tool pings don't restamp |
| `test/e2e/*.e2e.test.ts` (split by area: explain, send, waits, names) | SC-1–6, SC-9, SC-11–41 through the `quirky` CLI or `client.call` on a daemon subprocess (`startStatusE2E`, `plugins/quirky.agent-status/test/e2e/support.ts:28`) |
| `test/rules-matcher.test.ts` | the worker's time budget: an overrunning pattern is cut off, the worker respawns, other evaluations keep answering (SC-41) |
| `test/rules-network.test.ts` | SC-13: no module under `src/rules/` imports `node:http(s)`, `node:net`, `node:dns`, or calls `fetch` |
| `packages/pty-host/test/` (existing read tests) | `unwrap` joins rows across the scrollback/screen seam; without it, rows as today |
| `plugins/quirky.session/test/records.test.ts`, `sessions.test.ts`, `cli.test.ts` (existing) | migration 6, `setName`, resolution by name, `list` NAME column |
| `plugins/quirky.agents/test/delivery.test.ts` (existing) | `ready: true` pastes without waiting and still submits per entry |

- The fake agent (`plugins/quirky.agents/test/support/fake-agent.ts`) gains a way for a test to
  make it print later (an `outbox` file it tails, with an `e2e.print(fake, text)` helper), so a
  test can change the screen and title mid-session. Hooks are posted with `e2e.shim(...)` when the
  fake's log shows the expected input. `startStatusE2E` does not forward
  `QUIRKY_TEST_AGENT_STATUS_TIME_SCALE`; pass it through `extraEnv`.
- Acceptance: every SC in the logic spec has a test named `SC-n: …`; `bun run test`,
  `bun test scripts` and `bun run typecheck` pass.

## Non-goals

Everything in [Scope and non-goals](logic.md#scope-and-non-goals), plus: no Activity view or
window code changes; no change to how the dot reads titles; no rule hot-reload watcher (reads
check mtime instead); no remote-host rule paths.
