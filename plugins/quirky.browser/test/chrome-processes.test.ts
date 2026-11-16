import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { createProcessRunner } from '../../../packages/process/src/api'
import type { BrowserProcess } from '../src/runtime/dependencies'
import { createChromeProcessAccess } from '../src/runtime/chrome-processes'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_TABLE_BYTES = 4 * 1024 * 1024
const MAX_ARGV_BYTES = 1024 * 1024
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE = '/tmp/profile/chrome-profile'
const STARTED = 'Mon Nov 16 12:34:56 2026'

type RunResult = {
  stdout: Uint8Array
  stdoutText: string
  stderr: string
  exitCode: number | null
  signal: string | null
  durationMs: number
  stopped?: 'timeout' | 'aborted' | 'overflow'
  truncated?: { stdout: boolean; stderr: boolean }
}

type AccessOverrides = {
  platform?: string
  now?: () => number
  readMacProcessArgs?: (pid: number, maxBytes: number) => Uint8Array
  readLinuxProcessArgs?: (pid: number, maxBytes: number) => Uint8Array
  readLinuxExecutable?: (pid: number) => string
  executablePath?: string
}

type RunOptions = { timeoutMs?: number; killGraceMs?: number; maxOutputBytes?: number }

function processRow(
  pid = 240,
  ppid = 1,
  pgid = pid,
  uid = 501,
  command = 'Google Chrome'
): string {
  return `${pid} ${ppid} ${pgid} ${uid} ${STARTED} ${command}\n`
}

function runResult(
  output: string | Uint8Array,
  overrides: Partial<RunResult> = {}
): RunResult {
  const stdout = typeof output === 'string' ? new TextEncoder().encode(output) : output
  let stdoutText = ''
  try {
    stdoutText = new TextDecoder('utf-8', { fatal: true }).decode(stdout)
  } catch {
    stdoutText = '\uFFFD'
  }
  return {
    stdout,
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 1,
    ...overrides
  }
}

function fakeProcess(
  output: string | Uint8Array | ((argv: readonly string[]) => string | Uint8Array),
  resultOverrides: Partial<RunResult> = {},
  onRun?: (argv: readonly string[], options: RunOptions | undefined) => void
): BrowserProcess {
  return {
    async run(argv: readonly string[], options?: RunOptions) {
      onRun?.(argv, options)
      const resolved = typeof output === 'function' ? output(argv) : output
      return runResult(resolved, resultOverrides) as never
    },
    spawn() {
      throw new Error('process inspection must not spawn a child')
    }
  } as unknown as BrowserProcess
}

function macProcessArgs(
  argv: readonly string[],
  options: { executable?: string; environment?: readonly string[]; executablePadding?: number; totalLength?: number } = {}
): Uint8Array {
  const executable = Buffer.from(`${options.executable ?? CHROME}\0`)
  const executableEnd = 4 + executable.length
  const padding = Buffer.alloc((4 - (executableEnd % 4)) % 4 + (options.executablePadding ?? 0))
  const args = Buffer.from(`${argv.join('\0')}\0`)
  const environment = Buffer.from(`${(options.environment ?? ['PATH=/usr/bin']).join('\0')}\0`)
  const argc = Buffer.alloc(4)
  argc.writeInt32LE(argv.length)
  const payload = Buffer.concat([argc, executable, padding, args, Buffer.from([0]), environment])
  if (options.totalLength === undefined) return payload
  if (payload.length > options.totalLength) throw new Error('fixture does not fit requested length')
  const output = Buffer.alloc(options.totalLength)
  payload.copy(output)
  return output
}

function linuxProcessArgs(argv: readonly string[]): Uint8Array {
  return Buffer.from(`${argv.join('\0')}\0`)
}

function fakeAccess(
  platform: string,
  output: string | Uint8Array,
  overrides: Omit<AccessOverrides, 'platform'> = {}
) {
  return createChromeProcessAccess(fakeProcess(output), { ...overrides, platform })
}

async function expectInspectionFailure(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toThrow()
}

