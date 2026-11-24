import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import type { QuirkydMachineHomeProbe } from './quirkyd-machine-home'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Each "machine" is a real local shell whose `uname -n` answers that machine's hostname.
const shell = vi.hoisted((): { env: NodeJS.ProcessEnv | undefined } => ({
  env: undefined
}))
vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => {
  const { runProcess } = await import('@quirky/process-host')
  return {
    ...(await importOriginal<typeof ExecCommandModule>()),
    execCommand: async (conn: { env?: NodeJS.ProcessEnv }, command: string) => {
      const env = conn.env ?? shell.env
      // An SSH gateway that merges the command's stderr into stdout.
      const merged = env?.QUIRKY_TEST_MERGE_STDERR === '1'
      const result = await runProcess({
        program: '/bin/sh',
        args: ['-c', merged ? `{ ${command}\n} 2>&1` : command],
        env
      })
      if (result.code !== 0) {
        const { sshCommandExitError } = await import('../../ssh/remote-exec/remote-exec-command')
        throw sshCommandExitError(command, result.code ?? 1, result.stdout)
      }
      return result.stdout
    }
  }
})

const { resolveQuirkydMachineHome } = await import('../install/quirkyd-remote-context')
const {
  decideQuirkydMachineHome,
  quirkydMachineIdentity,
  quirkydMachineOwnershipUnresolvedMessage,
  parseQuirkydMachineHomeProbe,
  QUIRKYD_MACHINE_CLAIM_FILENAME,
  QUIRKYD_MACHINE_HOMES_DIRNAME
} = await import('./quirkyd-machine-home')
const { QUIRKYD_MACHINE_CLAIM_ARBITER_DIRNAME } = await import('./quirkyd-machine-claim-command')
const { computeRemoteInstallDir } = await import('../install/remote-versioned-install')
const { QUIRKYD_INSTALL_MODEL } = await import('../install/remote-install-model')
const { quirkydLivenessProbeCommand } = await import('../install/quirkyd-remote-launch')
const { QUIRKYD_PID_FILENAME } = await import('../install/quirkyd-remote-host-support')
const { execQuirkydRemote } = await import('../install/quirkyd-remote-runtime-control')
const { getRemoteHostPlatform } = await import('../../ssh/ssh-remote-platform')
type Probe = QuirkydMachineHomeProbe
type Host = RemoteHostPlatform

const linux = getRemoteHostPlatform('linux-x64')
const darwin = getRemoteHostPlatform('darwin-arm64')
const POSIX = process.platform !== 'win32'

let scratch: string
let home: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'quirkyd-machine-home-'))
  home = join(scratch, 'shared-home')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The fake machine's hardware UUID, as `ioreg` answers its `IOPlatformUUID`. */
