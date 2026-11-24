/**
 * Where macOS says the daemon pid's own executable is now (#21826).
 * `resolved`: an existing file outside a ShipIt directory (not a claim it is the installed app).
 * `parked`: inside a Squirrel `…ShipIt…` directory, where an update moves the outgoing bundle.
 * `unresolvable`: the file is gone, which is where tccd loses the daemon's code identity.
 * `probe-failed`: not macOS, no pid, no codesign, timeout, or unrecognised output.
 */
export const DAEMON_CODE_IDENTITY_VALUES = [
  'resolved',
  'parked',
  'unresolvable',
  'probe-failed'
] as const
export type DaemonCodeIdentity = (typeof DAEMON_CODE_IDENTITY_VALUES)[number]

/** Which macOS-protected folder class the denied cwd falls under. */
export const DAEMON_PTY_CWD_CLASSES = [
  'documents',
  'desktop',
  'downloads',
  'other-home',
  'outside-home'
] as const
export type DaemonPtyCwdClass = (typeof DAEMON_PTY_CWD_CLASSES)[number]

/**
 * The classes macOS gates behind a per-app TCC row, which is what `tccutil reset` acts on. The
 * other two are denied through something else, so there is no row to clear and no reset to offer.
 */
export const MAC_TCC_FOLDER_CLASSES = ['documents', 'desktop', 'downloads'] as const
export type MacTccFolderClass = (typeof MAC_TCC_FOLDER_CLASSES)[number]

export function isMacTccFolderClass(cwdClass: DaemonPtyCwdClass): cwdClass is MacTccFolderClass {
  return MAC_TCC_FOLDER_CLASSES.some((name) => name === cwdClass)
}

export function classifyDaemonPtyCwd(cwd: string, homeDir: string): DaemonPtyCwdClass {
  const home = homeDir.replace(/\/+$/, '')
  if (!home || !(cwd === home || cwd.startsWith(`${home}/`))) {
    return 'outside-home'
  }
  const topLevel = cwd.slice(home.length + 1).split('/')[0]
  switch (topLevel) {
    case 'Documents':
      return 'documents'
    case 'Desktop':
      return 'desktop'
    case 'Downloads':
      return 'downloads'
    default:
      return 'other-home'
  }
}
