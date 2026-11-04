import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutAgentSessionMarkers } from '@quirky/protocol/node'
import pkg from '../package.json'

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

/** Which startup-file family a shell path belongs to; only zsh and bash get Quirky's wrappers. */
export function shellKind(shell: string): 'zsh' | 'bash' | 'posix' | 'other' {
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

/** The argv of an interactive shell session; a bash shell starts through the rcfile that puts the bin dir first. */
export function shellArgv(home: string, shell: string): string[] {
  return shellKind(shell) === 'bash' ? [shell, '--rcfile', bashRcfilePath(home), '-i'] : [shell, '-l']
}

/**
 * The argv that runs `command` (a shell command string) under the user's login shell. For a POSIX
 * shell, PATH is the bin dir, then `interactivePath` when given, then whatever PATH the login
 * shell's startup files leave. CLIs that an interactive rc file such as `~/.zshrc` puts on PATH
 * (nvm, rye and similar) so resolve as they do in Terminal, and nothing the login shell finds is
 * lost when `interactivePath` is stale. Other variables come from the login shell alone. PATH is
 * exported inside the command string because the login shell's startup files may have reset it.
 */
export function commandArgv(home: string, shell: string, command: string, interactivePath?: string): string[] {
  if (shellKind(shell) === 'other') return [shell, '-l', '-c', `exec ${command}`]
  const bin = join(home, 'bin')
  const first = interactivePath === undefined ? [bin] : [bin, ...interactivePath.split(':').filter((entry) => entry !== bin)]
  return [shell, '-l', '-c', `export PATH=${doubleQuote(first.join(':'), true)}; exec ${command}`]
}

/** The daemon environment a child inherits: without the daemon's own QUIRKY_* variables, agent session markers or unset values. */
export function inheritedEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(withoutAgentSessionMarkers(base))) {
    if (value !== undefined && !key.startsWith('QUIRKY_')) env[key] = value
  }
  return env
}

/** The environment given to a session's process; the daemon's own QUIRKY_* variables and inherited agent session markers are not passed on. */
export function buildSessionEnv(options: {
  home: string
  sessionId: string
  worktreeId: string
  hookUrl: string
  hookToken: string
  /** With `agent`, selects the shell startup wrapper; omitted means no wrapper. */
  shell?: string
  agent?: string
  base?: Record<string, string | undefined>
  /** Applied over the base environment and `TERM`; a string sets, `null` deletes. Kernel variables and `PATH` still win, and reserved names are the caller's to filter. */
  envPatch?: Record<string, string | null>
  /** Absolute path of a trusted plugin init file, sourced after user rc files for an interactive shell. */
  shellInit?: string
}): Record<string, string> {
  const env = inheritedEnv(options.base ?? process.env)
  const baseEnv: Record<string, string> = {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Quirky',
    TERM_PROGRAM_VERSION: pkg.version,
    // claude only probes for DEC 2026 after an XTVERSION reply, which xterm.js never sends
    CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1'
  }
  for (const [key, value] of Object.entries(options.envPatch ?? {})) {
    if (value === null) delete baseEnv[key]
    else baseEnv[key] = value
  }
  const path = env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'
  const zsh: Record<string, string> =
    options.agent === 'shell' && options.shell && shellKind(options.shell) === 'zsh'
      ? {
          ZDOTDIR: zshWrapperDir(options.home),
          QUIRKY_ORIG_ZDOTDIR: env.ZDOTDIR || env.HOME || homedir()
        }
      : {}
  const shellInit = options.agent === 'shell' ? options.shellInit : undefined
  if (shellInit !== undefined) {
    if (!isAbsolute(shellInit)) throw new Error('plugin shell init path must be absolute')
    if (!existsSync(shellInit)) throw new Error('plugin shell init file is unavailable')
  }
  return {
    ...baseEnv,
    QUIRKY_HOME: options.home,
    QUIRKY_SESSION_ID: options.sessionId,
    QUIRKY_WORKTREE_ID: options.worktreeId,
    QUIRKY_HOOK_URL: options.hookUrl,
    QUIRKY_HOOK_TOKEN: options.hookToken,
    ...(shellInit !== undefined ? { QUIRKY_SHELL_INIT: shellInit } : {}),
    ...zsh,
    PATH: `${join(options.home, 'bin')}:${path}`
  }
}

