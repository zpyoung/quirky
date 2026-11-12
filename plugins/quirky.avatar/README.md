# Avatar (`quirky.avatar`)

The avatar supervises worktrees you hand off: it gates their tool calls, briefs and steers the agents, and carries the work to a merge-ready pull request. Behavior and requirements are in the [logic spec](../../docs/quirk/specs/2026-11-04-avatar/logic.md); the module layout, contracts and data models are in the [tech spec](../../docs/quirk/specs/2026-11-04-avatar/tech.md).

## What it does

Handing a worktree off gives it a mandate (goal, done-when, guidelines, a level and three switches) and puts a supervision marker on its agent session.

- **Gate.** Each tool call from a marked session goes to the avatar before the agent runs it. Fixed rules decide first. Only a call no rule decides reaches the brain, a background structured session with every tool denied. Anything unanswered, late or failed is refused with a retry reason, never allowed.
- **Levels.** `shadow` answers passthrough and journals what it would have done. `local`, `own-branch` and `full` allow progressively more; a level only ever denies. Messaging, history rewrites and deploys also need their switch.
- **Held calls.** Credentials, writes outside the handed-off worktrees and calls above a switch are held and appear as needs-you items. `allow-once` admits that one identical call a single time.
- **Take-back.** Removes the markers, closes open needs as handed-back, cancels queued outbox work and releases any waiting request as passthrough. The mandate is kept.
- **Surfaces.** A window-bar pill, a panel, a hand-off sheet, the report view, a sidebar ring on handed-off worktrees, and the `quirky avatar` commands below.

The gate is installed per agent: a Claude launch hook, Codex `hooks.json` entries and a pi/omp extension. Sessions without a marker are never blocked and never depend on the daemon.
Turn off `agent-hooks` with `quirky setting set setting:quirky.avatar/agent-hooks false` to remove the avatar's Codex entries and pi/omp extension files and stop reinstalling them; take those worktrees back first.

## CLI

| Command | What it does |
| --- | --- |
| `quirky avatar handoff <worktree> --goal <text> --done-when <command or sentence>` | Hands a worktree off. Without `--level`, the default level from settings applies; each unnamed switch keeps its default. Optional: `--level`, `--agent`, `--guideline` (repeatable), `--notes`, `--shared-goal`, `--allow-split`, `--allow-messaging`, `--allow-history-rewrite`, `--allow-deploys`, `--switch name[=false]`. |
| `quirky avatar status` | Handed-off worktrees with state and level, and how many items wait on you. |
| `quirky avatar report` | The needs-you-first report: decisions, guesses, sleeps and what was handed back. |
| `quirky avatar log [--worktree <w>] [--limit <n>] [--before <seq>]` | The journal, newest first. |
| `quirky avatar take-back <worktree>` or `--all` | Takes a worktree, or every worktree, back. |

The same operations are plugin methods under `quirky.avatar/`: `eligibility`, `handoff`, `takeBack`, `status`, `sidebarStatus`, `report`, `log`, `resolveNeed`, `mandate`, `settings` and `setSettings`.

The Report tab shows a guess's chosen answer and each proposed mandate field's current and new values. Question needs show every question in the batch with its typed controls and optional markers. Each need's action buttons stay disabled until its own request settles.

For question needs, `resolveNeed` accepts `answers`, keyed by question ID, containing the typed `AskAnswer` values that `quirky.ask/answer` validates. Legacy question needs still accept `text`. Answer validation failures keep the need open to retry; already-finished or missing asks close their stale needs.

## Settings

Set under Settings > Avatar. Level and switch defaults apply to new hand-offs; the rest tune the gate and the brain.

| Setting | Default | Meaning |
| --- | --- | --- |
| Default level | `full` | Level a new hand-off starts with. |
| Allow messaging people / history rewrites / deploys | off | Default for each switch on a new hand-off. |
| House rules | empty | Rules every worker follows, one per line. |
| Always-allowed commands | empty | Commands the gate allows without judgment. |
| Always-denied commands | empty | Commands the gate always denies. |
| Deploy commands | empty | Commands that count as a deploy. |
| Brain agent / Brain model | `claude` / agent default | Which agent runs the brain, and its model. |
| Judgment timeout (seconds) | 55 | How long the gate waits for the brain before asking the agent to retry. |

## Tests

Unit tests are one file per module under `test/`. `test/e2e/` runs a real daemon with this plugin loaded and small stand-ins for its neighbours (worktrees, sessions, sends, the brain's structured runner), with fake agents that POST to `/gate/` as the shim does:

```sh
bun test plugins/quirky.avatar/test/e2e
```
