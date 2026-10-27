# Ask parity: tech spec

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Decisions:
[m2-ask-parity.md](../../../loop/decisions/m2-ask-parity.md). Tier: the user asked for it (headless
loop rule), and the work crosses `packages/protocol`, `plugins/quirky.ask` and
`plugins/quirky.agents` test support.

Orca's source is at `/Users/zpyoung/PycharmProjects/orca/src` (ORCA below). Port values, messages and
rules from it; never import from it. Root of every repo path below:
`/Users/zpyoung/orca/workspaces/quirky/build-roadmap`.

## Architecture

Everything lives in the built-in plugin `plugins/quirky.ask`, which uses only the public plugin API
(`PluginContext` from `@quirky/protocol`). Three layers:

- **Pure core**, `plugins/quirky.ask/src/core/` (new): spec validation with credential refusal,
  answer validation and value parsing, the summary, the timeout builder, draft (partial)
  validation, the window's submission builder, and Claude flag composition. No I/O. Imported by
  the daemon side (`asks.ts`, `main.ts`), the CLI (`cli.ts`, `cli-spec.ts`) and the window module
  (`src/*.tsx`, bundled by `packages/ui/build.ts`).
- **Daemon side**: `asks.ts` (`AskService`: store, `seq`, queue, deadlines, waiters), `main.ts`
  (method, event and launch-hook wiring), `suppression.ts` (new: the Claude version gate and hook).
- **Window module**: `src/ui.tsx`, `src/store.ts`, `src/AskCards.tsx`, `src/AskCard.tsx`,
  `src/QuestionField.tsx`, replacing `src/askAnswers.ts` with the core's draft and submission
  model.

Public types (`AskQuestion`, `AskAnswer`, `AskEnvelope`, `Ask`, `AskPartial`) live in
`packages/protocol/src/model.ts`, because other packages (the daemon's confirmations, the structured
plugin, the desktop shell, the CLI link) read them.

## Code references

