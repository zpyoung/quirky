import { BUILTIN_PLUGIN_PREFIX, type ApiCatalog, type ApiCommandEntry, type ApiDescription } from '@quirky/protocol'
import { usageOf } from './command-spec'
import type { Command } from './commands/types'

export const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function rank(command: Command): number {
  return command.plugin?.startsWith(BUILTIN_PLUGIN_PREFIX) ? 0 : 1
}

/**
 * Decides which generated commands the CLI can run. A kernel command wins over a generated one
 * with the same name or whose name extends the kernel's words, and an earlier generated command
 * (built-ins first, then by name) wins over a later duplicate. Losers keep `shadowedBy`.
 */
export function resolveCommands(kernel: Command[], generated: Command[]): { active: Command[]; shadowed: Command[] } {
  const sorted = [...generated].sort(
    (a, b) => rank(a) - rank(b) || byText(a.name, b.name) || byText(a.plugin ?? '', b.plugin ?? '')
  )
  const active: Command[] = []
  const shadowed: Command[] = []
  for (const command of sorted) {
    const owner =
      kernel.find((candidate) => candidate.name === command.name) ??
      kernel.find((candidate) => command.name.startsWith(`${candidate.name} `))
    if (owner) {
      shadowed.push({ ...command, shadowedBy: `kernel ${owner.name}` })
      continue
    }
    const earlier = active.find((candidate) => candidate.name === command.name)
    if (earlier) shadowed.push({ ...command, shadowedBy: `${earlier.plugin} ${earlier.name}` })
    else active.push(command)
  }
  return { active, shadowed }
}

function entryOf(command: Command): ApiCommandEntry {
  return {
    command: command.name,
    plugin: command.plugin,
    methods: [...command.methods],
    summary: command.summary,
    usage: usageOf(command),
    positionals: command.positionals.map(({ name, description, required }) => ({ name, description, required })),
    flags: Object.entries(command.flags).map(([name, spec]) => ({
      name,
      type: spec.type,
      description: spec.description,
      required: spec.required === true,
      repeatable: spec.repeatable === true,
      ...(spec.enum ? { enum: [...spec.enum] } : {})
    })),
    ...(command.shadowedBy ? { shadowedBy: command.shadowedBy } : {})
  }
}

/** Orders catalog commands by words, then kernel before plugins, then by plugin ID. */
export function compareEntries(a: ApiCommandEntry, b: ApiCommandEntry): number {
  return byText(a.command, b.command) || Number(a.plugin !== null) - Number(b.plugin !== null) || byText(a.plugin ?? '', b.plugin ?? '')
}

/**
 * The document `quirky api --json` prints: the daemon's description plus every CLI command the
 * kernel, installed plugins and shadowed plugin methods give, so an agent sees what each does and why.
 */
export function buildCatalog(
  description: ApiDescription,
  kernel: Command[],
  resolved: { active: Command[]; shadowed: Command[] }
): ApiCatalog {
  const commands = [...kernel, ...resolved.active, ...resolved.shadowed].map(entryOf).sort(compareEntries)
  return { ...description, commands }
}
