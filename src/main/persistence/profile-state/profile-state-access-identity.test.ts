import * as fs from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ runProcessSync: vi.fn() }))
vi.mock('@quirky/process-host', () => ({ runProcessSync: native.runProcessSync }))
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  vi.resetModules()
  native.runProcessSync.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
})

it.each([
  ['8de277067b3544d4b65c267d0edab928\n', '8de277067b3544d4b65c267d0edab928'],
  ['00000000000000000000000000000000', null],
  ['uninitialized\n', null],
  ['invalid-machine-id', null],
  ['', null]
] as const)('validates the Linux machine identity %j', async (contents, expected) => {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  const read = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) =>
    path === '/etc/machine-id' ? contents : read(path, options)
  )
  const { profileStateAccessMachineIdentity } = await import('./profile-state-access-identity')
  expect(profileStateAccessMachineIdentity()).toBe(expected)
})

const IOREG = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000253>
    {
      "IOPlatformSerialNumber" = "C02XXXXXXXXX"
      "IOPlatformUUID" = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"
    }
`

it('reads the macOS hardware UUID from IOPlatformUUID, not a sysctl macOS lacks', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  native.runProcessSync.mockReturnValue({ code: 0, stdout: IOREG, stderr: '' })
  const { profileStateAccessMachineIdentity } = await import('./profile-state-access-identity')
  expect(profileStateAccessMachineIdentity()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  expect(profileStateAccessMachineIdentity()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  expect(native.runProcessSync).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      program: '/usr/sbin/ioreg',
      args: ['-rd1', '-c', 'IOPlatformExpertDevice']
    })
  )
})

it.each([
  [{ code: 1, stdout: '', stderr: 'ioreg: failed' }],
  [{ code: 0, stdout: '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"', stderr: '' }],
  [{ code: 0, stdout: '"IOPlatformUUID" = "not-a-uuid"', stderr: '' }],
  [{ code: 0, stdout: '', stderr: '' }]
])('keeps an unavailable macOS hardware UUID unverifiable', async (result) => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  native.runProcessSync.mockReturnValue(result)
  const { profileStateAccessMachineIdentity } = await import('./profile-state-access-identity')
  expect(profileStateAccessMachineIdentity()).toBeNull()
})
