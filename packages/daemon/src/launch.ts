import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

function doubleQuote(value: string): string {
  return `"${value.replace(/[\\"$`]/g, '\\$&')}"`
}

/**
 * The argv for a session. Agents run under the user's login shell so CLIs installed through
 * Homebrew, nvm and similar resolve as they do in Terminal; a shell session is just `$SHELL -l`.
 */
export function buildArgv(options: {
  agent: AgentKind
  prompt?: string
  home: string
  shell: string
}): string[] {
  const { agent, home, shell } = options
  if (agent === 'shell') return [shell, '-l']
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
  return [shell, '-l', '-c', `exec ${command}`]
}

/** The environment given to a session's process; the daemon's own QUIRKY_* variables are not passed on. */
export function buildSessionEnv(options: {
  home: string
  sessionId: string
  worktreeId: string
  hookUrl: string
  hookToken: string
  base?: Record<string, string | undefined>
}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.base ?? process.env)) {
    if (value !== undefined && !key.startsWith('QUIRKY_')) env[key] = value
  }
  const path = env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    QUIRKY_HOME: options.home,
    QUIRKY_SESSION_ID: options.sessionId,
    QUIRKY_WORKTREE_ID: options.worktreeId,
    QUIRKY_HOOK_URL: options.hookUrl,
    QUIRKY_HOOK_TOKEN: options.hookToken,
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

/** Writes the Claude settings file and the `quirky-hook` and `quirky` shims under `home`. */
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
}
