# Questions (`quirky.ask`)

`quirky.ask` stores answerable questions in its own durable FIFO and exposes them to the window, CLI, mobile client, and other authenticated clients. A live exact session can keep an Ask pending without an attached desktop; a caller with neither a live authenticated session nor an attached question surface receives typed `unavailable`.

## Public API and CLI

| Method | Request | Behavior |
|---|---|---|
| `quirky.ask/create` | `{spec, session?, worktree?, timeoutMs?}` | Creates a local/plugin-authored Ask; session/worktree default to caller attribution, else `null`. A positive `timeoutMs` sets a durable deadline. |
| `quirky.ask/register` | `{spec, requestId, timeoutMs?}` | Idempotently registers a client Ask. An active exact orchestration Dispatch creates one durable coordinator question; otherwise a live exact session remains answerable when a UI reconnects. Returns `{askId}` or `{status:'unavailable', reason}`. |
| `quirky.ask/wait` | `{askId, timeoutMs?}` | Connection-bound client wait. Returns a terminal envelope, or `pending` after a chunk. Each call is capped at 60,000 ms; `timeoutMs: 0` reads immediately. Handoff waits preserve the authenticated caller and revalidate the same Dispatch. |
| `quirky.ask/answer` | `{askId, answers, skipped?}` | Validates and commits the submitted answer envelope. Handoff questions must be answered by the exact coordinator question. |
| `quirky.ask/cancel` | `{askId}` | Declines a still-pending local ask; a finished ask is returned unchanged. Handoff questions are controlled by their coordinator. |
| `quirky.ask/list` | `{pendingOnly?, askId?}` | Lists local asks in creation order; `askId` selects only that row before deserialization and composes with `pendingOnly`. Unknown IDs return `[]`. Pending rows identify whether they are queued. Mobile can inspect handoff status. |
| `quirky.ask/updatePartial` | `{askId, partial}` | Replaces the saved draft while the ask remains pending. |
| `quirky.ask/expire` | `{askId}` | Applies the stored timeout defaults/drafts and resolves the ask as timed out. |

At most **four** `wait` calls may park concurrently in one AskService. Overflow is shed without changing the ask and returns RPC `Conflict` (`-32009`) with `data.reason: "runtime_busy"`. The CLI recognizes that typed reason and retries with a bounded delay while preserving `--chunk-ms` and `--timeout-ms`; it does not treat capacity pressure as a dropped connection. Closing the caller connection aborts only that wait and releases its slot; the durable ask remains pending.

Kernel confirmations inspect the exact Ask's durable envelope through `quirky.ask/list {askId}`, not the connection-bound wait API or the full historical list. Unrelated historical rows cannot block the read. Only an answered `confirm: true` authorizes the bound action; pending, declined, timed-out, unavailable, or expired/missing asks refuse it. The action digest and one-time consumption checks still apply to both client-originated and plugin-originated destructive calls.

CLI forms are `quirky ask --spec <json|@file> [--timeout-ms N] [--chunk-ms N]`, `quirky ask wait --id <askId> [--timeout-ms N] [--chunk-ms N]`, and `quirky ask cancel --id <askId>`. The spec permits up to 10 questions and 12 options per select/multiselect, with types `select`, `multiselect`, `text`, `number`, `date`, and `confirm`.

There are no Ask-specific user settings.

## Presentation and attention

Questions stays in the shell's Ask tool (right top by default). Cards, fields, options, validation and result summaries use shared graphite components and semantic tokens in dark and light; the host still owns the tool frame and placement. Draft timing, answer envelopes and attention behavior are unchanged. Sanitized option previews use the shared read-only iframe presentation, follow the host appearance live, and keep their empty sandbox and restrictive networkless/scriptless CSP.


- Option previews accept `markdown` or `html`. They use the package-local unified Markdown/GFM, raw-HTML and `rehype-sanitize` pipeline, then stringify sanitized markup into an iframe with an empty `sandbox` and restrictive CSP. No server-side React module is required in the browser. Script, forms, navigation/URL attributes, external resources, images/media and embedded documents are removed or blocked. Links have no navigation attributes. Hiding a preview removes its frame; normal selection and free-text answers remain available.
- A terminal answer, cancellation, or timeout summary is presentation-only and remains in Questions for four seconds. It does not change durable FIFO state or the pending badge. A stale pending snapshot cannot restore a recently resolved ask. A promoted ask remains the queue head and is counted normally.
- Questions auto-opens only when a surfaced ask's exact session is the active session in the focused worktree view and the view has focus. It opens only if no panel is selected; opening the panel preserves terminal focus. A later user panel choice is not replaced by refreshes. Unfocused and session-null asks are not used to steal focus; the Questions badge and manual panel remain available.
- The notification policy escalates a still-pending, surfaced unattended head after three uninterrupted minutes. Queued asks do not arm timers or count as pending attention.

## Exact owner and unavailable outcomes

`unavailable` is a terminal refusal with a reason, empty answers, and every question skipped. It is never consent. Registration returns the no-`askId` `{status:'unavailable', reason}` shape when there is no authenticated live asker and no attached question surface. Existing asks are reconciled only from exact kernel session identity: a missing session lookup or absent UI is unknown evidence and leaves a live background Ask pending; a proven-exited or replaced process resolves it unavailable.

`quirky.ask/register` forwards the original client caller through the daemon's callback-lifetime `PluginContext.forward` only while the registration callback is active. `quirky.orchestration/ask` authenticates the exact caller and returns the current Run, Dispatch, worker key, and session identity. The Ask store persists that identity, question ID, and request ID before wait resumes, so retries and restarts cannot create a second coordinator question or retarget another worker. Coordinator free text maps back through the original question IDs, option values, and answer types. Native Claude/Codex question prompts preserve their provider question/option IDs; secret inputs are refused.
