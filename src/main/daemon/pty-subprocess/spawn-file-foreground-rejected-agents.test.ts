import { describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import { resolveSpawnFileForegroundFromRows } from './spawn-file-foreground-process'

const root: ProcessTableRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  tpgid: 101,
  tty: 'pts/test',
  stat: 'S',
  startTime: 'shell-start',
  command: '/bin/zsh'
}

describe('POSIX static-name agent selection', () => {
  it('does not pick a rejected sibling agent by its executable basename', () => {
    expect(
      resolveSpawnFileForegroundFromRows(
        [
          root,
          { ...root, pid: 101, ppid: 100, pgid: 101, stat: 'S+', command: 'claude' },
          { ...root, pid: 102, ppid: 100, pgid: 101, stat: 'S+', command: 'codex' }
        ],
        100
      )
    ).toEqual({ available: true, processName: null })
  })

  it('does not promote a headless one-shot agent from its executable basename', () => {
    expect(
      resolveSpawnFileForegroundFromRows(
        [
          root,
          { ...root, pid: 101, ppid: 100, pgid: 101, stat: 'S+', command: 'claude -p "review"' }
        ],
        100
      )
    ).toEqual({ available: true, processName: null })
  })

  it.each(['vim', 'npm', 'sleep'])('retains the ordinary %s name', (command) => {
    expect(
      resolveSpawnFileForegroundFromRows(
        [root, { ...root, pid: 101, ppid: 100, pgid: 101, stat: 'S+', command }],
        100
      )
    ).toEqual({ available: true, processName: command })
  })
})
