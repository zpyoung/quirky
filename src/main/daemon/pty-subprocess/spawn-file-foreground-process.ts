import type { IPty } from 'node-pty'
import { isShellProcess } from '../../../shared/shell-process-detection'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/command-token-scanner'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../shared/process-table-index'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import {
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot
} from '../../../shared/process-table-snapshot-reader'
import { selectForegroundProcessCandidate } from '../../../shared/foreground-process-selection'
import { resolveOuterWrapperForegroundProcess } from '../../../shared/foreground-wrapper-agent'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import {
  resolveAgentForegroundProcessWithAvailability,
  type AgentForegroundProcessResolution,
  type AgentForegroundResolutionOptions
} from '../../providers/agent-foreground-process'

export function ptyProcessNameIsSpawnFile(proc: IPty): boolean {
  return 'processNameIsSpawnFile' in proc && proc.processNameIsSpawnFile === true
}

export function createPtyForegroundResolver(
  proc: IPty
): typeof resolveAgentForegroundProcessWithAvailability {
  return ptyProcessNameIsSpawnFile(proc)
    ? (_pid, _fallback, options) => resolveSpawnFileForegroundProcess(proc, options)
    : resolveAgentForegroundProcessWithAvailability
}

export function shouldCachePtyForeground(name: string | null, staticName: boolean): name is string {
  return (
    name !== null && (recognizeAgentProcess(name) !== null || (staticName && !isShellProcess(name)))
  )
}

export function resolveSpawnFileForegroundFromRows(
  rows: readonly ProcessTableRow[],
  rootPid: number
): AgentForegroundProcessResolution {
  const index = getProcessTableIndex(rows)
  const root = index.byPid.get(rootPid)
  if (!root || !root.tpgid || root.tpgid < 0 || !root.tty || root.tty === '?') {
    return { available: false, processName: null }
  }
  const tree = [{ ...root, depth: 0 }, ...collectDescendantsFromIndex(index, rootPid)]
  const candidates = tree
    .filter((row) => row.pgid === root.tpgid && row.tty === root.tty && !/[TZ]/.test(row.stat))
    .sort((left, right) => right.depth - left.depth)
  const foreground = candidates[0]
  if (!foreground) {
    return { available: false, processName: null }
  }
  const name = getCommandTokenPathBasename(getFirstCommandToken(foreground.command)).replace(
    /^-/,
    ''
  )
  const selected = selectForegroundProcessCandidate(candidates, tree)
  return {
    available: name.length > 0,
    processName: selected
      ? resolveOuterWrapperForegroundProcess(selected.recognized, selected.candidate, tree)
      : recognizeAgentProcess(name)
        ? null
        : name || null
  }
}

export async function resolveSpawnFileForegroundProcess(
  proc: IPty,
  options: AgentForegroundResolutionOptions = {}
): Promise<AgentForegroundProcessResolution> {
  try {
    const rows = options.fresh
      ? await getFreshProcessTableSnapshot()
      : await getProcessTableSnapshot()
    return resolveSpawnFileForegroundFromRows(rows, proc.pid)
  } catch {
    return { available: false, processName: null }
  }
}
