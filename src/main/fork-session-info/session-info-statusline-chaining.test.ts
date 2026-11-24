import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  getManagedCommand,
  getStatusLineScriptFileName,
  getStatusLineScriptPath
} from '../claude/hook-settings'
import {
  enableSessionInfoStatusLineChaining,
  finalizeManagedStatusLineRemoval,
  getSessionInfoStatusLineChainStatus,
  removeManagedStatusLine
} from './session-info-statusline-chaining'

let home: string

function settingsPath(): string {
  return join(home, '.claude', 'settings.json')
}

function writeSettings(statusLine?: Record<string, unknown>): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(settingsPath(), `${JSON.stringify(statusLine ? { statusLine } : {}, null, 2)}\n`)
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>
}

describe('session info statusline chaining', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'quirky-session-info-chain-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('reports disabled and available states without exposing the command', () => {
    writeSettings()
    expect(getSessionInfoStatusLineChainStatus().state).toBe('disabled')

    writeSettings({ type: 'command', command: 'private --token secret' })
    const status = getSessionInfoStatusLineChainStatus()
    expect(status).toEqual({ state: 'available' })
    expect(JSON.stringify(status)).not.toContain('private --token secret')
  })

  it('captures the exact slot privately and installs an idempotent managed chain', () => {
    const original = {
      type: 'command',
      command: "printf 'custom status\\n'",
      padding: 3
    }
    writeSettings(original)

    expect(enableSessionInfoStatusLineChaining()).toEqual({ state: 'chained' })
    expect(enableSessionInfoStatusLineChaining()).toEqual({ state: 'chained' })

    const agentHooksDir = join(home, '.quirky', 'agent-hooks')
    const metadataPath = join(agentHooksDir, 'claude-statusline-chain.json')
    const runnerPath = join(
      agentHooksDir,
      process.platform === 'win32' ? 'claude-statusline-user.cmd' : 'claude-statusline-user.sh'
    )
    const installed = readSettings().statusLine as { command: string }
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as {
      statusLine: Record<string, unknown>
    }

    expect(createManagedCommandMatcher(getStatusLineScriptFileName())(installed.command)).toBe(true)
    expect(installed).toMatchObject({ type: 'command', padding: 3 })
    expect(metadata.statusLine).toEqual(original)
    expect(readFileSync(runnerPath, 'utf-8')).toContain(original.command)
    expect(existsSync(join(agentHooksDir, 'claude-statusline.installed'))).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(metadataPath).mode & 0o777).toBe(0o600)
      expect(statSync(runnerPath).mode & 0o777).toBe(0o700)
    }
  })

  it('reports drift and explicit enable recaptures the edited command', () => {
    writeSettings({ type: 'command', command: 'printf first', padding: 1 })
    expect(enableSessionInfoStatusLineChaining().state).toBe('chained')

    const edited = { type: 'command', command: 'printf second', padding: 7 }
    writeSettings(edited)
    expect(getSessionInfoStatusLineChainStatus().state).toBe('drifted')
    expect(enableSessionInfoStatusLineChaining().state).toBe('chained')

    const installed = readSettings()
    const removed = removeManagedStatusLine(installed)
    expect(existsSync(join(home, '.quirky', 'agent-hooks', 'claude-statusline-chain.json'))).toBe(
      true
    )
    finalizeManagedStatusLineRemoval()
    expect(removed.changed).toBe(true)
    expect(removed.config.statusLine).toEqual(edited)
    expect(existsSync(join(home, '.quirky', 'agent-hooks', 'claude-statusline-chain.json'))).toBe(
      false
    )
    expect(
      existsSync(
        join(
          home,
          '.quirky',
          'agent-hooks',
          process.platform === 'win32' ? 'claude-statusline-user.cmd' : 'claude-statusline-user.sh'
        )
      )
    ).toBe(false)
  })

  it('does not restore over a drifted user slot and cleans captured files', () => {
    writeSettings({ type: 'command', command: 'printf original' })
    expect(enableSessionInfoStatusLineChaining().state).toBe('chained')

    const drifted = { type: 'command', command: 'printf replacement' }
    const config = { ...readSettings(), statusLine: drifted }
    const removed = removeManagedStatusLine(config)
    finalizeManagedStatusLineRemoval()

    expect(removed.changed).toBe(false)
    expect(removed.config.statusLine).toEqual(drifted)
    expect(existsSync(join(home, '.quirky', 'agent-hooks', 'claude-statusline-chain.json'))).toBe(
      false
    )
  })

  it('rejects a managed command instead of capturing a recursive chain', () => {
    const managedCommand = getManagedCommand(getStatusLineScriptPath())
    writeSettings({ type: 'command', command: managedCommand })

    expect(enableSessionInfoStatusLineChaining()).toEqual({ state: 'managed' })
    expect(existsSync(join(home, '.quirky', 'agent-hooks', 'claude-statusline-chain.json'))).toBe(
      false
    )
  })
})
