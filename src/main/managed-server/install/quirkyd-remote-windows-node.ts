/**
 * Running node.exe on a Windows quirkyd host straight from the SSH exec, with plain argv.
 *
 * sshd hands the command to its DefaultShell, cmd.exe on a stock install or PowerShell when an
 * admin sets it, and Quirky does not probe which. So the line is built from the subset both parse
 * the same way: an unquoted executable path, then arguments that are bare or double-quoted and
 * contain nothing either shell expands (`%`, `$`, backtick, `"`). When the executable path
 * itself needs quoting (a profile with a space), the line falls back to one unencoded
 * `powershell.exe -Command`, which both shells pass through intact. Anything else is refused
 * rather than encoded (docs/reference/windows-edr-posture.md).
 */
import { currentQuirkydFence } from '../activation/quirkyd-activation-fence-scope'
import { QUIRKYD_WINDOWS_FENCE_ARG } from '../host-state/quirkyd-windows-host-fence-ops'
import {
  QUIRKYD_NODE_RUNTIME_DIR_PREFIX,
  QUIRKYD_NODE_RUNTIME_WINDOWS_EXECUTABLE,
  QUIRKYD_RUNTIMES_DIRNAME
} from '../../../shared/quirkyd-artifacts'
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { randomUUID } from 'node:crypto'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import {
  joinRemotePath,
  remoteDirname,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'
import { QUIRKYD_WINDOWS_COMMAND_LINE_UNSAFE_CODE } from '../../quirkyd/quirkyd-host-unavailable'
import {
  QUIRKYD_WINDOWS_HOST_SCRIPT,
  QUIRKYD_WINDOWS_HOST_SCRIPT_FILENAME,
  QUIRKYD_WINDOWS_HOST_SCRIPT_PRESENT,
  type QuirkydWindowsHostOp
} from '../host-state/quirkyd-windows-host-script'

const BARE_EXECUTABLE = /^[A-Za-z]:\\[A-Za-z0-9._+~\\-]*$/u
// Leading digits are quoted: PowerShell would read `1e5` as a number and pass `100000`.
const BARE_ARGUMENT = /^[A-Za-z-][A-Za-z0-9._:+=/\\-]*$/u
// Expanded by cmd.exe (`%`) or PowerShell (`$`, backtick, typographic quotes) inside "..."
const UNQUOTABLE = /["%$`\r\n“”„‘’‚‛]/u

export class QuirkydWindowsCommandLineError extends Error {
  readonly code = QUIRKYD_WINDOWS_COMMAND_LINE_UNSAFE_CODE
  constructor(value: string) {
    super(
      `Quirky cannot pass ${JSON.stringify(value)} to node.exe on this Windows host: it contains ` +
        'a character cmd.exe or PowerShell would expand.'
    )
    this.name = 'QuirkydWindowsCommandLineError'
  }
}

function windowsPath(value: string): string {
  return value.replace(/\//gu, '\\')
}

function quotedArgument(value: string): string {
  if (BARE_ARGUMENT.test(value)) {
    return value
  }
  // A trailing backslash would escape the closing quote for CommandLineToArgvW.
  if (value === '' || UNQUOTABLE.test(value) || value.endsWith('\\')) {
    throw new QuirkydWindowsCommandLineError(value)
  }
  return `"${value}"`
}

/** One node.exe invocation that parses identically under cmd.exe and PowerShell. */
export function quirkydWindowsNodeCommandLine(executable: string, args: readonly string[]): string {
  const program = windowsPath(executable)
  const argv = args.map(quotedArgument)
  if (BARE_EXECUTABLE.test(program)) {
    return [program, ...argv].join(' ')
  }
  // The inner line is single-quoted PowerShell inside one double-quoted argument both shells keep.
  for (const value of [program, ...args]) {
    if (UNQUOTABLE.test(value)) {
      throw new QuirkydWindowsCommandLineError(value)
    }
  }
  const inner = ['&', ...[program, ...args].map(powerShellLiteral)].join(' ')
  return `powershell.exe -NoProfile -NonInteractive -Command "${inner}"`
}

/** `~/.quirky-remote` from the remote home. */
export function quirkydRemoteBaseDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR)
}

/** `~/.quirky-remote`, the parent of every slot and of the runtime store. */
export function quirkydWindowsBaseDir(host: RemoteHostPlatform, slotDir: string): string {
  return remoteDirname(slotDir.replace(/\/+$/u, ''), host)
}

/** This client's pinned node.exe in the runtime store; deterministic from the host's arch. */
export function quirkydWindowsPinnedNodePath(host: RemoteHostPlatform, baseDir: string): string {
  const target: NodeRuntimeTarget = host.arch === 'arm64' ? 'win32-arm64' : 'win32-x64'
  return joinRemotePath(
    host,
    baseDir,
    QUIRKYD_RUNTIMES_DIRNAME,
    `${QUIRKYD_NODE_RUNTIME_DIR_PREFIX}${pinnedNodeRuntimeAsset(target).executableSha256}`,
    QUIRKYD_NODE_RUNTIME_WINDOWS_EXECUTABLE
  )
}

export function quirkydWindowsHostScriptPath(host: RemoteHostPlatform, baseDir: string): string {
  return joinRemotePath(host, baseDir, QUIRKYD_WINDOWS_HOST_SCRIPT_FILENAME)
}

/** `node.exe <host script> <op> <args>`, run by this client's pinned runtime. */
export function quirkydWindowsHostOpCommand(
  host: RemoteHostPlatform,
  baseDir: string,
  op: QuirkydWindowsHostOp,
  args: readonly string[]
): string {
  // Under a held fence, the host script checks it still owns it before running the op.
  const fence = currentQuirkydFence()
  return quirkydWindowsNodeCommandLine(quirkydWindowsPinnedNodePath(host, baseDir), [
    quirkydWindowsHostScriptPath(host, baseDir),
    ...(fence ? [QUIRKYD_WINDOWS_FENCE_ARG, fence.lockDir, fence.token] : []),
    op,
    ...args
  ])
}

export function quirkydWindowsSlotOpCommand(
  host: RemoteHostPlatform,
  slotDir: string,
  op: QuirkydWindowsHostOp,
  args: readonly string[]
): string {
  return quirkydWindowsHostOpCommand(host, quirkydWindowsBaseDir(host, slotDir), op, args)
}

export function quirkydWindowsHomeOpCommand(
  host: RemoteHostPlatform,
  remoteHome: string,
  op: QuirkydWindowsHostOp,
  args: readonly string[]
): string {
  return quirkydWindowsHostOpCommand(host, quirkydRemoteBaseDir(host, remoteHome), op, args)
}

// Content-addressed paths this connection already saw on the host.
const stagedHostScripts = new WeakMap<QuirkydHostTransport, Set<string>>()

/**
 * Stages the host script before any host op. The name is content-addressed, so it is written
 * only when missing, and through a partial file and a rename: a concurrent node.exe never reads
 * a truncated script.
 */
export async function installQuirkydWindowsHostScript(
  target: { conn: QuirkydHostTransport; host: RemoteHostPlatform; signal?: AbortSignal },
  baseDir: string
): Promise<void> {
  const scriptPath = quirkydWindowsHostScriptPath(target.host, baseDir)
  const staged = stagedHostScripts.get(target.conn) ?? new Set<string>()
  stagedHostScripts.set(target.conn, staged)
  if (staged.has(scriptPath)) {
    return
  }
  // Both checks run a host-script op on the pinned node.exe, staged first: no inline code.
  const runOp = async (
    script: string,
    op: QuirkydWindowsHostOp,
    args: string[]
  ): Promise<boolean> => {
    const command = quirkydWindowsNodeCommandLine(
      quirkydWindowsPinnedNodePath(target.host, baseDir),
      [script, op, ...args]
    )
    const answer = await execCommand(target.conn, command, {
      wrapCommand: false,
      signal: target.signal
    }).catch((error: unknown) => {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      // A missing script makes node.exe exit nonzero, which reads as "not present".
      return ''
    })
    return answer.trim().split(/\r?\n/u).at(-1) === QUIRKYD_WINDOWS_HOST_SCRIPT_PRESENT
  }
  if (!(await runOp(scriptPath, 'script-present', []))) {
    const partial = `${scriptPath}.${randomUUID()}.partial`
    await target.conn.writeFile(partial, QUIRKYD_WINDOWS_HOST_SCRIPT, {
      hostPlatform: target.host,
      signal: target.signal
    })
    if (!(await runOp(partial, 'script-install', [scriptPath]))) {
      throw new Error(`Could not stage the quirkyd host script at ${scriptPath}.`)
    }
  }
  staged.add(scriptPath)
}

/** The decoded payload after `marker`, or null when the host printed no such line. */
export function readQuirkydWindowsEncodedAnswer(output: string, marker: string): string | null {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .findLast((candidate) => candidate === marker || candidate.startsWith(`${marker} `))
  if (line === undefined) {
    return null
  }
  const encoded = line.slice(marker.length).trim()
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    return null
  }
  return Buffer.from(encoded, 'base64').toString('utf8')
}