test('decodes macOS argc and executable padding without treating environment as argv', async () => {
  const argv = [CHROME, '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0']
  const access = fakeAccess('darwin', processRow(), {
    readMacProcessArgs: () => macProcessArgs(argv, {
      executable: CHROME,
      executablePadding: 8,
      environment: ['HOME=/tmp/private', `QUIRKY_ARG=--user-data-dir=${PROFILE}`, 'TAIL=hidden']
    })
  })

  const [identity] = await access.snapshot()

  expect(identity).toEqual({
    pid: 240,
    ppid: 1,
    pgid: 240,
    uid: 501,
    started: STARTED,
    executable: CHROME,
    argv
  })
})

test('decodes Linux NUL-delimited argv and accepts its final NUL', async () => {
  const argv = ['/usr/bin/chromium', '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0']
  const access = fakeAccess('linux', processRow(240, 1, 240, 501, 'chromium'), {
    readLinuxProcessArgs: () => linuxProcessArgs(argv),
    readLinuxExecutable: () => '/usr/bin/chromium'
  })

  const [identity] = await access.snapshot()

  expect(identity?.argv).toEqual(argv)
  expect(identity?.executable).toBe('/usr/bin/chromium')
})

test('rejects unterminated argv and argc extending past the macOS buffer', async () => {
  const unterminatedLinux = Buffer.from('/usr/bin/chromium\0--headless=new')
  const linux = fakeAccess('linux', processRow(240, 1, 240, 501, 'chromium'), {
    readLinuxProcessArgs: () => unterminatedLinux,
    readLinuxExecutable: () => '/usr/bin/chromium'
  })
  const macArgs = Buffer.from(macProcessArgs(['/usr/bin/chromium']))
  const argvOffset = macArgs.indexOf(Buffer.from('/usr/bin/chromium\0'))
  const badMacArgs = macArgs.subarray(0, argvOffset + Buffer.byteLength('/usr/bin/chromium\0'))
  badMacArgs.writeInt32LE(2, 0)
  const mac = fakeAccess('darwin', processRow(), {
    readMacProcessArgs: () => badMacArgs
  })

  await expectInspectionFailure(linux.snapshot())
  await expectInspectionFailure(mac.snapshot())
})

test('rejects invalid UTF-8 in native argv instead of replacing bytes', async () => {
  const linuxBytes = Buffer.from([0x63, 0x68, 0x72, 0x6f, 0x6d, 0x65, 0, 0xff, 0])
  const linux = fakeAccess('linux', processRow(240, 1, 240, 501, 'chromium'), {
    readLinuxProcessArgs: () => linuxBytes,
    readLinuxExecutable: () => '/usr/bin/chromium'
  })
  const macBytes = Buffer.from(macProcessArgs(['/usr/bin/chromium']))
  const argvOffset = macBytes.indexOf(Buffer.from('/usr/bin/chromium\0'))
  macBytes[argvOffset + 1] = 0xff
  const mac = fakeAccess('darwin', processRow(), {
    readMacProcessArgs: () => macBytes
  })

  await expectInspectionFailure(linux.snapshot())
  await expectInspectionFailure(mac.snapshot())
})

test('accepts exactly one MiB of native argv and rejects an oversized buffer with flags on either side of the cap', async () => {
  const exactMacArgv = [CHROME, '--headless=new', `--user-data-dir=${PROFILE}`]
  const exactMac = fakeAccess('darwin', processRow(), {
    readMacProcessArgs: () => macProcessArgs(exactMacArgv, { totalLength: MAX_ARGV_BYTES })
  })
  expect((await exactMac.snapshot())[0]?.argv).toEqual(exactMacArgv)

  const exactLinuxArgv = ['/usr/bin/chromium', '--headless=new', `--user-data-dir=${PROFILE}`]
  const linuxPrefixLength = Buffer.byteLength(`${exactLinuxArgv.join('\0')}\0`)
  exactLinuxArgv.push('x'.repeat(MAX_ARGV_BYTES - linuxPrefixLength - 1))
  const exactLinux = fakeAccess('linux', processRow(240, 1, 240, 501, 'chromium'), {
    readLinuxProcessArgs: () => linuxProcessArgs(exactLinuxArgv),
    readLinuxExecutable: () => '/usr/bin/chromium'
  })
  expect((await exactLinux.snapshot())[0]?.argv.slice(0, 3)).toEqual([
    '/usr/bin/chromium', '--headless=new', `--user-data-dir=${PROFILE}`
  ])
  expect(Buffer.byteLength(`${exactLinuxArgv.join('\0')}\0`)).toBe(MAX_ARGV_BYTES)

  const oversizedInputs = [
    [CHROME, `--user-data-dir=${PROFILE}`, 'x'.repeat(MAX_ARGV_BYTES), `--user-data-dir=${PROFILE}-other`],
    [CHROME, `--user-data-dir=${PROFILE}-other`, 'x'.repeat(MAX_ARGV_BYTES), `--user-data-dir=${PROFILE}`]
  ]
  for (const argv of oversizedInputs) {
    const mac = fakeAccess('darwin', processRow(), {
      readMacProcessArgs: () => macProcessArgs(argv)
    })
    await expectInspectionFailure(mac.snapshot())
  }

  const oversizedLinuxInputs = [
    ['/usr/bin/chromium', `--user-data-dir=${PROFILE}`, 'x'.repeat(MAX_ARGV_BYTES), `--user-data-dir=${PROFILE}-other`],
    ['/usr/bin/chromium', `--user-data-dir=${PROFILE}-other`, 'x'.repeat(MAX_ARGV_BYTES), `--user-data-dir=${PROFILE}`]
  ]
  for (const argv of oversizedLinuxInputs) {
    const linux = fakeAccess('linux', processRow(240, 1, 240, 501, 'chromium'), {
      readLinuxProcessArgs: () => linuxProcessArgs(argv),
      readLinuxExecutable: () => '/usr/bin/chromium'
    })
    await expectInspectionFailure(linux.snapshot())
  }
})

