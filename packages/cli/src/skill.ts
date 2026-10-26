import type { ApiCatalog, ApiCommandEntry } from '@quirky/protocol'
import { byText, compareEntries } from './catalog'

const DESCRIPTION =
  'Drive Quirky (repos, worktrees, sessions, terminals, plugins) from the shell with the quirky CLI. Use when an agent needs to inspect or change Quirky.'

const firstWord = (entry: ApiCommandEntry) => entry.command.split(' ')[0]

function commandBlocks(commands: ApiCommandEntry[]): string[] {
  const groups = new Map<string, ApiCommandEntry[]>()
  for (const entry of commands) {
    const group = firstWord(entry)
    groups.set(group, [...(groups.get(group) ?? []), entry])
  }
  return [...groups.keys()].sort(byText).flatMap((group) => [
    `### ${group}`,
    '',
    '```text',
    ...groups.get(group)!.map((entry) => `quirky ${entry.usage}  ${entry.summary}`.trimEnd()),
    '```',
    ''
  ])
}

/**
 * The agent skill (`SKILL.md`) for the live catalog: how to discover commands, the output and exit
 * conventions, and one line per active command. The same catalog always renders the same bytes.
 */
export function renderSkill(catalog: ApiCatalog): string {
  const active = catalog.commands.filter((entry) => !entry.shadowedBy).sort(compareEntries)
  const lines = [
    '---',
    'name: quirky',
    `description: ${DESCRIPTION}`,
    '---',
    '',
    '# Quirky CLI',
    '',
    '## Discovering commands',
    '',
    '- `quirky api --json` lists every method and command with its arguments.',
    '- `quirky <command> --help` shows one command: usage, arguments and options.',
    '- `quirky api call <method>` calls any method, with flags taken from its params schema.',
    '',
    '## Conventions',
    '',
    '- `--json` prints one JSON document.',
    '- Under `--json`, errors are `{"error":{"code","message"}}` on stdout.',
    '- Exit codes: 0 ok, 1 runtime error, 2 usage error.',
    '- `--yes` confirms a destructive command without asking in Quirky; without it the command waits for the answer there.',
    '- `--retry-request <id>` sends every call under that request ID, so repeating a command whose reply was lost returns the first outcome instead of running again.',
    '- `quirky --version` prints the CLI version without contacting the daemon.',
    '',
    '## Commands',
    '',
    ...commandBlocks(active)
  ]
  return `${lines.join('\n').trimEnd()}\n`
}