function uuidOf(name: string): string {
  const hex = Buffer.from(name.padEnd(16, '-')).toString('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function ioregOutput(name: string): string {
  return `+-o J316sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "${uuidOf(name).toUpperCase()}"\n`
}

type MachineOptions = {
  /** A filesystem without hard links: every `ln` fails. */
  noHardLinks?: boolean
  /** Holds each machine's write of the claim until both arrive, then delays this one's. */
  claimWriteDelay?: number
  /** What `df -P` names as the home's source, e.g. an NFS export or a local disk. */
  homeSource?: string
  /** What `df -P` reports free, in KB. */
  availableKb?: number
  /** `mv` onto the claim fails with this error, as on a full disk. */
  claimMoveError?: string
  /** `cat` warns on stderr, which a gateway merges into the answer (#30491). */
  catStderrNoise?: string
}

/** A (macOS-flavored) machine sharing `home`, as on an NFS-mounted cluster home. */
function machine(name: string, hostname = name, options: MachineOptions = {}) {
  const bin = join(scratch, `bin-${name}-${hostname}`)
  mkdirSync(bin, { recursive: true })
  const tool = (tool: string, script: string): void => {
    writeFileSync(join(bin, tool), `#!/bin/sh\n${script}\n`)
    chmodSync(join(bin, tool), 0o755)
  }
  tool('uname', `echo ${hostname}`)
  tool('ioreg', `printf '%s' '${ioregOutput(name)}'`)
  // As on macOS, which has no such OID.
  tool('sysctl', `echo "sysctl: unknown oid '$2'" >&2; exit 1`)
  if (options.homeSource !== undefined || options.availableKb !== undefined) {
    tool(
      'df',
      `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n%s 100 1 ${options.availableKb ?? 99} 1%% /home\\n' '${options.homeSource ?? '/dev/disk3s5'}'`
    )
  }
  if (options.claimMoveError !== undefined) {
    tool(
      'mv',
      [
        'for last; do :; done',
        `case "$last" in */${QUIRKYD_MACHINE_CLAIM_FILENAME}) echo "mv: ${options.claimMoveError}" >&2; exit 1;; esac`,
        'exec /bin/mv "$@"'
      ].join('\n')
    )
  }
  if (options.noHardLinks) {
    tool('ln', 'echo "ln: Operation not supported" >&2; exit 1')
  }
  if (options.claimWriteDelay !== undefined) {
    const barrier = join(scratch, 'claim-write-barrier')
    mkdirSync(barrier, { recursive: true })
    tool(
      'mv',
      [
        'for last; do :; done',
        `case "$last" in */${QUIRKYD_MACHINE_CLAIM_FILENAME})`,
        `  : > '${barrier}/'$$; i=0`,
        `  while [ "$(ls '${barrier}' | wc -l)" -lt 2 ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i + 1)); done`,
        `  sleep ${options.claimWriteDelay};;`,
        'esac',
        'exec /bin/mv "$@"'
      ].join('\n')
    )
  }
  if (options.catStderrNoise !== undefined) {
    // Before and right after the claim, which ends with no newline.
    tool(
      'cat',
      `echo '${options.catStderrNoise}' >&2; /bin/cat "$@"; s=$?; printf '%s' '${options.catStderrNoise}' >&2; exit $s`
    )
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    QUIRKY_TEST_MERGE_STDERR: options.catStderrNoise === undefined ? '0' : '1'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked execCommand reads only env.
  const conn = {
    env
  } as unknown as QuirkydHostTransport
  return { conn, host: darwin, env }
}

function loginHomeResult() {
  return { loginHome: home, quirkydHome: home, userDataDir: join(home, '.quirky') }
}

function claimPath(): string {
  return join(home, '.quirky-remote', QUIRKYD_MACHINE_CLAIM_FILENAME)
}

function legacyOwner(name: string, machineIdentity: string | null = uuidOf(name)): void {
  const dir = join(home, '.quirky', '.profile-state-access', 'participants', 'token')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'token.owner'),
    JSON.stringify({
      token: 'token',
      pid: 4242,
      host: name,
      platform: 'darwin',
      ...(machineIdentity === null ? {} : { machineIdentity })
    })
  )
}

