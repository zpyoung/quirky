import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendLoopLogLine,
  createLocalLoopFilesystem,
  ensureLoopNotesFile,
  formatLoopLogLine,
  type LoopNotesTarget
} from './loop-notes-file'

const execFileAsync = promisify(execFile)

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) {
      env[key] = value
    }
  }
  return env
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('git', args, { cwd, env: cleanGitEnv() })
}

describe('loop notes file', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'quirky-loop-notes-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function gitTarget(): LoopNotesTarget {
    return {
      kind: 'git',
      workspacePath: root,
      pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
      fs: createLocalLoopFilesystem(),
      runGit: (args) => git(root, args)
    }
  }

  function folderTarget(): LoopNotesTarget {
    return { ...gitTarget(), kind: 'folder', runGit: null }
  }

  it('creates the notes file in a git workspace and excludes the loops directory once', async () => {
    await git(root, ['init', '-q'])
    const target = gitTarget()

    const first = await ensureLoopNotesFile(target, 'my-loop')
    await ensureLoopNotesFile(target, 'my-loop')

    expect((await stat(first.notesPath)).isFile()).toBe(true)
    expect(first.notesPath).toBe(join(root, '.quirky', 'loops', 'my-loop', 'notes.md'))
    const exclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((line) => line === '/.quirky/loops/')).toHaveLength(1)
    await expect(stat(join(root, '.gitignore'))).rejects.toThrow()
    const status = await git(root, ['status', '--porcelain'])
    expect(status.stdout).toBe('')
  })

  it('fails for a git workspace when the exclude entry cannot be installed', async () => {
    const failing: LoopNotesTarget = {
      ...gitTarget(),
      runGit: async () => {
        throw new Error('git unavailable')
      }
    }

    await expect(ensureLoopNotesFile(failing, 'my-loop')).rejects.toThrow('git unavailable')
    await expect(ensureLoopNotesFile({ ...failing, runGit: null }, 'my-loop')).rejects.toThrow(
      'cannot be excluded'
    )
  })

  it('keeps existing notes content on a second ensure', async () => {
    await git(root, ['init', '-q'])
    const target = gitTarget()
    const { notesPath } = await ensureLoopNotesFile(target, 'my-loop')
    await target.fs.writeFile(notesPath, 'agent wrote this\n')

    await ensureLoopNotesFile(target, 'my-loop')

    expect(await readFile(notesPath, 'utf8')).toBe('agent wrote this\n')
  })

  it('appends the exclude line after an existing exclude without a trailing newline', async () => {
    await git(root, ['init', '-q'])
    const excludePath = join(root, '.git', 'info', 'exclude')
    const target = gitTarget()
    await target.fs.writeFile(excludePath, '*.tmp')

    await ensureLoopNotesFile(target, 'my-loop')

    expect(await readFile(excludePath, 'utf8')).toBe('*.tmp\n/.quirky/loops/\n')
  })

  it('writes only the notes file in a folder workspace', async () => {
    const target = folderTarget()

    const { notesPath } = await ensureLoopNotesFile(target, 'my-loop')

    expect((await stat(notesPath)).isFile()).toBe(true)
    await expect(stat(join(root, '.git'))).rejects.toThrow()
    await expect(stat(join(root, '.gitignore'))).rejects.toThrow()
  })

  it('appends one log line per call', async () => {
    const target = folderTarget()
    await ensureLoopNotesFile(target, 'my-loop')

    const first = await appendLoopLogLine(target, 'my-loop', {
      n: 1,
      endReason: 'settled',
      checkPass: true,
      added: 4,
      removed: 1,
      costUsd: 0.42
    })
    const second = await appendLoopLogLine(target, 'my-loop', {
      n: 2,
      endReason: 'crashed',
      checkPass: null,
      added: null,
      removed: null,
      costUsd: null
    })

    expect(first && second).toBe(true)
    const log = await readFile(join(root, '.quirky', 'loops', 'my-loop', 'log.md'), 'utf8')
    const lines = log.split('\n').filter(Boolean)
    expect(lines).toEqual([
      formatLoopLogLine({
        n: 1,
        endReason: 'settled',
        checkPass: true,
        added: 4,
        removed: 1,
        costUsd: 0.42
      }),
      formatLoopLogLine({
        n: 2,
        endReason: 'crashed',
        checkPass: null,
        added: null,
        removed: null,
        costUsd: null
      })
    ])
    expect(lines[0]).toContain('1')
    expect(lines[0]).toContain('settled')
    expect(lines[0]).toContain('+4')
    expect(lines[0]).toContain('-1')
    expect(lines[0]).toContain('$0.42')
  })

  it('prints skipped ticks only when some were skipped', () => {
    const base = { n: 3, endReason: 'settled', checkPass: null, added: null, removed: null }

    expect(formatLoopLogLine({ ...base, costUsd: null, skippedTicks: 2 })).toMatch(
      / \| skipped 2 ticks$/
    )
    expect(formatLoopLogLine({ ...base, costUsd: null, skippedTicks: 0 })).not.toContain('skipped')
    expect(formatLoopLogLine({ ...base, costUsd: null })).not.toContain('skipped')
  })

  it('returns false instead of throwing when the log cannot be written', async () => {
    const target = folderTarget()
    target.fs = {
      ...target.fs,
      writeFile: async () => {
        throw new Error('disk full')
      }
    }
    await expect(
      appendLoopLogLine(target, 'my-loop', {
        n: 1,
        endReason: 'settled',
        checkPass: null,
        added: null,
        removed: null,
        costUsd: null
      })
    ).resolves.toBe(false)
  })
})
