import type * as pty from 'node-pty'
import { confirmShellForegroundProcess } from '../../providers/agent-foreground-process'

/** Fresh execution-host proof that the spawned shell owns the PTY foreground:
 *  a post-request process inspection (POSIX `ps`), never cached state. */
export async function confirmPtyShellForeground(args: {
  process: pty.IPty
  shellPath: string | undefined
  isDead: () => boolean
}): Promise<boolean> {
  if (args.isDead() || !args.process.pid) {
    return false
  }
  const confirmed = await confirmShellForegroundProcess(args.process.pid, args.shellPath)
  return !args.isDead() && confirmed
}
