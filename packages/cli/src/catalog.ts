import { BUILTIN_PLUGIN_PREFIX } from '@quirky/protocol'
import type { Command } from './commands/types'

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

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