| Path | What changes | Logic anchor |
|---|---|---|
| `packages/protocol/src/model.ts:110-141` | Extend `AskOption`, `AskQuestion`, `AskAnswer`, `AskEnvelope`, `Ask`; add `AskPartial`, `AskPartialQuestionDraft`, `AskPendingEnvelope` | [Questions and their validation](logic.md#questions-and-their-validation) |
| `plugins/quirky.ask/src/core/spec.ts` (new) | `validateAskSpec`, `formatSpecErrors`, `MAX_ASK_QUESTIONS`, `MAX_ASK_OPTIONS`; port of ORCA `shared/fork-ask-question-tool/ask-question-schema.ts:117-207` and `ask-question-field-validation.ts` | SC-2, SC-3, SC-4 |
| `plugins/quirky.ask/src/core/answers.ts` (new) | `validateAnswerSubmission`, `parseTextAnswerValue`, `parseNumberAnswerValue`, `parseDateAnswerValue`, `buildSummary`; port of ORCA `main/runtime/rpc/methods/fork-ask-question-tool/ask-answer-validation.ts` and `main/fork-ask-question-tool/ask-answer-value-parsing.ts` | SC-1, SC-5, SC-6, SC-7 |
| `plugins/quirky.ask/src/core/timeout.ts` (new) | `buildTimeoutResult`; port of ORCA `main/fork-ask-question-tool/ask-registry-timeout-answers.ts` | SC-8, SC-10 |
| `plugins/quirky.ask/src/core/partial.ts` (new) | `validatePartial` | SC-12 |
| `plugins/quirky.ask/src/core/submission.ts` (new) | window drafts: `QuestionDraft`, `initialDraftFor`, `draftsToPartial`, `buildSubmission`; port of ORCA `renderer/src/components/fork-ask-question-tool/ask-question-draft.ts` and `build-ask-submission.ts` | SC-6, SC-13, SC-22 |
| `plugins/quirky.ask/src/core/claude-flags.ts` (new) | `missingSuppressionArgs`, `SUPPRESSION_PROMPT`, `CLAUDE_VERSION_FLOOR`, `versionAtLeast`; port of ORCA `shared/fork-ask-question-tool/claude-suppression-flags.ts` and `claude-suppression-flag-composition.ts:17-44` | SC-25, SC-26 |
| `plugins/quirky.ask/asks.ts` | `AskService`: new columns, `seq`, queue, deadlines, `updatePartial`, `expire`; `parseAskSpec` is replaced by `validateAskSpec` | [The queue and `seq`](logic.md#the-queue-and-seq), [Deadlines and defaults](logic.md#deadlines-and-defaults), [Drafts](logic.md#drafts) |
| `plugins/quirky.ask/store-migrations.ts` (new) | the second store migration | [Deadlines and defaults](logic.md#deadlines-and-defaults) |
| `plugins/quirky.ask/main.ts` | `create` passes `timeoutMs` and `checkCredentialText`; new methods `updatePartial`, `expire`; events on surfacing; the launch hook | SC-4, SC-14, SC-15, SC-25 |
| `plugins/quirky.ask/suppression.ts` (new) | `ClaudeVersionGate`, `suppressionHook` | SC-25, SC-26 |
| `plugins/quirky.ask/quirky-plugin.json` | method, event, launch-hook and CLI flag declarations | all |
| `plugins/quirky.ask/cli.ts`, `cli-spec.ts` | `--chunk-ms`; server-side deadline; `wait --timeout-ms` through `expire`; shared validator and Orca's JSON message | SC-2, SC-8, SC-10, SC-20 |
| `plugins/quirky.ask/src/store.ts` | watermark, surfaced filter, report with `queued` | SC-14, SC-15, SC-16 |
| `plugins/quirky.ask/src/AskCard.tsx`, `QuestionField.tsx`, `AskCards.tsx` | Orca's controls, messages, drafts with debounce, plain-text preview | SC-21, SC-22, SC-23, SC-24 |
| `plugins/quirky.ask/src/askAnswers.ts` | deleted; its test `test/ui-askAnswers.test.ts` moves to the core's submission tests | SC-6 |
| `plugins/quirky.agents/test/support/fake-agent.ts`, `e2e.ts` | `FakeBehavior.version`: the fake answers `--version` | SC-25, SC-26 |

Existing anchors the work reads but doesn't change: `PluginContext.openStore`
(`packages/protocol/src/plugins.ts:65`), `StoreMigration` (`plugins.ts:189`), `LaunchHook`,
`LaunchHookInput`, `LaunchPatch` (`plugins.ts:197-215`), `PluginLaunch.commandArgv` and `env`
(`plugins.ts:114-135`), `PluginCaller` (`plugins.ts:157-168`), the launch-hook pipeline
(`packages/daemon/src/plugins/launch-hooks.ts:55`, 5000 ms per hook from
`packages/daemon/src/daemon.ts:167`), hook args placement on launch and resume
(`plugins/quirky.agents/src/core/plan.ts:269-304`, `:436-443`; hook args are not part of the launch
record, so resume re-runs hooks), the harness (`plugins/quirky.ask/test/support.ts`,
`packages/daemon/test/helpers.ts:31`), the agents e2e harness
(`plugins/quirky.agents/test/support/e2e.ts:114`).

## Data models / schemas

SCHEMA: question types (protocol `model.ts`; every field optional unless marked)

```
AskPreview = { format: 'markdown' | 'html'; content: string }
AskOption  = { value: string; label: string; description?: string; preview?: AskPreview }
common     = { id: string; question: string; header?: string; required?: boolean }
select      = common & { type: 'select';      options: AskOption[]; default?: string }
multiselect = common & { type: 'multiselect'; options: AskOption[]; default?: string[] }
text        = common & { type: 'text'; multiline?: boolean; pattern?: string; format?: 'email' | 'url'; default?: string }
number      = common & { type: 'number'; integer?: boolean; min?: number; max?: number; default?: number }
date        = common & { type: 'date'; default?: string }          // YYYY-MM-DD
confirm     = common & { type: 'confirm'; default?: boolean }
AskSpec = { title?: string; questions: AskQuestion[] }
```

SCHEMA: answers and envelopes

```
AskAnswer =
  | { value: string; label?: string; note?: string; source: 'option' | 'other' | 'default' }   // select
  | { values: string[]; labels: string[]; other?: string; source: 'options' | 'default' }     // multiselect
  | { value: string;  source: 'input' | 'default' }                                           // text, date
  | { value: number;  source: 'input' | 'default' }                                           // number
  | { value: boolean; source: 'input' | 'default' }                                           // confirm
AskStatus   = 'pending' | 'answered' | 'partial' | 'declined' | 'timed_out'
AskEnvelope = { status: AskStatus; askId: string; answers: Record<string, AskAnswer>; skipped: string[]; summary: string }
AskPendingEnvelope = { status: 'pending'; askId: string; instruction: string }   // CLI output only
AskPartialQuestionDraft = { selected?: string[]; other?: string; note?: string; draft?: string; confirm?: boolean }
AskPartial = Record<string, AskPartialQuestionDraft>
Ask = { id; spec; sessionId: string | null; worktreeId: string | null; createdAt: number; envelope: AskEnvelope;
        seq: number; queued: boolean; partial: AskPartial; expiresAt: number | null }
```

`text` keeps `source: 'input'` for v1's existing answers. A v1 `AskAnswer` `{ value, source: 'input' }`
for text and confirm is still valid.

SCHEMA: store (`<home>/plugin-data/quirky.ask/store.db`). Migration 1 is
`v1AsksMigration` (`plugins/quirky.ask/v1-import.ts`). Migration 2, appended in
`store-migrations.ts`:

```
asks + partial TEXT NOT NULL DEFAULT '{}'
     + expires_at INTEGER            -- epoch ms, null = no deadline
     + summary TEXT NOT NULL DEFAULT ''
     + seq INTEGER NOT NULL DEFAULT 0
     + created_seq INTEGER NOT NULL DEFAULT 0   -- queue order, set once at creation
ask_seq(id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)
```

Migration 2 backfills `seq` and `created_seq` for existing rows as 1..n in `(created_at, id)` order
and sets `ask_seq.value` to n. A v1 row whose `status` is `pending` and has a session joins that
session's queue in that order.

SCHEMA: events (`quirky.ask/<name>`), declared in the manifest

```
created  { ask: Ask; seq: number }
surfaced { ask: Ask; seq: number }
updated  { askId: string; partial: AskPartial; seq: number }
resolved { askId: string; envelope: AskEnvelope; seq: number }
```

SCHEMA: methods (manifest `method` entries; existing ones gain fields)

```
create        { spec: object; session?: string; worktree?: string; timeoutMs?: integer >= 1 } -> { askId }
wait          { askId; timeoutMs?: integer >= 0 } -> AskEnvelope          (unchanged; cap 60000)
answer        { askId; answers: object; skipped?: string[] } -> AskEnvelope
cancel        { askId } -> AskEnvelope
list          { pendingOnly?: boolean } -> Ask[]
updatePartial { askId; partial: object } -> { ok: boolean }
expire        { askId } -> AskEnvelope
```

CONFIG: CLI flags (manifest `cli-command` entries)

```
quirky ask        --spec <json|@file> (required)  --timeout-ms <integer>  --chunk-ms <integer>
quirky ask wait   --id <askId> (required)         --timeout-ms <integer>  --chunk-ms <integer>
quirky ask cancel --id <askId> (required)
```

CONFIG: suppression flags and prompt (exact strings)

```
--disallowedTools AskUserQuestion
--append-system-prompt "When you need to ask the user a question, run quirky ask (see quirky ask --help) instead of asking in chat."
floor: 1.0.51   probe timeout: 3000 ms   retry after a failed or below-floor probe: 30 min
```

## Contracts & interfaces

### Spec validation (`src/core/spec.ts`) — [SC-2](logic.md#questions-and-their-validation), SC-3, SC-4

CONTRACT:
```
validateAskSpec(raw: unknown, options: { checkCredentialText: boolean })
  : { ok: true; spec: AskSpec } | { ok: false; errors: { path: string; message: string }[] }
formatSpecErrors(errors): string   // "<path>: <message>" joined with "; "
```

- Pre: none; `raw` is untrusted JSON.
- Post: on success, `spec` is canonical: known fields only, in ORCA's normalized form, plus a string
  `title` when given. On failure, every error is reported, in spec order (ORCA collects, never stops
  at the first).
- Rules and messages are ORCA's (`ask-question-schema.ts:126-207`, `ask-question-field-validation.ts`),
  including the credential normalization and triggers (`:20-59`), regex safety (`:76-188`,
  `MAX_PATTERN_LENGTH` 200, `MAX_PATTERN_QUANTIFIERS` 10) and `isValidIsoDate`. Root messages use
  ORCA's paths (`questions`, `questions[i].field`). Quirky adds `title`: `title must be a string`.
- `checkCredentialText: false` skips the three credential-shaped text checks only; the
  `masked`/`sensitive` refusal always runs (D7).

### Answers (`src/core/answers.ts`) — [SC-5](logic.md#answers), SC-6, SC-7, SC-1

CONTRACT:
```
validateAnswerSubmission(spec, answers: unknown, skipped: unknown)
  : { ok: true; answers: Record<string, AskAnswer>; skipped: string[] } | { ok: false; message: string }
buildSummary(spec, answers): string
parseTextAnswerValue(q, raw: string): string | null
parseNumberAnswerValue(q, raw: string): number | null
parseDateAnswerValue(raw: string): string | null
```

- ORCA's `ask-answer-validation.ts:114-167`, except: a question absent from both `answers` and
  `skipped` is appended to `skipped` (spec order) unless `required`, which is an error (D8).
- Accepts `source: 'input'` for text/number/date/confirm and v1's select `{value, source: 'option'}`
  without `label`. Rebuilds `label` (select), `labels` (multiselect) and `source` from the spec, so
  stored values are authoritative. `source: 'default'` from a caller is refused.
- `message` names the question ID, e.g. `answers.replicas: value must be at least 1`; the exact
  wording is ORCA's where ORCA has one.
- `buildSummary` is ORCA's `buildResultSummary` (`ask-answer-value-parsing.ts:40-59`): one line per
  answered question in spec order, joined with `\n`.

### Timeout result (`src/core/timeout.ts`) — [SC-8](logic.md#deadlines-and-defaults), SC-10

CONTRACT: `buildTimeoutResult(spec, partial): { answers; skipped; summary }` — ORCA's, unchanged:
default, else the parsed draft (`source: 'input'`), else skipped; never coerces.

### Drafts (`src/core/partial.ts`) — [SC-12](logic.md#drafts)

CONTRACT: `validatePartial(spec, raw: unknown): { ok: true; partial: AskPartial } | { ok: false; message: string }`

- `raw` must be an object; each entry for an unknown question ID is dropped; each kept entry must
  have only the five draft keys with the right types (`selected` string array, `other`/`note`/`draft`
  strings, `confirm` boolean), else `{ ok: false }`. Strings longer than 10000 characters are
  refused (bounds enforced in code; manifest schemas can't express them, m1-launch-settings D31).

### Window drafts and submission (`src/core/submission.ts`) — [SC-22](logic.md#the-card), SC-6, SC-13

CONTRACT:
```
QuestionDraft = { selected: string[]; freeText: string; text: string; confirm: boolean | null }
initialDraftFor(partial?: AskPartialQuestionDraft): QuestionDraft
draftsToPartial(drafts: Record<string, QuestionDraft>): AskPartial
buildSubmission(spec, drafts)
  : { ok: true; answers; skipped } | { ok: false; errors: Record<string, string> }
```

- ORCA's `ask-question-draft.ts` and `build-ask-submission.ts:20-150`, with the messages listed in
  [D18](../../../loop/decisions/m2-ask-parity.md). Multiselect values in spec order.

### Claude flags (`src/core/claude-flags.ts`) — [SC-25](logic.md#claude-sessions-use-quirky-ask), SC-26

CONTRACT:
```
missingSuppressionArgs(existing: readonly string[]): string[]
versionAtLeast(output: string, floor: string): boolean | null   // null = no x.y.z found
```

- `missingSuppressionArgs` returns, in order, each pair of the CONFIG above whose flag is absent
  from `existing`. Present means a token equal to the flag, or starting with `<flag>=`, counting the
  aliases `--disallowed-tools` for `--disallowedTools` and `--append-system-prompt-file` for
  `--append-system-prompt` (ORCA `claude-suppression-flag-composition.ts:17-44`).

### Version gate and hook (`suppression.ts`) — [SC-25](logic.md#claude-sessions-use-quirky-ask), SC-26

CONTRACT:
```
class ClaudeVersionGate { constructor(probe: (command: string) => Promise<string | null>, now: () => number)
  allows(command: string): Promise<boolean> }
suppressionHook(context: PluginContext, gate: ClaudeVersionGate): LaunchHook
```

- The hook is registered as `launch-hook:quirky.ask/claude-ask` with manifest
  `agents: ["claude"]`. It reads `quirky.agents/get { agent: "claude" }` for `command` and `args`,
  asks the gate whether `command` passes, and returns
  `{ args: missingSuppressionArgs([...tokens of command, ...tokens of args, ...launch.args]) }`, or
  `{}` when the gate says no. Tokenizing uses a shell-word split; a split failure means "no flags".
- `allows`: a passing verdict is cached per command for the plugin's life; a failing one (below the
  floor, no version found, a non-zero exit, a 3000 ms timeout) is cached for 30 minutes and then
  probed again. Concurrent calls share one probe.
- The probe runs `context.launch.commandArgv("<command> --version")` with
  `context.launch.env({ sessionId, worktreeId, agent: "claude" })` from the hook input, reads stdout,
  and kills the process on timeout. It never throws.
- The hook never throws: any failure returns `{}` (fail open), so a launch is never blocked by it.

### `AskService` (`asks.ts`) — [The queue and `seq`](logic.md#the-queue-and-seq), [Deadlines](logic.md#deadlines-and-defaults), [Drafts](logic.md#drafts)

CONTRACT:
```
constructor(store, errors: AskErrors, hooks: AskServiceHooks, clock?: { now(): number; setTimeout; clearTimeout })
AskServiceHooks = { created(ask, seq); surfaced(ask, seq); updated(askId, partial, seq); resolved(askId, envelope, seq) }
create(spec: unknown, sessionId, worktreeId, options: { timeoutMs?: number; checkCredentialText: boolean }): Ask
answer(askId, answers: unknown, skipped: unknown): AskEnvelope
cancel(askId): AskEnvelope
expire(askId): AskEnvelope
updatePartial(askId, partial: unknown): { ok: boolean }
wait(askId, timeoutMs?): Promise<AskEnvelope>
list(pendingOnly): Ask[]
start(): void      // arms deadlines; resolves overdue asks; call once after construction
shutdown(): void
```

- **seq.** Every write (create, updatePartial with `ok: true`, resolve, promote) increments
  `ask_seq.value` and stores it on the row, inside one store transaction with the row change. The
  hook for that change gets the same value. Values are never reused.
- **Queue.** An ask is `queued` when it is pending, has a `session_id`, and another pending ask of
  the same session has a lower `created_seq`. Derived on read, never stored. Resolving an ask whose
  session has queued asks promotes the lowest-`created_seq` one: a new `seq` on its row, then
  `surfaced(ask, seq)` after `resolved`. Resolving a queued ask promotes nothing.
- **create.** Validates with `validateAskSpec` (InvalidParams with `formatSpecErrors`), stores
  `expires_at = min(now + timeoutMs, 8640000000000000)` when `timeoutMs` is given, arms the timer,
  calls `created`, then `surfaced` if not queued.
- **Deadlines.** A timer per pending ask with `expires_at`; delays above 2147483647 ms re-arm in
  steps. On fire, a still-pending ask resolves `timed_out` with `buildTimeoutResult(spec, partial)`.
  `start()` arms every pending row and resolves overdue ones (oldest `created_seq` first). `wait`,
  `answer`, `updatePartial` and `list` first resolve the asks they touch whose deadline has passed,
  so a late timer never lets a stale ask be answered.
- **expire.** A pending ask resolves exactly as at its deadline; a finished one returns its envelope.
- **answer.** NotFound for an unknown ask, Conflict for a finished one (as today), InvalidParams for
  a refused submission (ask unchanged). Status `partial` when `skipped` is non-empty.
- **cancel.** As today, plus `summary: ""`.
- **updatePartial.** NotFound unknown; `{ ok: false }` finished; InvalidParams invalid; else replaces
  `partial` and calls `updated`.
- **wait** keeps its long-poll and its 60000 ms cap, and still rejects on shutdown.
- **Waiters** are released on every resolve, including timeouts and expiry.

### `main.ts` — SC-4, SC-14, SC-15

- `create` passes `checkCredentialText: caller.role !== 'plugin'` and `timeoutMs`.
- The `created` hook emits `created`. The `surfaced` hook emits `surfaced` (only for promotions) and
  runs today's `announce` (notify) and `openQuestionsPanel`; for an ask surfaced at creation,
  `announce` and `openQuestionsPanel` run once after `created`. Queued asks never notify.
- `activate` calls `asks.start()` after the methods are provided, and provides the launch hook.

### CLI (`cli.ts`) — [SC-20](logic.md#the-cli), SC-2, SC-8, SC-10

- `ask`: parses `--spec` (`Invalid JSON for --spec: <error>` on bad JSON), validates with
  `checkCredentialText: true` and throws `ctx.usage(formatSpecErrors(errors))` (exit 2), calls
  `create` with `timeoutMs`, prints `registered`, then waits.
- Waiting: loops `quirky.ask/wait` in calls of at most 60000 ms. With `--chunk-ms N`, it stops after
  N ms and prints `{status: "pending", askId, instruction: "quirky ask wait --id <askId>"}`. With
  `wait --timeout-ms N`, once N ms pass it calls `quirky.ask/expire` and prints that envelope. If
  both are given, whichever comes first applies. `ask --timeout-ms` never cancels or expires from
  the CLI; the daemon's deadline does it. Reconnect handling stays as it is.
- `--chunk-ms` and `--timeout-ms` below 1 are usage errors (`--chunk-ms must be at least 1`).

### Window module — [The card](logic.md#the-card), SC-14, SC-16

- `store.ts`: keeps `watermark` (highest `seq` applied from events and from the `seq` of every
  listed ask). An ask event with `seq <= watermark` is ignored; any other refetches the pending
  list. `get()` returns only asks with `queued: false`, in `createdAt` order. The badge counts them.
  `reportOf` returns `{ pending: [{askId, title, questions}], queued: <count> }`.
- `AskCard.tsx`: drafts start from `initialDraftFor(ask.partial[q.id])` on mount; each change
  schedules `quirky.ask/updatePartial` 500 ms after the last change (one pending timer per card,
  cleared on unmount and on submit or dismiss). Submit runs `buildSubmission`; errors render under
  their question and block the call. Title row, header, question and "(optional)" per D18. Dismiss
  stays and calls `cancel`.
- `QuestionField.tsx`: the controls per D18; option rows are buttons with `aria-pressed`; the free
  text input has placeholder "Add your own answer"; number inputs set `step` ("1" or "any"), `min`,
  `max`; date inputs `type="date"`; preview toggle shows `content` in a `<pre>` as text.

## DO-NOT-CHANGE fences

- `plugins/quirky.ask/v1-import.ts` `v1AsksMigration`: installed stores already ran migration 1;
  new columns go in migration 2 only.
- `packages/daemon/src/plugins/confirm.ts` and `packages/cli/src/link.ts`: they rely on `create`
  returning `{askId}`, `wait` with `timeoutMs: 0` and `60000`, and the statuses; keep those
  contracts so they need no change.
- `plugins/quirky.agents/src/core/plan.ts` `buildResumePlan`, `buildLaunchPlan`: hook args already
  flow into both; the suppression flags must arrive only through the launch hook.
- `plugins/quirky.agents/src/core/shell.ts`: the injection-safety contract (m1-launch-settings).
- `docs/loop/`, `scripts/build-loop/`: protected loop paths.
- `apps/desktop/`: the dock badge keeps counting `list { pendingOnly: true }`.

## Always / Ask / Never

- **Always:** port ORCA's messages verbatim; validate in the daemon even when the CLI already did;
  stamp `seq` in the same transaction as the row change; release waiters on every resolve; use a
  temporary `QUIRKY_HOME` and `HOME` in tests; name scenario tests `test('SC-n: ...')`.
- **Ask (implementer's choice):** internal helper names; how timers are kept; component structure
  inside the window module; whether the CLI waits through one helper or two.
- **Never:** render preview content as HTML; launch a real agent CLI or read the real `~/.claude`,
  `~/.quirky`, `~/.codex`; let the suppression hook throw or block a launch; weaken an existing test
  instead of updating an answer it sends that the new validation rightly refuses.

## Cross-cutting

- **Security:** credential refusal (D7); regex safety and the 200-character cap before matching;
  answer validation; preview as text only.
- **Migration:** migration 2 is additive; v1 and M0 rows keep working (`summary` empty, no deadline).
- **Compatibility:** existing callers that answer through the API must send valid answers; a confirm
  answer is `{ value: true | false }`. Tests that sent other shapes are updated.
- **Rollback:** the plugin is self-contained; reverting the branch reverts it. Migration 2's columns
  are ignored by older code.

## Testing strategy

Gate: `bun run test`, `bun test scripts`, `bun run typecheck`.

- `plugins/quirky.ask/test/core/*.test.ts` (new, unit): spec validation (SC-2, SC-3 tables, every
  ORCA message used), answers and summary (SC-1, SC-5, SC-6, SC-7), timeout builder (SC-8), partial
  validation (SC-12), submission (SC-22 messages), Claude flag composition (SC-26 aliases).
- `plugins/quirky.ask/test/asks.test.ts` (API through `startAsk`): SC-1, SC-4 (a test plugin dir
  beside the symlinked `quirky.ask`), SC-5, SC-7, SC-9, SC-11, SC-12, SC-13 (restart half), SC-14,
  SC-15, SC-17, SC-18, SC-19. Event `seq` assertions read from `openWindow` events.
- `plugins/quirky.ask/test/cli.test.ts`: SC-2, SC-3 (CLI half), SC-8, SC-10, SC-20 through `testCli`;
  one test spawns the real CLI (`packages/cli` entry, as other plugin CLI tests do) for SC-20.
- `plugins/quirky.ask/test/ui.test.ts`, `panel.test.ts` (happy-dom): SC-6, SC-13 (window half:
  debounce, restore), SC-14, SC-15, SC-16, SC-21, SC-22, SC-23, SC-24.
- `plugins/quirky.ask/test/suppression.test.ts`: the gate with a fake probe (cache, 30-minute
  retry, timeout); SC-25 and SC-26 end to end with `startAgentsE2E` and fake `claude` and `codex`
  whose `version` behavior is set.
- Existing tests in `plugins/quirky.ask/test`, `packages/daemon/test/plugins/confirm.test.ts`,
  `packages/cli/test/confirm.test.ts`, `plugins/quirky.structured/test`, `apps/desktop/test` and
  `packages/ui/test/exit.e2e.test.ts` keep passing; the queued-ask expectation of m0-core D33 is
  rewritten to SC-15's.
- UI scenarios SC-6, SC-13, SC-14, SC-15, SC-21 to SC-24 are run in the built app with
  `quirk:using-apps-like-a-user` (LOOP.md step 6).

## Non-goals

Everything in the logic spec's [Scope & non-goals](logic.md#scope--non-goals). Also: no change to the
kernel's dispatcher, store, launch-hook pipeline or the CLI framework; no new kernel method.