test('bounds process-table output at four MiB and refuses truncation, malformed rows, and malformed UTF-8', async () => {
  const row = processRow()
  const exactOutput = `${row.trimEnd()}${' '.repeat(MAX_TABLE_BYTES - row.length)}\n`
  const exact = fakeAccess('darwin', exactOutput, {
    readMacProcessArgs: () => macProcessArgs([CHROME, '--headless=new'])
  })
  expect((await exact.snapshot()).map(({ pid }) => pid)).toEqual([240])

  let oversizedNativeReads = 0
  const oversized = fakeAccess('darwin', `${exactOutput}${processRow(241, 1, 241, 501, 'Chromium')}`, {
    readMacProcessArgs() {
      oversizedNativeReads += 1
      return macProcessArgs([CHROME, '--headless=new'])
    }
  })
  const truncated = createChromeProcessAccess(fakeProcess(row, { truncated: { stdout: true, stderr: false } }), {
    platform: 'darwin',
    readMacProcessArgs: () => macProcessArgs([CHROME, '--headless=new'])
  })
  const malformed = fakeAccess('darwin', 'not a ps record\n', {})
  const invalidText = fakeAccess('darwin', Buffer.from([0xff, 0x0a]))

  await expectInspectionFailure(oversized.snapshot())
  expect(oversizedNativeReads).toBe(0)
  await expectInspectionFailure(truncated.snapshot())
  await expectInspectionFailure(malformed.snapshot())
  await expectInspectionFailure(invalidText.snapshot())
})

test('distinguishes an exited process from denied native inspection', async () => {
  const disappeared = createChromeProcessAccess(fakeProcess(processRow(240, 1, 240, 501, 'chromium')), {
    platform: 'linux',
    readLinuxProcessArgs() {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    },
    readLinuxExecutable() {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    }
  })
  expect(await disappeared.inspect(240)).toBeNull()
  expect(await disappeared.snapshot()).toEqual([])

  const denied = createChromeProcessAccess(fakeProcess(processRow(240, 1, 240, 501, 'chromium')), {
    platform: 'linux',
    readLinuxProcessArgs() {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    },
    readLinuxExecutable: () => '/usr/bin/chromium'
  })
  await expectInspectionFailure(denied.inspect(240))
  const absentFromPs = createChromeProcessAccess(fakeProcess('', { exitCode: 1 }), {
    platform: 'linux',
    readLinuxProcessArgs() {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    },
    readLinuxExecutable() {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    }
  })
  expect(await absentFromPs.inspect(241)).toBeNull()

  const hiddenByPs = createChromeProcessAccess(fakeProcess('', { exitCode: 1 }), {
    platform: 'linux',
    readLinuxProcessArgs: () => linuxProcessArgs(['/usr/bin/chromium', '--headless=new']),
    readLinuxExecutable: () => '/usr/bin/chromium'
  })
  await expectInspectionFailure(hiddenByPs.inspect(242))
})