describe.runIf(POSIX)('resolveQuirkydMachineHome on a home several machines share', () => {
  it('gives the first machine the login home and every other machine its own', async () => {
    const a = machine('node-a')
    const b = machine('node-b')

    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
    const bHome = await resolveQuirkydMachineHome(b, true)
    expect(bHome.loginHome).toBe(home)
    expect(bHome.quirkydHome).toMatch(
      new RegExp(`^${home}/\\.quirky-remote/${QUIRKYD_MACHINE_HOMES_DIRNAME}/[a-f0-9]{16}$`)
    )
    expect(statSync(bHome.quirkydHome).mode & 0o777).toBe(0o700)
    // A sibling of `~/.quirky`, so the runtime socket inside it stays within the path limit.
    expect(bHome.userDataDir).toMatch(new RegExp(`^${home}/\\.quirky-[a-f0-9]{8}$`))

    // Stable on every later connect, in either order.
    expect(await resolveQuirkydMachineHome(b, true)).toEqual(bHome)
    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
    expect(
      computeRemoteInstallDir(QUIRKYD_INSTALL_MODEL, bHome.quirkydHome, '0.1.0+abc').startsWith(
        `${bHome.quirkydHome}/.quirky-remote/`
      )
    ).toBe(true)
  })

  it('never judges another machine’s PID: the second machine probes only its own slot', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    await resolveQuirkydMachineHome(a, true)
    // node-a's live quirkyd: a PID that means nothing on node-b.
    const aSlot = computeRemoteInstallDir(QUIRKYD_INSTALL_MODEL, home, '0.1.0+abc')
    mkdirSync(aSlot, { recursive: true })
    writeFileSync(join(aSlot, QUIRKYD_PID_FILENAME), '999999\n')

    const { quirkydHome } = await resolveQuirkydMachineHome(b, true)
    const bSlot = computeRemoteInstallDir(QUIRKYD_INSTALL_MODEL, quirkydHome, '0.1.0+abc')
    expect(bSlot).not.toBe(aSlot)
    const answer = await execQuirkydRemote(b, quirkydLivenessProbeCommand(darwin, bSlot))
    expect(answer.trim()).toBe('NEVER_LAUNCHED')
    expect(readFileSync(join(aSlot, QUIRKYD_PID_FILENAME), 'utf8')).toBe('999999\n')
  })

  it('upgrades an existing single-machine install in place', async () => {
    const a = machine('node-a')
    mkdirSync(join(home, '.quirky-remote', 'quirkyd-0.1.0+abc'), {
      recursive: true
    })
    writeFileSync(join(home, '.quirky-remote', 'quirkyd-active.json'), '{"schemaVersion":1}')
    mkdirSync(join(home, '.quirky', 'profiles'), { recursive: true })
    legacyOwner('node-a')

    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
    expect(existsSync(claimPath())).toBe(true)
    expect(readFileSync(join(home, '.quirky-remote', 'quirkyd-active.json'), 'utf8')).toBe(
      '{"schemaVersion":1}'
    )
    expect(existsSync(join(home, '.quirky-remote', QUIRKYD_MACHINE_HOMES_DIRNAME))).toBe(false)
  })

  it('leaves an unclaimed install to the machine whose quirkyd holds its data root', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    legacyOwner('node-a')

    const bHome = await resolveQuirkydMachineHome(b, true)
    expect(bHome.quirkydHome).not.toBe(home)
    expect(existsSync(claimPath())).toBe(false)

    // node-a's quirkyd exits; node-b must stay on its own home, not move onto node-a's install.
    rmSync(join(home, '.quirky'), { recursive: true })
    expect(await resolveQuirkydMachineHome(b, true)).toEqual(bHome)
    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('lets exactly one of two machines claiming at once win', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    const homes = await Promise.all([
      resolveQuirkydMachineHome(a, true),
      resolveQuirkydMachineHome(b, true)
    ])
    expect(homes.filter((resolved) => resolved.quirkydHome === home)).toHaveLength(1)
    // No partial claim is left behind.
    expect(readdirNames(join(home, '.quirky-remote'))).toEqual(
      [QUIRKYD_MACHINE_CLAIM_FILENAME, QUIRKYD_MACHINE_HOMES_DIRNAME].sort()
    )
  })

  it('keeps a Mac whose quirkyd predates macOS machine identity on its running install', async () => {
    const a = machine('node-a')
    mkdirSync(join(home, '.quirky-remote', 'quirkyd-0.1.0+abc'), { recursive: true })
    // Older quirkyds on macOS recorded no machine identity at all.
    legacyOwner('node-a', null)
    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('never lets another Mac claim a live install whose owner recorded no machine identity', async () => {
    const nfs = { homeSource: 'filer:/export/home' }
    const b = machine('node-b', 'node-b', nfs)
    mkdirSync(join(home, '.quirky-remote', 'quirkyd-0.1.0+abc'), { recursive: true })
    writeFileSync(join(home, '.quirky-remote', 'quirkyd-active.json'), '{"schemaVersion":1}')
    // node-a's older quirkyd is running: its owner names only node-a's hostname.
    legacyOwner('node-a', null)

    await expect(resolveQuirkydMachineHome(b, true)).rejects.toThrow(
      /recorded only a hostname[\s\S]*If node-b set it up/
    )
    expect(existsSync(claimPath())).toBe(false)
    // The same Mac under a drifted hostname is just as unprovable, so it is not claimed either.
    await expect(
      resolveQuirkydMachineHome(machine('node-a', 'cafe-wifi', nfs), true)
    ).rejects.toThrow(/recorded only a hostname/)
    // node-a, still under the name its owner recorded, keeps its own install.
    expect(await resolveQuirkydMachineHome(machine('node-a', 'node-a', nfs), true)).toEqual(
      loginHomeResult()
    )
  })

  it('lets exactly one machine claim a home on a filesystem without hard links', async () => {
    const a = machine('node-a', 'node-a', { noHardLinks: true, claimWriteDelay: 0 })
    const b = machine('node-b', 'node-b', { noHardLinks: true, claimWriteDelay: 0.5 })
    const homes = await Promise.all([
      resolveQuirkydMachineHome(a, true),
      resolveQuirkydMachineHome(b, true)
    ])
    expect(homes.filter((resolved) => resolved.quirkydHome === home)).toHaveLength(1)
    expect(readdirNames(join(home, '.quirky-remote'))).toEqual(
      [
        QUIRKYD_MACHINE_CLAIM_ARBITER_DIRNAME,
        QUIRKYD_MACHINE_CLAIM_FILENAME,
        QUIRKYD_MACHINE_HOMES_DIRNAME
      ].sort()
    )
    expect(
      readdirNames(join(home, '.quirky-remote', QUIRKYD_MACHINE_CLAIM_ARBITER_DIRNAME))
    ).toEqual([QUIRKYD_MACHINE_CLAIM_FILENAME])
    // Stable on later connects.
    expect(
      await Promise.all([resolveQuirkydMachineHome(a, true), resolveQuirkydMachineHome(b, true)])
    ).toEqual(homes)
  })

  it('lets exactly one of two machines replace an empty claim', async () => {
    mkdirSync(join(home, '.quirky-remote'))
    writeFileSync(claimPath(), '')
    const homes = await Promise.all([
      resolveQuirkydMachineHome(machine('node-a', 'node-a', { claimWriteDelay: 0 }), true),
      resolveQuirkydMachineHome(machine('node-b', 'node-b', { claimWriteDelay: 0.5 }), true)
    ])
    expect(homes.filter((resolved) => resolved.quirkydHome === home)).toHaveLength(1)
  })

  it('restores an emptied claim to the machine the arbiter already chose', async () => {
    const a = machine('node-a', 'node-a', { noHardLinks: true })
    const b = machine('node-b', 'node-b', { noHardLinks: true })
    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
    writeFileSync(claimPath(), '')
    expect((await resolveQuirkydMachineHome(b, true)).quirkydHome).not.toBe(home)
    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('keeps a renamed machine on its own install', async () => {
    expect(await resolveQuirkydMachineHome(machine('node-a'), true)).toEqual(loginHomeResult())
    expect(await resolveQuirkydMachineHome(machine('node-a', 'renamed'), true)).toEqual(
      loginHomeResult()
    )
  })

  it('replaces an empty claim a full disk left behind', async () => {
    mkdirSync(join(home, '.quirky-remote'))
    writeFileSync(claimPath(), '')
    expect(await resolveQuirkydMachineHome(machine('node-a'), true)).toEqual(loginHomeResult())
    expect(readFileSync(claimPath(), 'utf8')).toContain('machineKey')
  })

  it.skipIf(process.getuid?.() === 0)(
    'says why it could not write the claim, and leaves no partial behind (#30491)',
    async () => {
      const remote = mkdirp(home, '.quirky-remote')
      chmodSync(remote, 0o500)
      try {
        await expect(resolveQuirkydMachineHome(machine('node-a'), true)).rejects.toThrow(
          /^quirkyd could not claim this host's \.quirky-remote: could not write a claim file in ~\/\.quirky-remote: .*Permission denied.*belongs to this user and is writable/u
        )
        expect(readdirSync(remote)).toEqual([])
      } finally {
        chmodSync(remote, 0o700)
      }
    }
  )

  it('reads the claim through a gateway that merges shell noise into the answer (#30491)', async () => {
    const noisy = { catStderrNoise: 'bash: warning: setlocale: LC_ALL: cannot change locale' }
    expect(await resolveQuirkydMachineHome(machine('node-a', 'node-a', noisy), true)).toEqual(
      loginHomeResult()
    )
    expect(
      (await resolveQuirkydMachineHome(machine('node-b', 'node-b', noisy), true)).quirkydHome
    ).not.toBe(home)
  })

  it('names a full disk when the claim cannot be moved into place (#30491)', async () => {
    const full = { noHardLinks: true, availableKb: 0, claimMoveError: 'No space left on device' }
    await expect(
      resolveQuirkydMachineHome(machine('node-a', 'node-a', full), true)
    ).rejects.toThrow(
      /could not move the claim into place at ~\/\.quirky-remote\/quirkyd-machine\.json: mv: No space left on device\. The filesystem holding ~\/\.quirky-remote has 0 KB free/u
    )
    expect(existsSync(claimPath())).toBe(false)
    // Once there is room the same machine claims the home.
    expect(await resolveQuirkydMachineHome(machine('node-a', 'node-a-freed'), true)).toEqual(
      loginHomeResult()
    )
  })

  it('refuses to guess when the claim cannot be read', async () => {
    mkdirSync(join(home, '.quirky-remote'))
    writeFileSync(claimPath(), 'not json')
    await expect(resolveQuirkydMachineHome(machine('node-a'), true)).rejects.toThrow(
      /cannot tell which machine owns/
    )
  })

  it('names no owner for a stopped pre-claim install on a shared home until the user does', async () => {
    const nfs = { homeSource: 'filer:/export/home' }
    const a = machine('node-a', 'node-a', nfs)
    const b = machine('node-b', 'node-b', nfs)
    // node-a's pre-claim quirkyd shut down cleanly, which removes its data-root owner.
    writeFileSync(
      join(mkdirp(home, '.quirky-remote'), 'quirkyd-active.json'),
      '{"schemaVersion":1}'
    )
    mkdirp(home, '.quirky', '.profile-state-access', 'participants')

    await expect(resolveQuirkydMachineHome(b, true)).rejects.toThrow(/can't tell which machine/)
    expect(existsSync(claimPath())).toBe(false)
    expect(existsSync(join(home, '.quirky-remote', QUIRKYD_MACHINE_HOMES_DIRNAME))).toBe(false)

    // The user runs the claim node-a's message names, on node-a.
    const message = await resolveQuirkydMachineHome(a, true).then(
      () => '',
      (error: unknown) => String(error)
    )
    expect(message).toContain('If node-a set it up')
    await execQuirkydRemote(a, message.slice(message.indexOf('reconnect: ') + 'reconnect: '.length))
    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
    expect((await resolveQuirkydMachineHome(b, true)).quirkydHome).not.toBe(home)
  })

  it('claims a shared home whose data root no quirkyd ever activated, and its fix runs anywhere', async () => {
    const a = machine('node-a', 'node-a', { homeSource: 'filer:/export/home' })
    // Another Quirky process (a CLI, say) used the data root; no managed server ever ran here.
    mkdirp(home, '.quirky', '.profile-state-access', 'participants')
    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())

    // The printed fix also works on a home that has no `~/.quirky-remote` yet.
    rmSync(join(home, '.quirky-remote'), { recursive: true })
    const fix = quirkydMachineOwnershipUnresolvedMessage('a'.repeat(16), null)
    await execQuirkydRemote(a, fix.slice(fix.indexOf('reconnect: ') + 'reconnect: '.length))
    expect(readFileSync(claimPath(), 'utf8')).toContain('a'.repeat(16))
  })

  it('claims a stopped pre-claim install on a local disk, which no other machine can share', async () => {
    const a = machine('node-a', 'node-a', { homeSource: '/dev/disk3s5' })
    writeFileSync(
      join(mkdirp(home, '.quirky-remote'), 'quirkyd-active.json'),
      '{"schemaVersion":1}'
    )
    expect(await resolveQuirkydMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('keeps WSL on the login home without probing or claiming', async () => {
    expect(await resolveQuirkydMachineHome(machine('node-a'), false)).toEqual(loginHomeResult())
    expect(existsSync(join(home, '.quirky-remote'))).toBe(false)
  })
})

function mkdirp(...parts: string[]): string {
  const dir = join(...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort()
}

function probe(host: Host, overrides: Partial<Probe> = {}): Probe {
  return {
    loginHome: '/home/u',
    identity: quirkydMachineIdentity(host, 'a'.repeat(32), 'node-a'),
    claim: { state: 'absent' },
    dataRootOwners: [],
    machineHomeKeys: [],
    loginHomeInstalled: false,
    homeOnLocalDisk: false,
    ...overrides
  }
}

describe('decideQuirkydMachineHome', () => {
  it('keys Linux by machine-id alone, so a rename keeps the key', () => {
    const a = quirkydMachineIdentity(linux, 'a'.repeat(32), 'node-a')
    expect(a?.key).toMatch(/^[a-f0-9]{16}$/)
    expect(quirkydMachineIdentity(linux, 'a'.repeat(32), 'renamed')?.key).toBe(a?.key)
    expect(quirkydMachineIdentity(linux, 'b'.repeat(32), 'node-a')?.key).not.toBe(a?.key)
    // No machine-id (many containers): the login home, as before.
    expect(quirkydMachineIdentity(linux, '', 'node-a')).toBeNull()
    expect(quirkydMachineIdentity(linux, '0'.repeat(32), 'node-a')).toBeNull()
  })

  it('keys macOS by hardware UUID alone, since its hostname follows the network', () => {
    const uuid = '12345678-1234-1234-1234-123456789ABC'
    const ioreg = `    "IOPlatformUUID" = "${uuid}"`
    expect(quirkydMachineIdentity(darwin, ioreg, 'cafe-wifi')?.key).toBe(
      quirkydMachineIdentity(darwin, ioreg, 'home-wifi')?.key
    )
    expect(quirkydMachineIdentity(darwin, ioreg, 'cafe-wifi')?.machineIdentity).toBe(
      uuid.toLowerCase()
    )
    // What `sysctl -n kern.hostuuid` printed on macOS: nothing.
    expect(quirkydMachineIdentity(darwin, '', 'cafe-wifi')).toBeNull()
    const renamed = probe(darwin, {
      identity: quirkydMachineIdentity(darwin, ioreg, 'cafe-wifi'),
      dataRootOwners: [{ host: 'home-wifi', machineIdentity: uuid.toLowerCase() }]
    })
    expect(decideQuirkydMachineHome(renamed, darwin).kind).toBe('claim')
  })

  it('judges a data-root owner by machine-id, and by hostname only when it recorded none', () => {
    const other = probe(linux, {
      dataRootOwners: [{ host: 'node-a', machineIdentity: 'b'.repeat(32) }]
    })
    expect(decideQuirkydMachineHome(other, linux).kind).toBe('machine-home')
    const renamed = probe(linux, {
      dataRootOwners: [{ host: 'old-name', machineIdentity: 'a'.repeat(32) }]
    })
    expect(decideQuirkydMachineHome(renamed, linux).kind).toBe('claim')
    const unrecorded = probe(linux, {
      dataRootOwners: [{ host: 'node-b', machineIdentity: null }]
    })
    expect(decideQuirkydMachineHome(unrecorded, linux).kind).toBe('machine-home')
  })

  it('claims no install whose owner names neither its machine nor a matching hostname', () => {
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const mac = quirkydMachineIdentity(darwin, `"IOPlatformUUID" = "${uuid}"`, 'mac-b')
    const otherMac = { host: 'mac-a', machineIdentity: null }
    expect(
      decideQuirkydMachineHome(probe(darwin, { identity: mac, dataRootOwners: [otherMac] }), darwin)
    ).toEqual({ kind: 'unresolved', machineKey: mac?.key, cause: 'unattributed-owner' })
    // A local disk cannot be another machine's.
    expect(
      decideQuirkydMachineHome(
        probe(darwin, { identity: mac, dataRootOwners: [otherMac], homeOnLocalDisk: true }),
        darwin
      ).kind
    ).toBe('claim')
    const nameless = probe(linux, { dataRootOwners: [{ host: null, machineIdentity: null }] })
    expect(decideQuirkydMachineHome(nameless, linux).kind).toBe('unresolved')
  })

  it('reads a Linux home’s filesystem type before its df source', () => {
    const output = (installed: string, type: string, source: string): string =>
      [
        '/home/u',
        'a'.repeat(32),
        'node-a',
        'ABSENT',
        '',
        '',
        installed,
        type,
        `${source} 100 1 99 1% /home`
      ].join('\n__QUIRKY_MACHINE_HOME_SECTION__\n')
    const decide = (installed: string, type: string, source: string) =>
      decideQuirkydMachineHome(
        parseQuirkydMachineHomeProbe(output(installed, type, source), linux),
        linux
      )
    expect(decide('INSTALLED', 'nfs', '/dev/sda1').kind).toBe('unresolved')
    expect(decide('INSTALLED', 'ext2/ext3', 'filer:/export').kind).toBe('claim')
    // No filesystem type (an old busybox): only a device source counts as a local disk.
    expect(decide('INSTALLED', '', '/dev/sda1').kind).toBe('claim')
    expect(decide('INSTALLED', '', 'filer:/export').kind).toBe('unresolved')
    // Nothing ran from the login home yet, so claiming it strands no one.
    expect(decide('', 'nfs', 'filer:/export').kind).toBe('claim')
  })

  it('claims a stopped install only with evidence of whose it is', () => {
    const stopped = { loginHomeInstalled: true }
    expect(decideQuirkydMachineHome(probe(linux, stopped), linux).kind).toBe('unresolved')
    expect(
      decideQuirkydMachineHome(probe(linux, { ...stopped, homeOnLocalDisk: true }), linux).kind
    ).toBe('claim')
    const ownRunning = probe(linux, {
      ...stopped,
      dataRootOwners: [{ host: 'node-a', machineIdentity: 'a'.repeat(32) }]
    })
    expect(decideQuirkydMachineHome(ownRunning, linux).kind).toBe('claim')
  })

  it('keeps the login home when the machine cannot be identified', () => {
    expect(decideQuirkydMachineHome(probe(linux, { identity: null }), linux)).toEqual({
      kind: 'login-home'
    })
  })
})
