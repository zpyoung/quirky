import { expect, spyOn, test } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { Readable } from 'node:stream'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FolderEntry, FolderObservation, TaskBaseline, WorkspaceKind } from '../src/folder-workspace'
import { captureFolderObservation, isTaskBaseline } from '../src/folder-workspace'

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'objective-folder-workspace-'))
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeWorkspaceFile(root: string, path: string, content: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

test('folder observations are deterministic, byte-sorted, and independent of timestamps and empty directories', async () => {
  await withWorkspace(async firstRoot => withWorkspace(async secondRoot => {
    const files = [
      ['space name.txt', 'space'],
      ['tab\tname.txt', 'tab'],
      ['line\nbreak.txt', 'newline'],
      ['unicode/é.txt', 'accent'],
      ['unicode/雪.txt', 'snow']
    ] as const

    for (const [path, content] of files) writeWorkspaceFile(firstRoot, path, content)
    for (const [path, content] of [...files].reverse()) writeWorkspaceFile(secondRoot, path, content)
    mkdirSync(join(secondRoot, 'empty', 'nested'), { recursive: true })
    utimesSync(join(firstRoot, 'space name.txt'), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
    utimesSync(join(secondRoot, 'space name.txt'), new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'))

    const first: FolderObservation = await captureFolderObservation(firstRoot)
    const second: FolderObservation = await captureFolderObservation(secondRoot)
    const baseline: TaskBaseline = first
    const kind: WorkspaceKind = 'folder'

    expect(kind).toBe('folder')
    expect(isTaskBaseline(baseline)).toBe(true)
    expect(second).toEqual(first)
    expect(first.contentIdentity).toMatch(/^objective-folder-v1:[0-9a-f]{64}$/)
    expect(first.entries.map(entry => entry.path)).toEqual(first.entries.map(entry => entry.path).sort(compareUtf8))
    const actualPaths = first.entries.map(entry => entry.path.normalize('NFC')).sort(compareUtf8)
    const expectedEntries = files.map(([path, content]) => ({ path: path.normalize('NFC'), digest: sha256(content) }))
      .sort((left, right) => compareUtf8(left.path, right.path))
    const actualEntries = first.entries.map(({ path, digest }) => ({ path: path.normalize('NFC'), digest }))
      .sort((left, right) => compareUtf8(left.path, right.path))
    expect(actualPaths).toEqual(expectedEntries.map(entry => entry.path))
    expect(actualEntries).toEqual(expectedEntries)
  }))
})
test('large regular files are observed asynchronously with exact streamed byte digests', async () => {
  await withWorkspace(async root => {
    const file = join(root, 'large.bin')
    const descriptor = openSync(file, 'w')
    const chunk = Buffer.alloc(64 * 1024, 0xa5)
    const expectedDigest = createHash('sha256')
    try {
      for (let written = 0; written < 128; written++) {
        writeSync(descriptor, chunk)
        expectedDigest.update(chunk)
      }
    } finally {
      closeSync(descriptor)
    }

    let settled = false
    const observationPromise = captureFolderObservation(root).finally(() => { settled = true })
    const nextTurn = Promise.withResolvers<void>()
    setImmediate(nextTurn.resolve)
    await nextTurn.promise
    expect(settled).toBe(false)

    const observation = await observationPromise
    expect(observation.entries).toEqual([{
      path: 'large.bin', kind: 'file', executable: false, digest: expectedDigest.digest('hex')
    }])
  })
})
 
test('folder observation uses the selected root beneath a Git repository without consulting its index', async () => {
  await withWorkspace(async parent => {
    writeWorkspaceFile(parent, '.git', 'not-a-valid-gitdir')
    const workspace = join(parent, 'nested-folder')
    mkdirSync(workspace)
    writeWorkspaceFile(workspace, 'source.ts', 'folder content')

    const observation = await captureFolderObservation(workspace)
    expect(observation.entries.map(entry => entry.path)).toEqual(['source.ts'])
  })
})

test('folder observations are deterministic and exclude only private reports and Git metadata', async () => {
  await withWorkspace(async root => {
    writeWorkspaceFile(root, '.gitignore', 'ignored.tmp\nnode_modules/\n.hidden\n')
    writeWorkspaceFile(root, '.git/config', 'root git metadata')
    writeWorkspaceFile(root, 'nested/.git/HEAD', 'nested git metadata')
    writeWorkspaceFile(root, 'nested/project/source.ts', 'tracked-looking source')
    writeWorkspaceFile(root, 'worktree/.git', 'gitdir: /unused/admin')
    writeWorkspaceFile(root, 'worktree/source.ts', 'nested Git worktree source')
    writeWorkspaceFile(root, '.hidden', 'hidden user file')
    writeWorkspaceFile(root, 'ignored.tmp', 'gitignore match')
    writeWorkspaceFile(root, 'node_modules/pkg/index.js', 'dependency directory')
    writeWorkspaceFile(root, '.quirky/config.json', 'user configuration')
    writeWorkspaceFile(root, '.quirky/objective-other/file', 'near-miss report path')
    writeWorkspaceFile(root, 'nested/.quirky/objective/file', 'nested user content')

    const beforeReports = await captureFolderObservation(root)
    const beforePaths = beforeReports.entries.map(entry => entry.path)
    expect(beforePaths).toContain('.gitignore')
    expect(beforePaths).toContain('.hidden')
    expect(beforePaths).toContain('ignored.tmp')
    expect(beforePaths).toContain('node_modules/pkg/index.js')
    expect(beforePaths).toContain('.quirky/config.json')
    expect(beforePaths).toContain('.quirky/objective-other/file')
    expect(beforePaths).toContain('nested/.quirky/objective/file')
    expect(beforePaths).toContain('nested/project/source.ts')
    expect(beforePaths).toContain('worktree/source.ts')
    expect(beforePaths).not.toContain('.git/config')
    expect(beforePaths).not.toContain('nested/.git/HEAD')
    expect(beforePaths).not.toContain('worktree/.git')

    writeWorkspaceFile(root, '.quirky/objective/report.json', 'first report')
    writeWorkspaceFile(root, '.quirky/objective/temp-report/attempt.json', 'first temporary report')
    const afterCreate = await captureFolderObservation(root)
    expect(afterCreate.contentIdentity).toBe(beforeReports.contentIdentity)

    writeWorkspaceFile(root, '.quirky/objective/report.json', 'replaced report')
    renameSync(join(root, '.quirky/objective/report.json'), join(root, '.quirky/objective/renamed-report.json'))
    writeWorkspaceFile(root, '.quirky/objective/temp-report/attempt.json', 'replaced temporary report')
    const afterReplaceAndRename = await captureFolderObservation(root)
    expect(afterReplaceAndRename.contentIdentity).toBe(beforeReports.contentIdentity)

    rmSync(join(root, '.quirky/objective'), { recursive: true, force: true })
    const afterDelete = await captureFolderObservation(root)
    expect(afterDelete.contentIdentity).toBe(beforeReports.contentIdentity)
  })
})

test('folder observations hash symlink targets without following file or directory links', async () => {
  await withWorkspace(async root => withWorkspace(async outside => {
    const targetFile = join(outside, 'target.txt')
    const otherTargetFile = join(outside, 'other-target.txt')
    const targetDirectory = join(outside, 'linked-directory')
    writeFileSync(targetFile, 'external target contents')
    writeFileSync(otherTargetFile, 'different external contents')
    mkdirSync(targetDirectory)
    writeFileSync(join(targetDirectory, 'secret.txt'), 'must not be observed through the link')

    const fileLink = join(root, 'file-link')
    const directoryLink = join(root, 'directory-link')
    symlinkSync(targetFile, fileLink)
    symlinkSync(targetDirectory, directoryLink)

    const first = await captureFolderObservation(root)
    const linkEntry: FolderEntry | undefined = first.entries.find(entry => entry.path === 'file-link')
    expect(linkEntry).toEqual({
      path: 'file-link', kind: 'symlink', executable: false, digest: sha256(Buffer.from(readlinkSync(fileLink), 'utf8'))
    })
    expect(first.entries.map(entry => entry.path)).toEqual(['directory-link', 'file-link'])
    expect(first.entries.some(entry => entry.path.startsWith('directory-link/'))).toBe(false)

    writeFileSync(targetFile, 'external target contents changed')
    const changedOutsideContents = await captureFolderObservation(root)
    expect(changedOutsideContents.contentIdentity).toBe(first.contentIdentity)

    unlinkSync(fileLink)
    symlinkSync(otherTargetFile, fileLink)
    const changedLinkTarget = await captureFolderObservation(root)
    expect(changedLinkTarget.contentIdentity).not.toBe(first.contentIdentity)
    expect(changedLinkTarget.entries.find(entry => entry.path === 'file-link')?.digest)
      .toBe(sha256(Buffer.from(readlinkSync(fileLink), 'utf8')))
  }))
})

test('content, executable mode, type, additions, deletions, and renames change folder identity', async () => {
  await withWorkspace(async root => {
    const initialEmpty = await captureFolderObservation(root)
    mkdirSync(join(root, 'empty-only'))
    expect((await captureFolderObservation(root)).contentIdentity).toBe(initialEmpty.contentIdentity)

    const file = join(root, 'item')
    writeFileSync(file, 'first bytes')
    const added = await captureFolderObservation(root)
    expect(added.contentIdentity).not.toBe(initialEmpty.contentIdentity)

    writeFileSync(file, 'different bytes')
    const changedContent = await captureFolderObservation(root)
    expect(changedContent.contentIdentity).not.toBe(added.contentIdentity)

    chmodSync(file, 0o644)
    const nonExecutable = await captureFolderObservation(root)
    chmodSync(file, 0o744)
    const executable = await captureFolderObservation(root)
    expect(nonExecutable.entries.find(entry => entry.path === 'item')?.executable).toBe(false)
    expect(executable.entries.find(entry => entry.path === 'item')?.executable).toBe(true)
    expect(executable.contentIdentity).not.toBe(nonExecutable.contentIdentity)

    const beforeRename = await captureFolderObservation(root)
    renameSync(file, join(root, 'renamed item'))
    const afterRename = await captureFolderObservation(root)
    expect(afterRename.contentIdentity).not.toBe(beforeRename.contentIdentity)
    expect(beforeRename.entries.map(entry => entry.path)).toContain('item')
    expect(afterRename.entries.map(entry => entry.path)).toEqual(['renamed item'])

    unlinkSync(join(root, 'renamed item'))
    const afterDelete = await captureFolderObservation(root)
    expect(afterDelete.contentIdentity).not.toBe(afterRename.contentIdentity)
    expect(afterDelete.contentIdentity).toBe(initialEmpty.contentIdentity)
  })
})

test('a regular file and a symlink with the same target bytes have different identities', async () => {
  await withWorkspace(async root => {
    const path = join(root, 'same-name')
    writeFileSync(path, 'target-name')
    const regularFile = await captureFolderObservation(root)
    expect(regularFile.entries[0]).toEqual({
      path: 'same-name', kind: 'file', executable: false, digest: sha256('target-name')
    })

    unlinkSync(path)
    symlinkSync('target-name', path)
    const symlink = await captureFolderObservation(root)
    expect(symlink.entries[0]).toEqual({
      path: 'same-name', kind: 'symlink', executable: false, digest: sha256('target-name')
    })
    expect(symlink.contentIdentity).not.toBe(regularFile.contentIdentity)
  })
})

test('baseline validation accepts typed baselines and rejects malformed, aliased, excluded, duplicate, unsorted, and stale manifests', async () => {
  await withWorkspace(async root => {
    writeWorkspaceFile(root, 'a', 'one')
    writeWorkspaceFile(root, 'b', 'two')
    const baseline = await captureFolderObservation(root)
    expect(isTaskBaseline(baseline)).toBe(true)
    const unknownBaseline: unknown = baseline
    expect(isTaskBaseline(unknownBaseline)).toBe(true)
    if (isTaskBaseline(unknownBaseline)) {
      const validated: TaskBaseline = unknownBaseline
      expect(validated).toEqual(baseline)
    }
    expect(isTaskBaseline({ kind: 'git', treeOid: 'a'.repeat(40) } satisfies TaskBaseline)).toBe(true)

    const reversed = { ...baseline, entries: [...baseline.entries].reverse() }
    const duplicate = { ...baseline, entries: [...baseline.entries, baseline.entries[0]] }
    const staleIdentity = { ...baseline, contentIdentity: 'objective-folder-v1:' + '0'.repeat(64) }
    const malformedDigest = {
      ...baseline,
      entries: baseline.entries.map((entry, index) => index === 0 ? { ...entry, digest: 'not-a-sha256' } : entry)
    }
    const excludedPath = {
      ...baseline,
      entries: [...baseline.entries, { path: '.git/config', kind: 'file', executable: false, digest: sha256('git') }]
    }
    const unsafePaths = ['./a', '../a', '/absolute', 'a//b', 'dir\\file', '\ud800']
      .map(path => ({ ...baseline, entries: [{ path, kind: 'file', executable: false, digest: sha256('x') }] }))

    for (const invalid of [
      null,
      undefined,
      {},
      { kind: 'folder', version: 2, contentIdentity: baseline.contentIdentity, entries: baseline.entries },
      reversed,
      duplicate,
      staleIdentity,
      malformedDigest,
      excludedPath,
      { ...baseline, entries: baseline.entries.map((entry, index) => index === 0 ? { ...entry, executable: 'false' } : entry) },
      { ...baseline, entries: baseline.entries.map((entry, index) => index === 0 ? { ...entry, path: '.quirky/objective/report.json' } : entry) },
      { ...baseline, entries: baseline.entries.map((entry, index) => index === 0 ? { ...entry, kind: 'symlink', executable: true } : entry) },
    ]) expect(isTaskBaseline(invalid)).toBe(false)
  })
})

test('unreadable files fail observation closed with folder-tree-unavailable', async () => {
  await withWorkspace(async root => {
    const file = join(root, 'unreadable')
    writeFileSync(file, 'cannot be used as partial evidence')
    chmodSync(file, 0)
    try {
      await expect(captureFolderObservation(root)).rejects.toThrow('folder-tree-unavailable')
    } finally {
      chmodSync(file, 0o600)
    }
  })
})

test('unsupported special files fail observation closed', async () => {
  await withWorkspace(async root => {
    const socketPath = join(root, 'special.sock')
    const server = createServer()
    const listening = Promise.withResolvers<void>()
    server.once('error', listening.reject)
    server.listen(socketPath, listening.resolve)
    await listening.promise
    try {
      await expect(captureFolderObservation(root)).rejects.toThrow('folder-tree-unsupported-entry')
    } finally {
      const closed = Promise.withResolvers<void>()
      server.close(() => closed.resolve())
      await closed.promise
    }
  })
})

test('path replacement and streamed read errors fail folder observations closed', async () => {
  const originalOpen = fsPromises.open
  await withWorkspace(async root => {
    const file = join(root, 'changing.bin')
    const replacement = join(root, '.quirky/objective/replacement.bin')
    writeFileSync(file, 'original file bytes')
    writeWorkspaceFile(root, '.quirky/objective/replacement.bin', 'replacement file bytes')

    const open = spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === file) renameSync(replacement, file)
      return handle
    })
    try {
      await expect(captureFolderObservation(root)).rejects.toThrow('folder-tree-unstable')
    } finally {
      open.mockRestore()
    }
  })

  await withWorkspace(async root => {
    const file = join(root, 'unreadable-stream.bin')
    writeFileSync(file, 'read failure')

    const open = spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === file) {
        handle.createReadStream = (() => new Readable({
          read() {
            this.destroy(Object.assign(new Error('simulated read failure'), { code: 'EIO' }))
          }
        })) as FileHandle['createReadStream']
      }
      return handle
    })
    try {
      await expect(captureFolderObservation(root)).rejects.toThrow('folder-tree-unavailable')
    } finally {
      open.mockRestore()
    }
  })
})