test('refuses unsupported platforms and process-runner timeouts', async () => {
  const unsupported = createChromeProcessAccess(fakeProcess(''), { platform: 'freebsd' })
  await expectInspectionFailure(unsupported.snapshot())

  const timedOut = createChromeProcessAccess(fakeProcess(processRow(), { stopped: 'timeout', exitCode: null }), {
    platform: 'darwin',
    readMacProcessArgs: () => macProcessArgs([CHROME, '--headless=new'])
  })

  await expectInspectionFailure(timedOut.snapshot())
})

test('uses one two-second budget for process discovery and all native candidate reads', async () => {
  let elapsed = 0
  let reads = 0
  const runOptions: RunOptions[] = []
  const output = `${processRow(240)}${processRow(241, 1, 241, 501, 'Chromium')}`
  const runner = fakeProcess(
    () => {
      elapsed += 900
      return output
    },
    {},
    (_argv, options) => {
      if (options) runOptions.push(options)
    }
  )
  const access = createChromeProcessAccess(runner, {
    platform: 'darwin',
    now: () => elapsed,
    readMacProcessArgs: () => {
      reads += 1
      elapsed += 600
      return macProcessArgs([CHROME, '--headless=new'])
    }
  })

  await expectInspectionFailure(access.snapshot())
  expect(reads).toBe(2)
  expect(runOptions).toHaveLength(1)
  expect(runOptions[0]).toMatchObject({ timeoutMs: 2_000, killGraceMs: 0, maxOutputBytes: MAX_TABLE_BYTES })
})

test('reads its own native process identity on the supported host without signalling it', async () => {
  const runner = createProcessRunner({ owner: 'quirky.browser.chrome-processes-self-test' })
  try {
    const access = createChromeProcessAccess(runner as unknown as BrowserProcess)
    const identity = await access.inspect(process.pid)

    expect(identity).not.toBeNull()
    expect(identity?.pid).toBe(process.pid)
    expect(identity?.argv.length).toBeGreaterThan(0)
    const nativeTestFile = identity?.argv.find((argument) => argument.endsWith('chrome-processes.test.ts'))
    expect(nativeTestFile).toBeDefined()
    expect(realpathSync(nativeTestFile!)).toBe(realpathSync(import.meta.path))
    expect(realpathSync(identity!.executable)).toBe(realpathSync(process.execPath))
    if (typeof process.getuid === 'function') expect(identity?.uid).toBe(process.getuid())
  } finally {
    await runner.dispose()
  }
})
test('preserves a leading UTF-8 BOM in native macOS and Linux arguments', async () => {
  const macArgs = [CHROME, '\uFEFF--headless=new']
  const mac = fakeAccess('darwin', processRow(), {
    readMacProcessArgs: () => macProcessArgs(macArgs)
  })
  const linuxArgs = ['/usr/bin/chromium', '\uFEFF--headless=new']
  const linux = fakeAccess('linux', processRow(240, 1, 240, 501, 'chromium'), {
    readLinuxProcessArgs: () => linuxProcessArgs(linuxArgs),
    readLinuxExecutable: () => '/usr/bin/chromium'
  })

  expect((await mac.snapshot())[0]?.argv).toEqual(macArgs)
  expect((await linux.snapshot())[0]?.argv).toEqual(linuxArgs)
})

test('accepts Linux kernel tasks with process group zero alongside Chrome', async () => {
  const access = fakeAccess(
    'linux',
    `${processRow(2, 0, 0, 0, 'kthreadd')}${processRow(240, 1, 240, 501, 'chromium')}`,
    {
      readLinuxProcessArgs: () => linuxProcessArgs(['/usr/bin/chromium', '--headless=new']),
      readLinuxExecutable: () => '/usr/bin/chromium'
    }
  )

  expect((await access.snapshot()).map(({ pid }) => pid)).toEqual([240])
})

test('accepts signed Darwin system UIDs without losing their unsigned ownership identity', async () => {
  const access = fakeAccess('darwin', `${processRow(2, 1, 2, -2, 'system-task')}${processRow(240, 1, 240, -2)}`, {
    readMacProcessArgs: () => macProcessArgs([CHROME, '--headless=new'])
  })
  expect((await access.snapshot()).map(({ pid, uid }) => ({ pid, uid }))).toEqual([{ pid: 240, uid: 4_294_967_294 }])
})

