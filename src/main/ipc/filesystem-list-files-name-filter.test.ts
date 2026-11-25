import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import {
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from '../../shared/file-name-filter-tokens'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('../ripgrep/bundled-ripgrep-spawn', () => ({
  spawnBundledRipgrep: (args: string[], options: unknown) => spawnMock('/bundled/rg', args, options)
}))

import { listQuickOpenFiles } from './filesystem-list-files'

function makeStore(repoPath: string): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing only reads registered repos and settings.
  return {
    getRepos: () => [
      { id: 'repo-1', path: repoPath, displayName: 'repo', badgeColor: '#000', addedAt: 0 }
    ],
    getSettings: () => ({})
  } as unknown as Store
}

function nameFilter(query: string): (relativePath: string) => boolean {
  const tokens = splitFileNameFilterTokens(query)
  return (relativePath) => pathMatchesFileNameFilterTokens(relativePath, tokens)
}

function fakeRipgrep(
  output: string,
  killSignal: NodeJS.Signals | null = null,
  exitCode = 0
): EventEmitter {
  const child = new EventEmitter()
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  Object.assign(child, {
    stdout,
    stderr: new EventEmitter(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
    pid: 1
  })
  setTimeout(() => {
    stdout.emit('data', output)
    child.emit('close', killSignal ? null : exitCode, killSignal)
  }, 0)
  return child
}

describe('listQuickOpenFiles name filter', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('counts only matches against the ripgrep cap', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeRipgrep('a.ts\0b.ts\0c.ts\0ios/AppDelegate.swift\0'))
      .mockImplementationOnce(() => fakeRipgrep(''))

    const files = await listQuickOpenFiles(
      '/repo',
      makeStore('/repo'),
      undefined,
      undefined,
      2,
      undefined,
      nameFilter('app delegate')
    )

    expect(files).toEqual(['ios/AppDelegate.swift'])
  })

  it('rejects with the bundled-ripgrep error when the filtered ignored pass cannot start', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeRipgrep('ios/AppDelegate.swift\0'))
      .mockImplementationOnce(() => fakeRipgrep('', null, -2))

    await expect(
      listQuickOpenFiles(
        '/repo',
        makeStore('/repo'),
        undefined,
        undefined,
        5,
        undefined,
        nameFilter('appdelegate')
      )
    ).rejects.toThrow("Quirky's bundled search tool (ripgrep) could not start")
  })

  it('keeps primary matches when the ignored-file pass fails during a filtered scan', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeRipgrep('ios/AppDelegate.swift\0'))
      .mockImplementationOnce(() => fakeRipgrep('', 'SIGKILL'))

    await expect(
      listQuickOpenFiles(
        '/repo',
        makeStore('/repo'),
        undefined,
        undefined,
        5,
        undefined,
        nameFilter('appdelegate')
      )
    ).resolves.toEqual(['ios/AppDelegate.swift'])
  })

  it('still rejects an ignored-pass failure for unfiltered listings', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeRipgrep('a.ts\0'))
      .mockImplementationOnce(() => fakeRipgrep('', 'SIGKILL'))

    await expect(
      listQuickOpenFiles('/repo', makeStore('/repo'), undefined, undefined, 5)
    ).rejects.toThrow('rg killed by SIGKILL')
  })
})
