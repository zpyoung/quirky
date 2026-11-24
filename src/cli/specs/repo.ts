import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const REPO_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['repo', 'list'],
    summary: 'List repos registered in Quirky',
    usage: 'quirky repo list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a project to Quirky by filesystem path',
    usage: 'quirky repo add --path <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path']
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'quirky repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set'],
    summary: 'Set whether non-Quirky worktrees are shown for a repo',
    usage:
      'quirky repo set --repo <selector> --external-worktree-visibility show|hide|inherit [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'external-worktree-visibility'],
    notes: [
      'show and hide override the global non-Quirky worktree visibility default for this repo; inherit clears the override.',
      'Per-worktree visibility rules still apply.'
    ],
    examples: [
      'quirky repo set --repo path:/path/to/repo --external-worktree-visibility show --json'
    ]
  },
  {
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'quirky repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'quirky repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  }
]