test('classifies Darwin EINVAL only after a trusted ps recheck confirms the PID is absent', async () => {
  const missingCalls: string[][] = []
  const missing = createChromeProcessAccess(fakeProcess('', { exitCode: 1 }, (argv) => {
    missingCalls.push([...argv])
  }), {
    platform: 'darwin',
    readMacProcessArgs() {
      throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' })
    }
  })

  expect(await missing.inspect(242)).toBeNull()
  expect(missingCalls).toHaveLength(2)
  expect(missingCalls.every(([executable]) => executable === '/bin/ps')).toBe(true)

  const presentCalls: string[][] = []
  const permissionDenied = createChromeProcessAccess(fakeProcess(processRow(), {}, (argv) => {
    presentCalls.push([...argv])
  }), {
    platform: 'darwin',
    readMacProcessArgs() {
      throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' })
    }
  })

  await expectInspectionFailure(permissionDenied.inspect(240))
  expect(presentCalls).toHaveLength(2)
  expect(presentCalls.every(([executable]) => executable === '/bin/ps')).toBe(true)
})

test('uses the trusted absolute ps executable on Darwin and Linux', async () => {
  for (const platform of ['darwin', 'linux']) {
    let command: readonly string[] = []
    const runner = fakeProcess(
      processRow(240, 1, 240, 501, platform === 'linux' ? 'chromium' : 'Google Chrome'),
      {},
      (argv) => {
        command = argv
      }
    )
    const access = createChromeProcessAccess(runner, {
      platform,
      readMacProcessArgs: () => macProcessArgs([CHROME]),
      readLinuxProcessArgs: () => linuxProcessArgs(['/usr/bin/chromium']),
      readLinuxExecutable: () => '/usr/bin/chromium'
    })

    await access.snapshot()
    expect(command[0]).toBe('/bin/ps')
  }
})

test('uses the configured executable basename as an additional Chrome discovery hint', async () => {
  const variants = [
    {
      executablePath: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      command: 'Google Chrome Canary'
    },
    {
      executablePath: '/opt/custom/renamedChrome',
      command: '/opt/custom/renamedChrome'
    }
  ]

  for (const variant of variants) {
    const access = fakeAccess('darwin', processRow(240, 1, 240, 501, variant.command), {
      executablePath: variant.executablePath,
      readMacProcessArgs: () => macProcessArgs([variant.executablePath], {
        executable: variant.executablePath
      })
    })

    expect((await access.snapshot())[0]?.executable).toBe(variant.executablePath)
  }
})

test('treats parenthesized and truncated macOS Chrome command names as candidates', async () => {
  for (const command of ['(Google Chrome)', '(Google Chrome H)']) {
    const access = fakeAccess('darwin', processRow(240, 1, 240, 501, command), {
      readMacProcessArgs() {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
    })

    await expectInspectionFailure(access.snapshot())
  }
})


test('recognizes a configured executable truncated to Darwin MAXCOMLEN before native authorization', async () => {
  const executablePath = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
  const access = fakeAccess('darwin', processRow(240, 1, 240, 501, '(Google Chrome Ca)'), {
    executablePath,
    readMacProcessArgs() {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
  })

  await expectInspectionFailure(access.snapshot())
})

test('discovers the configured Linux executable despite comm truncation', async () => {
  const executablePath = '/opt/custom/custom-chrome-browser'
  const access = fakeAccess('linux', processRow(240, 1, 240, 501, 'custom-chrome-b'), {
    executablePath,
    readLinuxProcessArgs: () => linuxProcessArgs([executablePath, '--headless=new']),
    readLinuxExecutable: () => executablePath
  })
  expect((await access.snapshot())[0]?.executable).toBe(executablePath)
})

test('discovers the resolved executable behind a differently named configured symlink', async () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-executable-alias-'))
  const alias = join(home, 'configured-browser')
  symlinkSync(process.execPath, alias)
  try {
    const executable = realpathSync(alias)
    const access = fakeAccess('linux', processRow(240, 1, 240, 501, executable.split('/').at(-1)!), {
      executablePath: alias,
      resolvedExecutablePath: executable,
      readLinuxProcessArgs: () => linuxProcessArgs([alias, '--headless=new']),
      readLinuxExecutable: () => executable
    })
    expect((await access.snapshot())[0]?.executable).toBe(executable)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
