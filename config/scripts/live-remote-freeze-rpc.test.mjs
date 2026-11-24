import { describe, expect, it } from 'vitest'
import {
  appendQuirkyRpcOutput,
  resolveQuirkyCliCommand,
  resolveQuirkyCliInvocation
} from './live-remote-freeze-rpc.mjs'

describe('live remote freeze RPC', () => {
  it('resolves the Quirky CLI for managed, dev, Linux, and default runtimes', () => {
    expect(resolveQuirkyCliCommand({ env: { QUIRKY_CLI_COMMAND: 'custom-quirky' } })).toBe(
      'custom-quirky'
    )
    expect(resolveQuirkyCliCommand({ env: { QUIRKY_DEV_REPO_ROOT: '/repo' } })).toBe('quirky-dev')
    expect(resolveQuirkyCliCommand({ env: {}, platform: 'linux' })).toBe('quirky-ide')
    expect(resolveQuirkyCliCommand({ env: {}, platform: 'win32' })).toBe('quirky')
  })

  it('bypasses the Windows dev cmd shim with the built Node CLI', () => {
    const invocation = resolveQuirkyCliInvocation({
      env: {
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        QUIRKY_CLI_COMMAND: 'C:\\repo\\out\\bin\\quirky-dev.cmd',
        QUIRKY_DEV_REPO_ROOT: 'C:\\repo'
      },
      platform: 'win32',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe'
    })

    expect(invocation).toMatchObject({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: ['C:\\repo\\out\\cli\\index.js'],
      env: {
        QUIRKY_USER_DATA_PATH: 'C:\\Users\\dev\\AppData\\Roaming\\quirky-dev',
        QUIRKY_DEV_CLI_INVOCATION: '1',
        QUIRKY_APP_EXECUTABLE: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
        QUIRKY_APP_EXECUTABLE_NEEDS_APP_ROOT: '1'
      }
    })
  })

  it('caps combined asynchronous output before retaining the overflow chunk', () => {
    const first = appendQuirkyRpcOutput('', '1234', 0, 5)
    expect(first).toEqual({ output: '1234', bytes: 4, exceeded: false })

    const overflow = appendQuirkyRpcOutput(first.output, '67', first.bytes, 5)
    expect(overflow).toEqual({ output: '1234', bytes: 6, exceeded: true })
  })
})
