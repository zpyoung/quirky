import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentKind } from '@quirky/protocol'

export const AGENT_TITLES: Record<AgentKind, string> = {
  shell: 'Shell',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini'
}

export function defaultCliEntry(): string {
  return process.env.QUIRKY_CLI_ENTRY ?? fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
}

/** Single-quotes `value` for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function doubleQuote(value: string, keepPathReference = false): string {
  const escaped = value.replace(/[\\"$`]/g, '\\$&')
  return `"${escaped}${keepPathReference ? ':$PATH' : ''}"`
}

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])

function shellKind(shell: string): 'zsh' | 'bash' | 'posix' | 'other' {
  const name = basename(shell).replace(/^-/, '')
  if (name === 'zsh') return 'zsh'
  if (name === 'bash') return 'bash'
  return POSIX_SHELLS.has(name) ? 'posix' : 'other'
}

export function zshWrapperDir(home: string): string {
  return join(home, 'shell', 'zsh')
}

export function bashRcfilePath(home: string): string {
  return join(home, 'shell', 'bash', 'rcfile')
}

/**
 * The argv for a session. Agents run under the user's login shell so CLIs installed through
 * Homebrew, nvm and similar resolve as they do in Terminal; the bin dir is exported inside the
 * command string because the login shell's startup files may have reset PATH. A shell session
 * starts through a wrapper (see `installShellWrappers`) so the same holds for interactive shells.
 */
export function buildArgv(options: {
  agent: AgentKind
  prompt?: string
  home: string
  shell: string
}): string[] {
  const { agent, home, shell } = options
  const kind = shellKind(shell)
  if (agent === 'shell') {
    return kind === 'bash' ? [shell, '--rcfile', bashRcfilePath(home), '-i'] : [shell, '-l']
  }
  const prompt = options.prompt?.trim()
  let command: string
  switch (agent) {
    case 'claude':
      command = `claude --settings ${shellQuote(claudeSettingsPath(home))}`
      if (prompt) command += ` ${shellQuote(prompt)}`
      break
    case 'codex': {
      const notify = `notify=${JSON.stringify([join(home, 'bin', 'quirky-hook'), 'codex'])}`
      command = `codex -c ${shellQuote(notify)}`
      if (prompt) command += ` ${shellQuote(prompt)}`
      break
    }
    case 'opencode':
      command = 'opencode'
      if (prompt) command += ` --prompt ${shellQuote(prompt)}`
      break
    case 'gemini':
      command = 'gemini'
      if (prompt) command += ` --prompt-interactive ${shellQuote(prompt)}`
      break
  }
  const exportPath = kind === 'other' ? '' : `export PATH=${doubleQuote(join(home, 'bin'), true)}; `
  return [shell, '-l', '-c', `${exportPath}exec ${command}`]
}

/** The environment given to a session's process; the daemon's own QUIRKY_* variables are not passed on. */
export function buildSessionEnv(options: {
  home: string
  sessionId: string
  worktreeId: string
  hookUrl: string
  hookToken: string
  /** With `agent`, selects the shell startup wrapper; omitted means no wrapper. */
  shell?: string
  agent?: AgentKind
  base?: Record<string, string | undefined>
}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.base ?? process.env)) {
    if (value !== undefined && !key.startsWith('QUIRKY_')) env[key] = value
  }
  const path = env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'
  const zsh: Record<string, string> =
    options.agent === 'shell' && options.shell && shellKind(options.shell) === 'zsh'
      ? {
          ZDOTDIR: zshWrapperDir(options.home),
          QUIRKY_ORIG_ZDOTDIR: env.ZDOTDIR || env.HOME || homedir()
        }
      : {}
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    QUIRKY_HOME: options.home,
    QUIRKY_SESSION_ID: options.sessionId,
    QUIRKY_WORKTREE_ID: options.worktreeId,
    QUIRKY_HOOK_URL: options.hookUrl,
    QUIRKY_HOOK_TOKEN: options.hookToken,
    ...zsh,
    PATH: `${join(options.home, 'bin')}:${path}`
  }
}

export function claudeSettingsPath(home: string): string {
  return join(home, 'hooks', 'claude-settings.json')
}

export const QUIRKY_HOOK_SCRIPT = `#!/bin/sh
agent="$1"
[ -n "$QUIRKY_HOOK_URL" ] || exit 0
if [ "$agent" = "codex" ]; then
  for last; do :; done
  payload="$last"
else
  payload="$(cat)"
fi
printf '%s' "$payload" | curl -s -m 5 -o /dev/null -X POST \\
  -H "x-quirky-hook-token: $QUIRKY_HOOK_TOKEN" \\
  -H 'content-type: application/json' \\
  --data-binary @- \\
  "$QUIRKY_HOOK_URL/$agent?session=$QUIRKY_SESSION_ID" >/dev/null 2>&1
exit 0
`

