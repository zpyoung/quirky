import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BundledRipgrepPath from '../ripgrep/bundled-ripgrep-path'

const {
  handleMock,
  resolveAuthorizedPathMock,
  bundledRipgrepCommandMock,
  getLocalGitOptionsForRegisteredWorktreeMock,
  spawnMock,
  parseWslPathMock,
  toWindowsWslPathMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  bundledRipgrepCommandMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn(),
  spawnMock: vi.fn(),
  parseWslPathMock: vi.fn((_value: string): { distro: string } | null => null),
  toWindowsWslPathMock: vi.fn((value: string) => value)
}))

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => '/quirky-test-user-data' },
  ipcMain: {
    handle: handleMock
  },
  shell: {
    trashItem: vi.fn()
  }
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn()
}))

vi.mock('../ripgrep/bundled-ripgrep-spawn', () => ({
  spawnBundledRipgrep: (args: string[], options: unknown) =>
    spawnMock(bundledRipgrepCommandMock(), args, options)
}))

vi.mock('../wsl', () => ({
  parseWslPath: parseWslPathMock,
  toWindowsWslPath: toWindowsWslPathMock
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('./filesystem-path-containment', () => ({
  isENOENT: vi.fn(() => false),
  validateGitRelativeFilePath: vi.fn((value: string) => value)
}))

vi.mock('./registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: vi.fn(async (value: string) => value)
}))

vi.mock('./filesystem-list-files', () => ({
  listQuickOpenFiles: vi.fn()
}))

vi.mock('./filesystem-mutations', () => ({
  registerFilesystemMutationHandlers: vi.fn()
}))

vi.mock('../ripgrep/bundled-ripgrep-path', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledRipgrepPath>()),
  bundledRipgrepCommand: bundledRipgrepCommandMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

vi.mock('./markdown-documents', () => ({
  listMarkdownDocuments: vi.fn()
}))

import { registerFilesystemHandlers } from './filesystem'

function createMockProcess(): ChildProcess {
  const p = new EventEmitter() as unknown as ChildProcess
  ;(p as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (p as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(p as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(p as unknown as Record<string, unknown>).kill = vi.fn()
  return p
}

const BUNDLED_ERROR = "Quirky's bundled search tool (ripgrep) could not start"

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}

describe('filesystem rg search timeout', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })
    resolveAuthorizedPathMock.mockImplementation(async (value: string) => value)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
    parseWslPathMock.mockReturnValue(null)
    bundledRipgrepCommandMock.mockImplementation((options?: { wsl?: boolean }) =>
      options?.wsl ? '/bundled/linux/rg' : '/bundled/rg'
    )
  })

  it('rejects a synchronous launch failure without invoking child cleanup', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all store access is mocked for this handler.
    registerFilesystemHandlers({} as never)
    await expect(
      handlers.get('fs:search')!(
        { sender: { id: 7 } },
        {
          rootPath: '/repo',
          query: 'needle'
        }
      )
    ).rejects.toThrow('EMFILE')
  })

  it('settles and detaches when rg ignores the timeout kill', async () => {
    vi.useFakeTimers()

    try {
      const child = createMockProcess()
      spawnMock.mockReturnValue(child)
      registerFilesystemHandlers({} as never)

      const promise = handlers.get('fs:search')!(
        { sender: { id: 7 } },
        { rootPath: '/repo', query: 'ok' }
      ) as Promise<{ truncated: boolean }>

      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      await vi.runOnlyPendingTimersAsync()

      const result = await promise
      expect(result.truncated).toBe(true)
      expect(spawnMock.mock.calls[0]?.[0]).toBe('/bundled/rg')
      expect(bundledRipgrepCommandMock).toHaveBeenCalled()
      expect(child.kill).toHaveBeenCalled()
      expect((child.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((child.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['error-first', 'close-first'] as const)(
    'rejects with the bundled-ripgrep error when a native launch failure is %s',
    async (order) => {
      const child = createMockProcess()
      Object.defineProperty(child, 'pid', { value: undefined })
      Object.defineProperties(child, { stdout: { value: undefined }, stderr: { value: undefined } })
      spawnMock.mockReturnValue(child)
      registerFilesystemHandlers({} as never)

      // Why a root that exists: an ENOENT spawn failure is also what a vanished workspace looks
      // like, so this stays about the binary only while the search root is reachable.
      resolveAuthorizedPathMock.mockImplementation(async () => process.cwd())
      const promise = handlers.get('fs:search')!(
        { sender: { id: 7 } },
        { rootPath: '/repo', query: 'ok' }
      ) as Promise<unknown>
      await flushMicrotasks()
      const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
      if (order === 'error-first') {
        expect(() => child.emit('error', error)).not.toThrow()
        child.emit('close', -2, null)
      } else {
        child.emit('close', -2, null)
        expect(() => child.emit('error', error)).not.toThrow()
      }

      await expect(promise).rejects.toThrow(BUNDLED_ERROR)
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    }
  )

  it('rejects post-spawn errors instead of returning an empty result', async () => {
    const child = createMockProcess()
    Object.defineProperty(child, 'pid', { value: 1 })
    spawnMock.mockReturnValue(child)
    registerFilesystemHandlers({} as never)

    const promise = handlers.get('fs:search')!(
      { sender: { id: 7 } },
      { rootPath: '/repo', query: 'ok' }
    ) as Promise<{ files: unknown[] }>
    await flushMicrotasks()
    child.emit('error', new Error('post-spawn failure'))

    await expect(promise).rejects.toThrow('post-spawn failure')
  })

  // Why close(97): the WSL wrapper's "cd failed" code. It is above rg's own 0/1/2, so a handler
  // that checks it after the unavailable branch reports a broken install instead.
  it('names the unreachable root when the WSL wrapper cannot enter it', async () => {
    const child = createMockProcess()
    Object.defineProperty(child, 'pid', { value: 1 })
    spawnMock.mockReturnValue(child)
    registerFilesystemHandlers({} as never)

    const promise = handlers.get('fs:search')!(
      { sender: { id: 7 } },
      { rootPath: '/repo', query: 'ok' }
    ) as Promise<unknown>
    await flushMicrotasks()
    child.emit('close', 97, null)

    await expect(promise).rejects.toThrow('Search root is not reachable: /repo')
  })

  it("rejects when a native launcher exits outside ripgrep's contract", async () => {
    const child = createMockProcess()
    Object.defineProperty(child, 'pid', { value: 1 })
    spawnMock.mockReturnValue(child)
    registerFilesystemHandlers({} as never)

    const promise = handlers.get('fs:search')!(
      { sender: { id: 7 } },
      { rootPath: '/repo', query: 'ok' }
    ) as Promise<unknown>
    await flushMicrotasks()
    child.emit('close', 127, null)

    await expect(promise).rejects.toThrow(BUNDLED_ERROR)
  })
})