/** Seconds the stdin reader waits for the first byte, and for more after one, before it gives up. */
const HOOK_STDIN_FIRST_BYTE_SECONDS = 5
const HOOK_STDIN_IDLE_SECONDS = 1.5
/** A spool file past this size takes no more lines. */
const HOOK_SPOOL_MAX_BYTES = 5_242_880

/**
 * Reads stdin until the first complete JSON value arrives and writes it unchanged to stdout.
 * Grok and Antigravity keep stdin open after the payload, so reading to EOF would hang until the
 * agent's own hook timeout. A non-zero exit means stdin was never read.
 */
const HOOK_JSON_STDIN_PYTHON = [
  'import codecs, json, os, select',
  'text = ""',
  'try:',
  '    decoder = codecs.getincrementaldecoder("utf-8")("replace")',
  `    timeout = ${HOOK_STDIN_FIRST_BYTE_SECONDS}.0`,
  '    while 1:',
  '        if not select.select([0], [], [], timeout)[0]:',
  '            text += decoder.decode(b"", True)',
  '            break',
  '        chunk = os.read(0, 65536)',
  '        if not chunk:',
  '            text += decoder.decode(b"", True)',
  '            break',
  `        timeout = ${HOOK_STDIN_IDLE_SECONDS}`,
  '        text += decoder.decode(chunk)',
  '        value = text.lstrip()',
  '        if not value:',
  '            continue',
  '        try:',
  '            end = json.JSONDecoder().raw_decode(value)[1]',
  '        except ValueError:',
  '            continue',
  '        text = value[:end]',
  '        break',
  'except Exception:',
  '    pass',
  'try:',
  '    data = text.encode("utf-8")',
  '    written = 0',
  '    while written < len(data):',
  '        written += os.write(1, data[written:])',
  'except Exception:',
  '    pass'
].join('\n')

/**
 * The hook shim agents call as `quirky-hook <source>`. It answers the agent's hook on stdout first,
 * then posts the payload to the daemon's current port from `$QUIRKY_HOME/runtime.json` (falling
 * back to the URL in the environment) so sessions that outlive a restart still reach it. When the
 * daemon is down it spools the payload for replay at the next start, except tool events. Does
 * nothing outside a Quirky session. Always exits 0 so a hook failure never disturbs the agent.
 */