export function quirkyShimScript(cliEntry: string): string {
  return `#!/bin/sh\nexec ${doubleQuote(process.execPath)} ${doubleQuote(cliEntry)} "$@"\n`
}

export function claudeSettings(home: string): unknown {
  const command = `${shellQuote(join(home, 'bin', 'quirky-hook'))} claude`
  const entry = (matcher?: string) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command }]
  })
  return {
    hooks: {
      UserPromptSubmit: [entry()],
      PreToolUse: [entry('*')],
      Notification: [entry()],
      Stop: [entry()]
    }
  }
}

const ZSH_PRELUDE = `: \${_quirky_wrapper_dir:=$ZDOTDIR}
: \${_quirky_user_dir:=\${QUIRKY_ORIG_ZDOTDIR:-$HOME}}`

function zshSourceUser(file: string): string {
  return `if [[ -r $_quirky_user_dir/${file} ]]; then
  ZDOTDIR=$_quirky_user_dir
  builtin source -- "$_quirky_user_dir/${file}"
  _quirky_user_dir=\${ZDOTDIR:-$HOME}
  ZDOTDIR=$_quirky_wrapper_dir
fi`
}

function zshWrapperFiles(binDir: string): Record<string, string> {
  const bin = shellQuote(binDir)
  const prependBin = `path=(${bin} \${path:#${bin}})`
  const header = '# generated by quirkyd; sources the matching file from the user ZDOTDIR\n'
  return {
    '.zshenv': `${header}${ZSH_PRELUDE}\n${zshSourceUser('.zshenv')}\n`,
    '.zprofile': `${header}${ZSH_PRELUDE}\n${zshSourceUser('.zprofile')}\n`,
    '.zshrc': `${header}${ZSH_PRELUDE}
if [[ -n \${HISTFILE-} && $HISTFILE == $_quirky_wrapper_dir/* ]]; then
  HISTFILE=$_quirky_user_dir/\${HISTFILE:t}
fi
${zshSourceUser('.zshrc')}
${prependBin}
`,
    '.zlogin': `${header}${ZSH_PRELUDE}
${zshSourceUser('.zlogin')}
${prependBin}
ZDOTDIR=$_quirky_user_dir
unset _quirky_wrapper_dir _quirky_user_dir
`
  }
}

function bashRcfile(binDir: string): string {
  return `# generated by quirkyd; reproduces a login shell's startup files, then puts the bin dir first
[ -r /etc/profile ] && . /etc/profile
__quirky_profile=
for __quirky_file in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__quirky_file" ]; then
    __quirky_profile=$__quirky_file
    . "$__quirky_file"
    break
  fi
done
if [ -r "$HOME/.bashrc" ] && ! grep -qs bashrc "$__quirky_profile" 2>/dev/null; then
  . "$HOME/.bashrc"
fi
unset __quirky_profile __quirky_file
__quirky_bin=${shellQuote(binDir)}
__quirky_rest=":$PATH:"
__quirky_rest="\${__quirky_rest//:$__quirky_bin:/:}"
__quirky_rest="\${__quirky_rest#:}"
__quirky_rest="\${__quirky_rest%:}"
if [ -n "$__quirky_rest" ]; then PATH="$__quirky_bin:$__quirky_rest"; else PATH="$__quirky_bin"; fi
export PATH
unset __quirky_bin __quirky_rest
`
}

/**
 * Writes the interactive shell wrappers under `<home>/shell`: a zsh ZDOTDIR whose startup files
 * source the user's own and then put the bin dir first, and a bash rcfile that does the same.
 * Rewritten on every call, so the directory is never edited by hand.
 */
export function installShellWrappers(home: string): void {
  const binDir = join(home, 'bin')
  const zshDir = zshWrapperDir(home)
  mkdirSync(zshDir, { recursive: true })
  for (const [name, content] of Object.entries(zshWrapperFiles(binDir))) {
    writeFileSync(join(zshDir, name), content)
  }
  mkdirSync(join(home, 'shell', 'bash'), { recursive: true })
  writeFileSync(bashRcfilePath(home), bashRcfile(binDir))
}

/** Writes the Claude settings file, the `quirky-hook` and `quirky` shims and the shell wrappers under `home`. */
export function installIntegrationFiles(home: string, cliEntry: string): void {
  mkdirSync(join(home, 'hooks'), { recursive: true })
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(claudeSettingsPath(home), JSON.stringify(claudeSettings(home), null, 2))
  const hookPath = join(home, 'bin', 'quirky-hook')
  const shimPath = join(home, 'bin', 'quirky')
  writeFileSync(hookPath, QUIRKY_HOOK_SCRIPT)
  writeFileSync(shimPath, quirkyShimScript(cliEntry))
  chmodSync(hookPath, 0o755)
  chmodSync(shimPath, 0o755)
  installShellWrappers(home)
}
