/**
 * Small JSON records Quirky keeps on an quirkyd host (activation, transactions, stop receipts).
 *
 * Reads are bounded and never swallow a failure: a record that could not be read is not an
 * absent one, and treating it as absent is how a client deploys over a live install.
 */
import { randomUUID } from 'node:crypto'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { removeRemoteFileCommand } from '../../ssh/ssh-remote-commands'
import { execQuirkydRemote, type QuirkydRemoteExecTarget } from './quirkyd-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { isWindowsRemoteHost } from '../../ssh/ssh-remote-platform'
import {
  quirkydRemoteBaseDir,
  quirkydWindowsHostOpCommand,
  readQuirkydWindowsEncodedAnswer
} from './quirkyd-remote-windows-node'
import {
  QUIRKYD_RECORD_ABSENT_MARKER as ABSENT_MARKER,
  QUIRKYD_RECORD_PRESENT_MARKER as PRESENT_MARKER
} from '../host-state/quirkyd-windows-host-script'

/** `present` carries raw bytes; schema checks belong to the caller that owns the format. */
export type QuirkydRemoteRecordRead = { state: 'absent' } | { state: 'present'; raw: string }

/** `~/.quirky-remote`, where the host script and the pinned runtime live. */
function windowsBaseDir(target: QuirkydRemoteExecTarget): string {
  if (!target.remoteHome) {
    throw new Error(
      'quirkyd host records on Windows need the remote home to find the pinned node.exe'
    )
  }
  return quirkydRemoteBaseDir(target.host, target.remoteHome)
}

export async function readBoundedQuirkydRemoteRecord(
  target: QuirkydRemoteExecTarget,
  path: string,
  maxBytes: number
): Promise<QuirkydRemoteRecordRead> {
  if (isWindowsRemoteHost(target.host)) {
    return readWindowsRecord(target, path, maxBytes)
  }
  const file = quotePosixShell(path)
  // Why markers: an empty stdout must never be mistaken for "no record" when the read failed.
  const output = await execQuirkydRemote(
    target,
    `if [ ! -e ${file} ] && [ ! -L ${file} ]; then printf '%s\\n' ${ABSENT_MARKER}; exit 0; fi; ` +
      `[ -f ${file} ] || exit 65; size=$(wc -c < ${file}) || exit 65; ` +
      `[ "$size" -le ${maxBytes} ] || exit 65; ` +
      `printf '%s\\n' ${PRESENT_MARKER}; cat ${file}`
  )
  const newline = output.indexOf('\n')
  const marker = (newline === -1 ? output : output.slice(0, newline)).trim()
  if (marker === ABSENT_MARKER) {
    return { state: 'absent' }
  }
  if (marker !== PRESENT_MARKER) {
    throw new Error('quirkyd host record read returned no verifiable answer')
  }
  return { state: 'present', raw: newline === -1 ? '' : output.slice(newline + 1) }
}

async function readWindowsRecord(
  target: QuirkydRemoteExecTarget,
  path: string,
  maxBytes: number
): Promise<QuirkydRemoteRecordRead> {
  const output = await execQuirkydRemote(
    target,
    quirkydWindowsHostOpCommand(target.host, windowsBaseDir(target), 'record-read', [
      path,
      String(maxBytes)
    ])
  )
  if (output.split(/\r?\n/u).some((line) => line.trim() === ABSENT_MARKER)) {
    return { state: 'absent' }
  }
  const raw = readQuirkydWindowsEncodedAnswer(output, PRESENT_MARKER)
  if (raw === null) {
    throw new Error('quirkyd host record read returned no verifiable answer')
  }
  return { state: 'present', raw }
}

export async function writeAtomicQuirkydRemoteRecord(
  target: QuirkydRemoteExecTarget,
  path: string,
  contents: string
): Promise<void> {
  const partialPath = `${path}.partial.${process.pid}.${randomUUID()}`
  const baseDir = isWindowsRemoteHost(target.host) ? windowsBaseDir(target) : null
  try {
    if (baseDir) {
      await target.conn.writeFile(partialPath, contents, {
        hostPlatform: target.host,
        signal: target.signal
      })
      await execQuirkydRemote(
        target,
        quirkydWindowsHostOpCommand(target.host, baseDir, 'record-publish', [partialPath, path])
      )
      return
    }
    await execQuirkydRemote(
      target,
      `umask 077; printf %s ${quotePosixShell(contents)} > ${quotePosixShell(partialPath)} && ` +
        `mv -f ${quotePosixShell(partialPath)} ${quotePosixShell(path)}`
    )
  } catch (error) {
    // Why keep the partial on an unconfirmed termination: the write may still be running there.
    if (!isUnconfirmedSshCommandTermination(error)) {
      const discard = baseDir
        ? quirkydWindowsHostOpCommand(target.host, baseDir, 'remove-file', [partialPath])
        : removeRemoteFileCommand(target.host, partialPath)
      await execQuirkydRemote(target, discard).catch(() => {})
    }
    throw error
  }
}