export const QUIRKY_HOOK_SCRIPT = `#!/bin/sh
exec 2>/dev/null
src="$1"
event="$QUIRKY_HOOK_EVENT"
answer=""
case "$src" in
  claude|openclaude|qoder|qoder-cn|qwen-code|codebuddy|droid|devin|muse|zcode|kimi|command-code)
    answer='{}' ;;
  cursor)
    case "$event" in
      preToolUse|beforeShellExecution|beforeMCPExecution) answer='{"permission":"allow"}' ;;
      beforeSubmitPrompt) answer='{"continue":true}' ;;
      *) answer='{}' ;;
    esac ;;
  antigravity)
    case "$event" in
      PreToolUse) answer='{"decision":"ask"}' ;;
      Stop) answer='{"decision":""}' ;;
      *) answer='{}' ;;
    esac ;;
esac
[ -z "$answer" ] || printf '%s\\n' "$answer"
if [ -z "$QUIRKY_SESSION_ID" ] || [ -n "$CLAUDE_JOB_DIR" ]; then
  exit 0
fi
case "$src" in
  codex)
    if [ "$#" -gt 1 ]; then
      for last; do :; done
      payload="$last"
    else
      payload="$({ command -p cat || cat; })"
    fi ;;
  grok|antigravity)
    { command -v python3 || command -p -v python3; } >/dev/null 2>&1 || exit 0
    py='${HOOK_JSON_STDIN_PYTHON}'
    payload="$({ [ -d "\${HOME:-}" ] || unset HOME; command -p python3 -c "$py" || python3 -c "$py"; })" ;;
  *)
    payload="$({ command -p cat || cat; })" ;;
esac
[ -n "$payload" ] || exit 0
url="$QUIRKY_HOOK_URL"
if [ -n "$QUIRKY_HOME" ] && [ -r "$QUIRKY_HOME/runtime.json" ]; then
  port="$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$QUIRKY_HOME/runtime.json" | head -n 1)"
  [ -n "$port" ] && url="http://127.0.0.1:$port/hook"
fi
[ -n "$url" ] || exit 0
pid="$QUIRKY_HOOK_AGENT_PID"
case "$pid" in ''|*[!0-9]*) pid="" ;; esac
pstart=""
if [ -n "$pid" ]; then
  pstart="$(TZ=UTC0 LC_ALL=C /bin/ps -p "$pid" -o lstart= | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
fi
urlenc() {
  printf '%s' "$1" | sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/:/%3A/g' -e 's/&/%26/g' -e 's/+/%2B/g' -e 's/#/%23/g' -e 's/?/%3F/g' -e 's/=/%3D/g'
}
query="session=$QUIRKY_SESSION_ID"
[ -z "$pid" ] || query="$query&pid=$pid"
[ -z "$pstart" ] || query="$query&pstart=$(urlenc "$pstart")"
[ -z "$event" ] || query="$query&event=$(urlenc "$event")"
b64() {
  printf '%s' "$1" | base64 | tr -d '\\n'
}
spool() {
  [ -n "$QUIRKY_HOME" ] || return 0
  case "$QUIRKY_SESSION_ID" in */*) return 0 ;; esac
  case "$event" in PreToolUse|PostToolUse|PostToolUseFailure) return 0 ;; esac
  if printf '%s' "$payload" | tr '\\n\\r' '  ' | grep -Eq '"(hook_event_name|hookEventName)"[[:space:]]*:[[:space:]]*"(PreToolUse|PostToolUse|PostToolUseFailure)"'; then
    return 0
  fi
  dir="$QUIRKY_HOME/hook-spool"
  file="$dir/$QUIRKY_SESSION_ID.jsonl"
  umask 077
  mkdir -p "$dir" || return 0
  chmod 700 "$dir"
  if [ -f "$file" ]; then
    size="$(wc -c < "$file" | tr -d ' ')"
    [ "$size" -le ${HOOK_SPOOL_MAX_BYTES} ] || return 0
  fi
  pstart64="-"
  [ -z "$pstart" ] || pstart64="$(b64 "$pstart")"
  case "$event" in ''|*[!A-Za-z0-9_.:-]*) spool_event="-" ;; *) spool_event="$event" ;; esac
  printf '%s %s %s %s %s\\n' "$src" "\${pid:--}" "$pstart64" "$spool_event" "$(b64 "$payload")" >> "$file" || return 0
  chmod 600 "$file"
}
if ! printf '%s' "$payload" | curl -s --connect-timeout 0.5 -m 1.5 --noproxy 127.0.0.1 -o /dev/null -X POST \\
  -H "x-quirky-hook-token: $QUIRKY_HOOK_TOKEN" \\
  -H 'content-type: application/json' \\
  --data-binary @- \\
  "$url/$src?$query" >/dev/null 2>&1; then
  spool
fi
exit 0
`

/**
 * Reads the decision JSON the daemon answers a gate request with and writes `encoded` (decoded,
 * byte for byte) to the file named by `-v out=`. Prints `<hasEncoded> <exitCode>` on stdout.
 * Scans top-level keys only, so the field order of the answer does not matter.
 */
