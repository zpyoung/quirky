import type { Command } from './commands/types'

export type FlagSpec = {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'json'
  description: string
  required?: boolean
  repeatable?: boolean
  enum?: readonly (string | number)[]
}

export type PositionalSpec = { name: string; description: string; required: boolean }

type Declared = Pick<Command, 'name' | 'summary' | 'positionals' | 'flags'>

/** The flag's value placeholder: enum values joined by `|`, else the type in angle brackets; none for a switch. */
function placeholder(spec: FlagSpec): string {
  if (spec.enum) return spec.enum.join('|')
  return spec.type === 'boolean' ? '' : `<${spec.type}>`
}

function flagLabel(name: string, spec: FlagSpec): string {
  return [`--${name}`, placeholder(spec)].filter(Boolean).join(' ')
}

/** The one-line synopsis of a command, e.g. `wt create <repoId> <name> [--base <string>]`; global flags are left out. */
export function usageOf(command: Declared): string {
  const positionals = command.positionals.map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`))
  const flags = Object.entries(command.flags).map(([name, spec]) => {
    const label = flagLabel(name, spec)
    const group = spec.required ? label : `[${label}]`
    return spec.repeatable ? `${group}...` : group
  })
  return [command.name, ...positionals, ...flags].join(' ')
}

/** The full help block for one command: usage, summary, arguments, one line per flag, and the global flags. */
export function commandHelp(command: Declared): string {
  const lines = [`usage: quirky ${usageOf(command)}`, '', command.summary]
  if (command.positionals.length) {
    const labels = command.positionals.map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`))
    const width = Math.max(...labels.map((label) => label.length))
    lines.push('', 'arguments:')
    command.positionals.forEach((p, i) => lines.push(`  ${labels[i].padEnd(width)}  ${p.description}`))
  }
  const flags = Object.entries(command.flags)
  if (flags.length) {
    const labels = flags.map(([name, spec]) => flagLabel(name, spec) + (spec.repeatable ? '...' : ''))
    const width = Math.max(...labels.map((label) => label.length))
    lines.push('', 'options:')
    flags.forEach(([, spec], i) => {
      const required = spec.required ? 'required' : ''
      lines.push(`  ${labels[i].padEnd(width)}  ${required.padEnd('required'.length)}  ${spec.description}`.trimEnd())
    })
  }
  lines.push('', 'global: --json prints machine-readable JSON')
  return lines.join('\n')
}
