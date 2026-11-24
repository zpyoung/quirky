import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@quirky/process-host'
import { getManagedStatusLineScript } from './session-info-statusline-chaining'
import { SESSION_INFO_STATUSLINE_CHAIN_ENV } from './session-info-statusline-chain-script'

let directory: string
let home: string
let bin: string
let runner: string
let postMarker: string

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o700)
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    TMPDIR: join(directory, 'tmp'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    QUIRKY_AGENT_HOOK_PORT: '1234',
    QUIRKY_AGENT_HOOK_TOKEN: 'token',
    QUIRKY_PANE_KEY: 'tab:12345678-1234-1234-1234-123456789abc',
    POST_MARKER: postMarker
  }
}

async function runGeneratedScript(
  input: string,
  environment: NodeJS.ProcessEnv = baseEnvironment()
) {
  const script = join(directory, 'managed-statusline.sh')
  writeExecutable(script, getManagedStatusLineScript('posix'))
  return runProcess({
    program: '/bin/sh',
    args: [script],
    env: environment,
    input,
    timeoutMs: 4_000
  })
}

describe('session info chained statusline script', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'quirky-session-info-script-'))
    home = join(directory, 'home')
    bin = join(directory, 'bin')
    runner = join(home, '.quirky', 'agent-hooks', 'claude-statusline-user.sh')
    postMarker = join(directory, 'posted')
    mkdirSync(join(directory, 'tmp'))
    mkdirSync(bin)
    mkdirSync(join(home, '.quirky', 'agent-hooks'), { recursive: true })
    writeExecutable(join(bin, 'curl'), '#!/bin/sh\ncat >/dev/null\nprintf posted >"$POST_MARKER"\n')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it('duplicates stdin, relays successful stdout, and runs the child before POST', async () => {
    const order = join(directory, 'order')
    writeExecutable(
      runner,
      '#!/bin/sh\npayload=$(cat)\nprintf chain >"$ORDER_MARKER"\nprintf \'custom:%s\' "$payload"\n'
    )
    writeExecutable(
      join(bin, 'curl'),
      '#!/bin/sh\nprintf post >>"$ORDER_MARKER"\ncat >/dev/null\nprintf posted >"$POST_MARKER"\n'
    )
    const payload = '{"context_window":{"used_percentage":42}}'
    const result = await runGeneratedScript(payload, {
      ...baseEnvironment(),
      ORDER_MARKER: order
    })

    expect(result).toMatchObject({ code: 0, timedOut: false, stderr: '' })
    expect(result.stdout).toBe(`custom:${payload}`)
    expect(readFileSync(order, 'utf-8')).toBe('chainpost')
    expect(readFileSync(postMarker, 'utf-8')).toBe('posted')
  })

  it('suppresses failed child output and still posts', async () => {
    writeExecutable(runner, '#!/bin/sh\necho hidden\necho private-error >&2\nexit 7\n')

    const result = await runGeneratedScript('{"context_window":{}}')

    expect(result).toMatchObject({ code: 0, timedOut: false, stdout: '', stderr: '' })
    expect(readFileSync(postMarker, 'utf-8')).toBe('posted')
  })

  it('bounds a hung command tree and still posts', async () => {
    const childPidPath = join(directory, 'child-pid')
    writeExecutable(
      runner,
      '#!/bin/sh\nsleep 5 &\nchild=$!\nprintf \'%s\' "$child" >"$CHILD_PID_PATH"\nwait "$child"\n'
    )
    const startedAt = Date.now()

    const result = await runGeneratedScript('{"rate_limits":{}}', {
      ...baseEnvironment(),
      CHILD_PID_PATH: childPidPath
    })

    expect(Date.now() - startedAt).toBeLessThan(2_500)
    expect(result).toMatchObject({ code: 0, timedOut: false, stdout: '', stderr: '' })
    expect(readFileSync(postMarker, 'utf-8')).toBe('posted')
    expect(() => process.kill(Number(readFileSync(childPidPath, 'utf-8')), 0)).toThrow()
  })

  it('skips the captured command under the reentrancy guard', async () => {
    const recursionMarker = join(directory, 'recursed')
    writeExecutable(runner, '#!/bin/sh\nprintf yes >"$RECURSION_MARKER"\n')

    const result = await runGeneratedScript('{"context_window":{}}', {
      ...baseEnvironment(),
      [SESSION_INFO_STATUSLINE_CHAIN_ENV]: '1',
      RECURSION_MARKER: recursionMarker
    })

    expect(result.code).toBe(0)
    expect(() => readFileSync(recursionMarker)).toThrow()
    expect(readFileSync(postMarker, 'utf-8')).toBe('posted')
  })

  it('injects POSIX chaining between capture and every POST gate', () => {
    const script = getManagedStatusLineScript('posix')
    const capture = script.indexOf('payload=${payload%?}')
    const chain = script.indexOf(SESSION_INFO_STATUSLINE_CHAIN_ENV)
    const payloadGate = script.indexOf('case "$payload" in')
    const throttle = script.indexOf('quirky_statusline_stamp=')

    expect(capture).toBeLessThan(chain)
    expect(chain).toBeLessThan(payloadGate)
    expect(chain).toBeLessThan(throttle)
    expect(script).toContain('sleep 1')
    expect(script).toContain('if [ "$quirky_statusline_chain_status" -eq 0 ]')
    expect(script).toContain('*\'"context_window"\'*')
  })

  it('chains through cmd builtins after capture and before throttle, spawning no interpreter', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const script = getManagedStatusLineScript('local')
    const capture = script.indexOf('QUIRKY_STATUSLINE_PAYLOAD_FILE%" 2>nul')
    const chain = script.indexOf(SESSION_INFO_STATUSLINE_CHAIN_ENV)
    const throttle = script.indexOf('set "QUIRKY_STATUSLINE_STAMP_FILE=')

    expect(capture).toBeLessThan(chain)
    expect(chain).toBeLessThan(throttle)
    expect(script).not.toMatch(/powershell(\.exe)?/i)
    expect(script).toContain('"%ComSpec%" /d /s /c ""%USERPROFILE%')
    expect(script).toContain('< "%QUIRKY_STATUSLINE_PAYLOAD_FILE%""')
    expect(script).toContain(`  set "${SESSION_INFO_STATUSLINE_CHAIN_ENV}=1"`)
    expect(script).toContain('if not errorlevel 1 type "%TEMP%\\quirky-statusline-chain-')
    expect(script).toContain('del "%TEMP%\\quirky-statusline-chain-')
    expect(script).toContain('context_window')
  })
})