const GATE_DECISION_AWK = String.raw`
function hexval(ch) { return index("0123456789abcdef", tolower(ch)) - 1 }
function hex4(str,   v, k) { v = 0; for (k = 1; k <= 4; k++) v = v * 16 + hexval(substr(str, k, 1)); return v }
function utf8(cp) {
  if (cp < 128) return sprintf("%c", cp)
  if (cp < 2048) return sprintf("%c%c", 192 + int(cp / 64), 128 + cp % 64)
  if (cp < 65536) return sprintf("%c%c%c", 224 + int(cp / 4096), 128 + int(cp / 64) % 64, 128 + cp % 64)
  return sprintf("%c%c%c%c", 240 + int(cp / 262144), 128 + int(cp / 4096) % 64, 128 + int(cp / 64) % 64, 128 + cp % 64)
}
BEGIN { RS = "\001"; depth = 0; expect = ""; key = ""; has = 0; code = 0 }
{
  s = $0; n = length(s); i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") {
      i++; val = ""
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\"") break
        if (c == "\\") {
          i++; e = substr(s, i, 1)
          if (e == "n") val = val "\n"
          else if (e == "t") val = val "\t"
          else if (e == "r") val = val "\r"
          else if (e == "b") val = val "\b"
          else if (e == "f") val = val "\f"
          else if (e == "u") {
            cp = hex4(substr(s, i + 1, 4)); i += 4
            if (cp >= 55296 && cp < 56320 && substr(s, i + 1, 2) == "\\u") {
              lo = hex4(substr(s, i + 3, 4))
              if (lo >= 56320 && lo < 57344) { cp = 65536 + (cp - 55296) * 1024 + (lo - 56320); i += 6 }
            }
            val = val utf8(cp)
          } else val = val e
        } else val = val c
        i++
      }
      i++
      if (depth == 1 && expect == "key") { key = val; expect = "colon" }
      else if (depth == 1 && expect == "value") {
        if (key == "encoded") { printf "%s", val > out; has = 1 }
        expect = "comma"
      }
    } else if (c == "{" || c == "[") {
      depth++; i++
      if (depth == 1) expect = "key"
      else if (depth == 2 && expect == "value") expect = "comma"
    } else if (c == "}" || c == "]") { depth--; i++ }
    else if (c == ":") { if (depth == 1) expect = "value"; i++ }
    else if (c == ",") { if (depth == 1) expect = "key"; i++ }
    else if (c ~ /[ \t\r\n]/) i++
    else {
      lit = ""
      while (i <= n && substr(s, i, 1) !~ /[ \t\r\n,}\]]/) { lit = lit substr(s, i, 1); i++ }
      if (depth == 1 && expect == "value") {
        if (key == "exitCode" && lit ~ /^[0-9]+$/) code = lit + 0
        expect = "comma"
      }
    }
  }
}
END { close(out); printf "%d %d\n", has, code }
`

/**
 * The tool-gate shim agents call as `quirky-gate <agent> [deadline-ms]`. It answers `{}` and exits
 * 0 at once, with no network call, unless the session has a supervision marker. With one it posts
 * the hook payload to the daemon's `/gate/<agent>` route, prints the `encoded` text of the
 * decision verbatim and exits with its `exitCode`. When the daemon cannot be reached, answers
 * with anything but a decision or has no encoded answer, it exits 2 with a retry message on
 * stderr, the exit both Claude and Codex treat as blocking. It never builds decision JSON.
 */
export const QUIRKY_GATE_SCRIPT = String.raw`#!/bin/sh
agent="$1"
deadline="$2"
[ -n "$deadline" ] || deadline="$QUIRKY_GATE_DEADLINE_MS"
case "$deadline" in ''|*[!0-9]*) deadline=30000 ;; esac
[ "$deadline" -gt 0 ] || deadline=30000
payload="$({ command -p cat || cat; })"
event="$QUIRKY_HOOK_EVENT"
if [ -z "$event" ]; then
  event="$(printf '%s' "$payload" | tr '\n\r' '  ' | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_.-]*\)".*/\1/p' | head -n 1)"
fi
case "$QUIRKY_SESSION_ID" in ''|*/*|.*) printf '{}\n'; exit 0 ;; esac
[ -n "$QUIRKY_HOME" ] && [ -e "$QUIRKY_HOME/plugin-data/quirky.avatar/supervised/$QUIRKY_SESSION_ID" ] || { printf '{}\n'; exit 0; }
unavailable() {
  printf '%s\n' "Quirky's avatar gate is unavailable; try again shortly." >&2
  exit 2
}
url=""
if [ -r "$QUIRKY_HOME/runtime.json" ]; then
  port="$(sed -n 's/.*"port": *\([0-9][0-9]*\).*/\1/p' "$QUIRKY_HOME/runtime.json" | head -n 1)"
  [ -z "$port" ] || url="http://127.0.0.1:$port/gate"
fi
if [ -z "$url" ] && [ -n "$QUIRKY_HOOK_URL" ]; then
  url="$(printf '%s' "$QUIRKY_HOOK_URL" | sed 's#/hook$#/gate#')"
fi
[ -n "$url" ] || unavailable
case "$agent" in ''|*[!A-Za-z0-9_.-]*) unavailable ;; esac
query="session=$QUIRKY_SESSION_ID&deadline=$deadline"
case "$event" in ''|*[!A-Za-z0-9_.-]*) ;; *) query="$query&event=$event" ;; esac
tmp="$(mktemp -d 2>/dev/null)" || unavailable
trap 'rm -rf "$tmp"' EXIT
timeout=$(( (deadline + 999) / 1000 + 5 ))
status="$(printf '%s' "$payload" | curl -s -m "$timeout" --connect-timeout 2 --noproxy '*' -o "$tmp/body" -w '%{http_code}' -X POST \
  -H "x-quirky-hook-token: $QUIRKY_HOOK_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary @- \
  "$url/$agent?$query")" || unavailable
[ "$status" = 200 ] || unavailable
parsed="$(LC_ALL=C awk -v out="$tmp/encoded" '${GATE_DECISION_AWK}' "$tmp/body")" || unavailable
set -- $parsed
has="$1"
code="$2"
[ "$has" = 1 ] || unavailable
cat "$tmp/encoded"
exit "$code"
`

