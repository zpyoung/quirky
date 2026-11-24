import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

type SpawnSpec = { program: string; args?: readonly string[]; env?: NodeJS.ProcessEnv }
const spawned = vi.hoisted(() => {
  const specs: SpawnSpec[] = []
  return { specs }
})

vi.mock('@quirky/process-host', () => ({
  spawnProcess: (spec: SpawnSpec) => {
    spawned.specs.push(spec)
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      kill: vi.fn()
    })
    queueMicrotask(() => child.emit('close', 0))
    return child
  }
}))
vi.mock('../codex-cli/command', () => ({ resolveClaudeCommand: () => 'claude' }))

import { runClaudeCommandProcess } from './claude-command-process'

const originalPlatform = process.platform
afterEach(() => {
  spawned.specs.length = 0
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('runClaudeCommandProcess', () => {
  it("logs in on the host with CLAUDE_CONFIG_DIR set to the account's folder", async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await runClaudeCommandProcess(
      ['auth', 'login', '--claudeai'],
      { windowsPath: '/data/claude-profiles/a/home', linuxPath: null, wslDistro: null },
      1000
    )
    expect(spawned.specs[0]).toMatchObject({
      program: 'claude',
      args: ['auth', 'login', '--claudeai']
    })
    expect(spawned.specs[0].env?.CLAUDE_CONFIG_DIR).toBe('/data/claude-profiles/a/home')
  })

  it('hands BROWSER to a host login', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await runClaudeCommandProcess(
      ['auth', 'login', '--claudeai'],
      { windowsPath: '/data/a/home', linuxPath: null, wslDistro: null },
      1000,
      { browser: '/data/a/home/.quirky-sign-in-browser' }
    )
    expect(spawned.specs[0].env?.BROWSER).toBe('/data/a/home/.quirky-sign-in-browser')
  })
})
