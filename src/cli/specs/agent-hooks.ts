import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'hooks', 'prepare-codex'],
    summary: "Prepare a WSL pane's Quirky-managed Codex home before a shell launch",
    usage: 'quirky agent hooks prepare-codex',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether Quirky-managed agent status hooks are enabled',
    usage: 'quirky agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['quirky agent hooks status', 'quirky agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable Quirky-managed agent status hooks and remove local hook entries',
    usage: 'quirky agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['quirky agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable Quirky-managed agent status hooks',
    usage: 'quirky agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['quirky agent hooks on']
  }
]
