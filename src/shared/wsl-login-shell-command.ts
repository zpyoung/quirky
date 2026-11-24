import { getFishClaudeShellFunction } from './claude-shell-function'
import { buildPosixStdoutFence, type PosixStdoutFence } from './posix-stdout-fence'
import { quotePosixShell } from './shell-argument-quoting'

/**
 * Build `wsl.exe` argv that hands a POSIX script to the guest byte-for-byte.
 *
 * Why: `wsl.exe -d <distro> -- <argv>` expands `$name` in every argument against
 * the guest environment before the guest ever runs — it does this even when no
 * shell is in the command, so `-- /usr/bin/printf %s '$HOME'` prints /home/you.
 * That silently rewrites scripts (`awk '{print $2}'` loses its field ref) and no
 * amount of escaping on our side is reliable. `--exec` skips that preprocessing
 * and passes argv through untouched, so scripts mean what they say.
 */
export function buildWslExecArgs(
  distro: string | undefined,
  shellArgs: readonly string[],
  options: { user?: string } = {}
): string[] {
  return [
    ...(distro ? ['-d', distro] : []),
    ...(options.user ? ['-u', options.user] : []),
    '--exec',
    ...shellArgs
  ]
}

export function buildWslLoginShellCommand(command: string): string {
  const quotedCommand = quotePosixShell(command)
  return [
    '_quirky_wsl_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    'if [ -z "$_quirky_wsl_shell" ] || [ ! -x "$_quirky_wsl_shell" ]; then',
    '  _quirky_wsl_shell="${SHELL:-/bin/bash}"',
    'fi',
    'if [ -z "$_quirky_wsl_shell" ] || [ ! -x "$_quirky_wsl_shell" ]; then',
    '  _quirky_wsl_shell=/bin/sh',
    'fi',
    '_quirky_wsl_shell_name=$(basename "$_quirky_wsl_shell" | tr "[:upper:]" "[:lower:]")',
    'case "$_quirky_wsl_shell_name" in',
    `  sh|dash) exec "$_quirky_wsl_shell" -lc ${quotedCommand} ;;`,
    `  bash|zsh|ksh|mksh|ash) exec "$_quirky_wsl_shell" -ilc ${quotedCommand} ;;`,
    `  *) exec /bin/sh -lc ${quotedCommand} ;;`,
    'esac'
  ].join('\n')
}

export type WslCapturedLoginShellCommand = PosixStdoutFence

/**
 * Run `command` through the distro login shell and fence its stdout.
 *
 * Why: the login shell has to be interactive for bash/zsh so PATH matches what
 * the user sees in their own terminal (nvm, mise and asdf all install into rc
 * files that only interactive shells read). But an interactive shell also runs
 * the distro's rc/motd, and stock Ubuntu writes its "run a command as
 * administrator" hint to *stdout*. The fence keeps the PATH benefit without the noise.
 */
export function buildWslCapturedLoginShellCommand(
  command: string,
  nonce?: string
): WslCapturedLoginShellCommand {
  const fence = buildPosixStdoutFence(command, 'WSL', nonce)
  return { ...fence, command: buildWslLoginShellCommand(fence.command) }
}

export function buildWslInteractiveLoginShellCommand(): string {
  return [
    '_quirky_wsl_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    'if [ -z "$_quirky_wsl_shell" ] || [ ! -x "$_quirky_wsl_shell" ]; then',
    '  _quirky_wsl_shell="${SHELL:-/bin/bash}"',
    'fi',
    'if [ -z "$_quirky_wsl_shell" ] || [ ! -x "$_quirky_wsl_shell" ]; then',
    '  _quirky_wsl_shell=/bin/sh',
    'fi',
    '_quirky_shell_ready_root=""',
    // Why the explicit root first: the wrapper tree is content-addressed, so its
    // path carries a hash the guest cannot derive. The host publishes the
    // resolved root and WSLENV /p-translates it. The QUIRKY_USER_DATA_PATH branch
    // stays as the fallback for an older host that exports only that.
    'if [ -n "${QUIRKY_SHELL_READY_ROOT:-}" ]; then',
    '  _quirky_shell_ready_root="${QUIRKY_SHELL_READY_ROOT%/}"',
    'elif [ -n "${QUIRKY_USER_DATA_PATH:-}" ]; then',
    '  _quirky_shell_ready_root="${QUIRKY_USER_DATA_PATH%/}/shell-ready"',
    'fi',
    '_quirky_wsl_shell_name=$(basename "$_quirky_wsl_shell" | tr "[:upper:]" "[:lower:]")',
    'case "$_quirky_wsl_shell_name" in',
    '  bash)',
    '    if [ -n "${_quirky_shell_ready_root:-}" ] && [ -f "${_quirky_shell_ready_root}/bash/rcfile" ]; then',
    '      exec "$_quirky_wsl_shell" --rcfile "${_quirky_shell_ready_root}/bash/rcfile"',
    '    fi',
    '    ;;',
    // Why: a WSL fish pane gets no shell-ready wrapper or XDG handoff, so this is its only `claude`.
    '  fish)',
    `    exec "$_quirky_wsl_shell" -l -C ${quotePosixShell(getFishClaudeShellFunction())}`,
    '    ;;',
    '  zsh)',
    '    if [ -n "${_quirky_shell_ready_root:-}" ] && [ -d "${_quirky_shell_ready_root}/zsh" ]; then',
    '      export ZDOTDIR="${_quirky_shell_ready_root}/zsh"',
    '    fi',
    '    ;;',
    'esac',
    'exec "$_quirky_wsl_shell" -l'
  ].join('\n')
}
