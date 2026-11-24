import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getOpenCodeLaunchExecutable,
  probeOpenCodeLaunchCapabilities
} from './opencode-launch-capabilities'
import { getOpenCodeCliCapabilities } from '../../shared/opencode-cli-version'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), probe: vi.fn() }))
vi.mock('../ipc/command-path-resolver', () => ({ resolveCommandOnLocalPath: mocks.resolve }))
vi.mock('./opencode-cli-version', () => ({ probeOpenCodeCliVersion: mocks.probe }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.probe.mockResolvedValue(getOpenCodeCliCapabilities('2.0.16'))
})

describe('OpenCode execution-host launch capability probe', () => {
  it('recognizes quoted executables and preserves explicit run commands', () => {
    expect(getOpenCodeLaunchExecutable('"/app dir/opencode" run task')).toBe('/app dir/opencode')
    expect(getOpenCodeLaunchExecutable('sleep 30 && "/app dir/opencode2"')).toBe(
      '/app dir/opencode2'
    )
    expect(getOpenCodeLaunchExecutable('custom-launcher --standalone', 'opencode')).toBe(
      'custom-launcher'
    )
    expect(getOpenCodeLaunchExecutable('claude')).toBeNull()
  })

  it('uses native resolution with the execution environment and cwd', async () => {
    mocks.resolve.mockResolvedValue('/bin/opencode')
    const env = { PATH: '/bin', OPENCODE_CONFIG_DIR: '/private/config' }
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode run task',
      env,
      cwd: '/repo',
      hostIdentity: 'native-test'
    })
    expect(mocks.resolve).toHaveBeenCalledWith('opencode', { env, cwd: '/repo' })
    expect(mocks.probe).toHaveBeenCalledWith({
      executablePath: '/bin/opencode',
      env,
      cwd: '/repo',
      hostIdentity: 'native-test'
    })
  })

  it('uses the relay resolver rather than client PATH resolution', async () => {
    const resolveExecutable = vi.fn().mockResolvedValue('/host/opencode')
    await probeOpenCodeLaunchCapabilities({
      command: 'opencode',
      env: {},
      hostIdentity: 'relay:linux',
      resolveExecutable
    })
    expect(resolveExecutable).toHaveBeenCalledWith('opencode')
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: '/host/opencode', hostIdentity: 'relay:linux' })
    )
  })

  it('returns unknown when the host cannot resolve the binary', async () => {
    mocks.resolve.mockResolvedValue(null)
    expect(await probeOpenCodeLaunchCapabilities({ command: 'opencode', env: {} })).toEqual(
      getOpenCodeCliCapabilities(null)
    )
    expect(mocks.probe).not.toHaveBeenCalled()
  })
})