export function quirkyShimScript(cliEntry: string): string {
  return `#!/bin/sh\nexec ${doubleQuote(process.execPath)} ${doubleQuote(cliEntry)} "$@"\n`
}

const ZSH_PRELUDE = `: \${_quirky_wrapper_dir:=$ZDOTDIR}
: \${_quirky_user_dir:=\${QUIRKY_ORIG_ZDOTDIR:-$HOME}}`

const PLUGIN_SHELL_INIT = `if [ -z "\${__quirky_plugin_shell_init_sourced-}" ] && [ -n "\${QUIRKY_SHELL_INIT-}" ] && [ -r "$QUIRKY_SHELL_INIT" ]; then
  __quirky_plugin_shell_init_sourced=1
  . "$QUIRKY_SHELL_INIT"
fi`

function zshSourceUser(file: string): string {
  return `if [[ -r $_quirky_user_dir/${file} ]]; then
  ZDOTDIR=$_quirky_user_dir
  builtin source -- "$_quirky_user_dir/${file}"
  _quirky_user_dir=\${ZDOTDIR:-$HOME}
  ZDOTDIR=$_quirky_wrapper_dir
fi`
}

const OSC = '\\033]'
const BEL = '\\007'

const ZSH_INTEGRATION = `if [[ -z \${__quirky_integrated-} ]]; then
  __quirky_integrated=1
  __quirky_ran=0
  __quirky_first=1
  autoload -Uz add-zsh-hook
  __quirky_preexec() {
    __quirky_ran=1
    printf '${OSC}133;C${BEL}'
  }
  __quirky_precmd() {
    local __quirky_status=$?
    if (( __quirky_ran )); then
      printf '${OSC}133;D;%s${BEL}' "$__quirky_status"
      __quirky_ran=0
    fi
    printf '${OSC}7;file://%s%s${BEL}' "$HOST" "$PWD"
    printf '${OSC}133;A${BEL}'
    (( __quirky_ready_in_zle )) || __quirky_ready
  }
  __quirky_ready() {
    if (( __quirky_first )); then
      __quirky_first=0
      printf '${OSC}777;quirky-shell-ready${BEL}'
    fi
  }
  add-zsh-hook preexec __quirky_preexec
  add-zsh-hook precmd __quirky_precmd
  # input released at precmd reaches a terminal still echoing on its own, so the line editor draws it twice
  __quirky_ready_in_zle=0
  if [[ -o zle ]] && autoload -Uz add-zle-hook-widget && add-zle-hook-widget line-init __quirky_ready 2>/dev/null; then
    __quirky_ready_in_zle=1
  fi
fi`

