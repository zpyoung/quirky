import { beforeEach, describe, expect, it, vi } from 'vitest'

const execLocal = vi.fn()

vi.mock('../ipc/preflight-command-exec', () => ({
  execLocalPreflightCommandOrThrow: (command: string, args: string[]) =>
    execLocal(command, args) as Promise<{ stdout: string; stderr: string }>,
  shellQuote: (value: string) => `'${value.replace(/'/g, "'\\''")}'`
}))

const { buildLocalClaudeAskGateHost } = await import('./claude-ask-suppression-local-host')

beforeEach(() => {
  execLocal.mockReset().mockResolvedValue({ stdout: '1.2.0', stderr: '' })
})

describe('buildLocalClaudeAskGateHost', () => {
  it('probes the native PATH on a posix host', async () => {
    const host = buildLocalClaudeAskGateHost({}, 'darwin')

    expect(host).toMatchObject({ kind: 'local', shell: 'posix' })
    expect(host).not.toHaveProperty('wslDistro')
    await expect(host.probe(['claude', '--version'])).resolves.toBe('1.2.0')
    expect(execLocal).toHaveBeenCalledWith('claude', ['--version'])
  })

  it('carries the command override so the gate probes the binary the launch will run', () => {
    const host = buildLocalClaudeAskGateHost(
      { agentCmdOverrides: { claude: '  npx claude  ' } },
      'darwin'
    )

    expect(host.commandOverride).toBe('npx claude')
  })

  it('ignores an empty command override rather than probing an empty command', () => {
    expect(
      buildLocalClaudeAskGateHost({ agentCmdOverrides: { claude: '   ' } }, 'darwin')
    ).not.toHaveProperty('commandOverride')
  })

  it('keys the default distro apart from the native Windows host', () => {
    const wslDefault = buildLocalClaudeAskGateHost({ terminalWindowsShell: 'wsl.exe' }, 'win32')
    const native = buildLocalClaudeAskGateHost({ terminalWindowsShell: 'powershell.exe' }, 'win32')

    expect(wslDefault).toMatchObject({ wslDistro: '' })
    expect(native).not.toHaveProperty('wslDistro')
    expect(native.shell).toBe('powershell')
  })

  it('probes the Windows PATH when the terminal shell is not wsl', async () => {
    const host = buildLocalClaudeAskGateHost(
      { terminalWindowsShell: 'powershell.exe', terminalWindowsWslDistro: 'Ubuntu' },
      'win32'
    )

    await host.probe(['claude', '--version'])
    expect(execLocal).toHaveBeenCalledWith('claude', ['--version'])
  })
})
