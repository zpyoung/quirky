import type { GitExecOptions } from './git-exec-options'
import type { ResolvedCommand } from './resolved-command'

export function resolveGitCommand(args: string[], options: GitExecOptions): ResolvedCommand {
  return { binary: 'git', args, cwd: options.cwd }
}