const BASH_INTEGRATION = `if [ -z "\${__quirky_integrated-}" ]; then
  __quirky_integrated=1
  __quirky_ran=0
  __quirky_armed=0
  __quirky_first=1
  __quirky_histcmd=
  # readline prints PS1 only after it takes the terminal, so input released earlier would be echoed twice
  __quirky_ready_ps1='\\[${OSC}777;quirky-shell-ready${BEL}\\]'
  __quirky_ready_shown=0
  __quirky_owns_trap=1
  [ -n "$(trap -p DEBUG)" ] && __quirky_owns_trap=0
  # HISTCMD stays constant inside PROMPT_COMMAND on bash 3.2, so the history number comes from history 1
  __quirky_histnum() {
    set -- $(HISTTIMEFORMAT= builtin history 1)
    __quirky_hn=$1
  }
  __quirky_debug() {
    # functrace inherits DEBUG inside our prompt helpers; those are not user commands
    case "\${FUNCNAME[1]-}" in
      __quirky_prompt|__quirky_arm|__quirky_histnum) return 0 ;;
    esac
    # under functrace a PS0 or PS1 command substitution inherits DEBUG, and its output lands in the prompt
    [ "\${BASH_SUBSHELL:-0}" = 0 ] || return 0
    [ "$BASH_COMMAND" = __quirky_prompt ] && return 0
    if [ "$__quirky_armed" = 1 ]; then
      __quirky_armed=0
      __quirky_ran=1
      printf '${OSC}133;C${BEL}'
    fi
  }
  __quirky_prompt() {
    local __quirky_status=$?
    __quirky_armed=0
    if [ "$__quirky_owns_trap" = 1 ]; then
      if [ "$__quirky_ran" = 1 ]; then
        printf '${OSC}133;D;%s${BEL}' "$__quirky_status"
        __quirky_ran=0
      fi
    else
      __quirky_histnum
      if [ "$__quirky_first" = 0 ] && [ "$__quirky_hn" != "$__quirky_histcmd" ]; then
        printf '${OSC}133;D;%s${BEL}' "$__quirky_status"
      fi
    fi
    printf '${OSC}7;file://%s%s${BEL}' "$HOSTNAME" "$PWD"
    printf '${OSC}133;A${BEL}'
    if [ "$__quirky_ready_shown" = 1 ]; then
      __quirky_ready_shown=0
      PS1=\${PS1//"$__quirky_ready_ps1"/}
    fi
    return $__quirky_status
  }
  __quirky_arm() {
    __quirky_histnum
    __quirky_histcmd=$__quirky_hn
    __quirky_armed=1
    if [ "$__quirky_first" = 1 ]; then
      __quirky_first=0
      __quirky_ready_shown=1
      PS1=$PS1$__quirky_ready_ps1
    fi
  }
  [ "$__quirky_owns_trap" = 1 ] && trap '__quirky_debug' DEBUG
  # bash 5.1 also runs later array elements, and one left after __quirky_arm would read as a user command
  __quirky_user_prompt=
  for __quirky_element in \${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}; do
    [ -n "$__quirky_element" ] && __quirky_user_prompt="$__quirky_user_prompt$__quirky_element
"
  done
  unset PROMPT_COMMAND
  PROMPT_COMMAND="__quirky_prompt
\${__quirky_user_prompt}__quirky_arm"
  unset __quirky_user_prompt __quirky_element
fi`

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
${PLUGIN_SHELL_INIT}
${ZSH_INTEGRATION}
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
  return `# generated by quirkyd; reproduces a login shell's startup files, puts the bin dir first, then adds shell integration
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
${PLUGIN_SHELL_INIT}
${BASH_INTEGRATION}
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

/** Writes the `quirky-hook`, `quirky-gate` and `quirky` shims and the shell wrappers under `home`. */
export function installIntegrationFiles(home: string, cliEntry: string): void {
  mkdirSync(join(home, 'bin'), { recursive: true })
  const hookPath = join(home, 'bin', 'quirky-hook')
  const gatePath = join(home, 'bin', 'quirky-gate')
  const shimPath = join(home, 'bin', 'quirky')
  writeFileSync(hookPath, QUIRKY_HOOK_SCRIPT)
  writeFileSync(gatePath, QUIRKY_GATE_SCRIPT)
  writeFileSync(shimPath, quirkyShimScript(cliEntry))
  chmodSync(hookPath, 0o755)
  chmodSync(gatePath, 0o755)
  chmodSync(shimPath, 0o755)
  installShellWrappers(home)
}
