# Useful Commands

- **Typecheck**: `pnpm tc` (or `tc:node` / `tc:cli` / `tc:web`)
- **Test**: see [Running Tests](#running-tests) — run one file at a time; the full suite runs on GitHub Actions
- **Lint**: `oxlint`, or `pnpm run check:code-quality:changed` for changed files (full `pnpm lint` is slow); format with `pnpm format`
- **Design system**: `pnpm run lint:design-system` for the full renderer report (not a gate); the changed-lines gate above is what CI enforces

# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

# Electron UI Validation

Always run tests and agent-launched apps in the background with `QUIRKY_BACKGROUND_LAUNCH=1`.
Never steal monitor focus or reveal test windows: no `show()`, `showInactive()`, `bringToFront()`,
`app.focus()`, or OS activation. Use CDP screenshots of hidden renderers. Keep native-focus and visible-window tests paused on the user's desktop; run them on an isolated display or CI.
Rebuild modified launch-policy code before running an app; stale build wrappers are not safe.

Use the `$electron` skill and Playwright CDP for rendered Quirky UI checks. Do not use computer-use for Quirky UI validation.

# Code Style

## Reuse Before Reimplementing

Before writing new logic at any scale — a function, component, IPC channel, state store, or whole subsystem/flow — check whether an existing implementation already does the job. Extend or generalize it instead of building a parallel version.

## Avoid Comments

- Only use when code does not describe
- BE CONCISE. 1 LINE if possible (why not how)

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Type Assertions: Prefer Checked Types

Avoid type assertions except `as const`. Unavoidable casts need a line-specific `SAFETY:` explanation:

# First Class Citizens

Every change must consider these areas:

## macOS Only

Quirky supports macOS only. Don't add Windows or Linux code paths, and don't add platform branches for them. Guard macOS-specific behavior in the code that owns it, and use the existing process wrappers.

## Remote Use Case

Support remote execution as well as local. Clients and servers update independently; preserve compatibility across mixed versions.

## Mobile

Any feature should be considered for parity on mobile

## Folder Workspaces

All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree.

# Git / GitHub

If changing code around `git`, `gh`, source-control, or review behavior read [`docs/reference/git-workflow.md`](./docs/reference/git-workflow.md).

# Tests

Avoid adding low-value tests. These might be fine for development but offer low value when checked in. [Anti-patterns](./docs/reference/test-antipatterns.md)

## Running Tests

Run one test file locally, after `pnpm run build:packages`:

```sh
QUIRKY_ALLOW_LOCAL_TESTS=1 pnpm exec vitest run --config config/vitest.config.ts <file>
```

Never run the full suite on the Mac. It runs on GitHub Actions: a draft PR runs the tests your change selects, and a PR marked ready runs everything. Read the result with `gh pr checks <number> --watch`. Run `unset GITHUB_TOKEN` before pushing, because the shell's token can't push.

## Typechecking: Scope It to What You Changed

Never run `pnpm typecheck` on this machine. It spawns three concurrent `tsc --noEmit` runs over the
whole repo, and with several worktrees open at once that is enough to saturate every core. The full
sweep belongs to the `typecheck` job in [`.github/workflows/pr.yml`](./.github/workflows/pr.yml),
which runs it against a cached `.tsbuildinfo` graph.

Locally, run only the project that owns the files you touched:

| Changed path                                                    | Command               |
| --------------------------------------------------------------- | --------------------- |
| `src/main/**`, `src/preload/**`, `src/relay/**`, `src/types/**` | `pnpm typecheck:node` |
| `src/renderer/**`                                               | `pnpm typecheck:web`  |
| `src/cli/**`                                                    | `pnpm typecheck:cli`  |
| `tests/**`                                                      | `pnpm typecheck:e2e`  |

`src/shared/**` is included by the node, web, and cli projects alike, and the cli project also pulls
in a fixed list of `src/main` modules named in `config/tsconfig.cli.json`. When a change spans more
than one project, run them one after another — never concurrently.

For a single file, prefer the editor's TypeScript language server over spawning `tsc` at all; it
answers from a graph that is already resident. `tsc --noEmit <file>` is not a substitute, because it
drops the project's `paths` aliases and JSX settings and reports errors that do not exist.

# Typed Observations: the Quirky Ledger

When you notice something you cannot act on in this session, do NOT bury it in prose with phrases
like "pre-existing", "out of scope", "future work", or "skipped for brevity". File it in the Quirky
ledger, which is keyed to the project, so entries survive worktree deletion and stay visible from
sibling worktrees of this repo.

```sh
quirky ledger file --type bug      --title <t> --file <path:line> \
                                 --description <d> --severity critical|high|medium|low
quirky ledger file --type deferred --title <t> --why-deferred <w> \
                                 --priority high|medium|low
quirky ledger file --type test-gap --title <t> --file-under-test <path:line> \
                                 --reason-skipped <r>
quirky ledger file --type proposal --title <t> --context <c> --recommendation <r>
quirky ledger file --type decision --title <t> --context <c> --decision <d> \
                                 --consequences <q> --status proposed|accepted|superseded
quirky ledger list   --type bug --state open --json
quirky ledger show   --id bug-12 --json
quirky ledger state  --id bug-12 --state resolved --if-revision <n> --json
quirky ledger review --json
```

`--if-revision` takes the revision from `show`; a stale value returns `conflict` with the current
revision in `error.data.currentRevision`.

The ledger is the only surface, and it wins on any disagreement. BUGS.md, DEFERRED.md,
TEST_BACKLOG.md, proposals.md and docs/adr/ are legacy — read them for history, never append to
them. BUGS.md and DEFERRED.md were migrated; TEST_BACKLOG.md was not, so its entries live only in
markdown until someone files them. The `quirk:typed-artifacts` skill and the `/quirk:artifacts:*`
commands still write markdown; do not use them.
