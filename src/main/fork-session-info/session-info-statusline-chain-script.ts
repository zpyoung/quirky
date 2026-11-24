import { getManagedStatusLineScript as getUpstreamStatusLineScript } from '../claude/statusline-script'

export const SESSION_INFO_STATUSLINE_CHAIN_ENV = 'QUIRKY_SESSION_INFO_STATUSLINE_CHAIN_ACTIVE'
export const POSIX_STATUSLINE_CHAIN_RUNNER = 'claude-statusline-user.sh'
export const WINDOWS_STATUSLINE_CHAIN_RUNNER = 'claude-statusline-user.cmd'

function getPosixChainBlock(): string {
  return [
    `if [ -z "\${${SESSION_INFO_STATUSLINE_CHAIN_ENV}:-}" ] && [ -n "$HOME" ]; then`,
    `  quirky_statusline_chain_runner="$HOME/.quirky/agent-hooks/${POSIX_STATUSLINE_CHAIN_RUNNER}"`,
    '  if [ -x "$quirky_statusline_chain_runner" ]; then',
    '    quirky_statusline_chain_output=$(mktemp "${TMPDIR:-/tmp}/quirky-statusline-chain-output.XXXXXX" 2>/dev/null) || quirky_statusline_chain_output=',
    '    quirky_statusline_chain_input=$(mktemp "${TMPDIR:-/tmp}/quirky-statusline-chain-input.XXXXXX" 2>/dev/null) || quirky_statusline_chain_input=',
    '    if [ -n "$quirky_statusline_chain_output" ] && [ -n "$quirky_statusline_chain_input" ]; then',
    '      printf \'%s\' "$payload" >"$quirky_statusline_chain_input" 2>/dev/null || :',
    `      ${SESSION_INFO_STATUSLINE_CHAIN_ENV}=1 "$quirky_statusline_chain_runner" <"$quirky_statusline_chain_input" >"$quirky_statusline_chain_output" 2>/dev/null &`,
    '      quirky_statusline_chain_pid=$!',
    '      (',
    '        sleep 1',
    '        quirky_statusline_chain_descendants=',
    '        quirky_statusline_collect_descendants() {',
    '          quirky_statusline_children=$(pgrep -P "$1" 2>/dev/null) || quirky_statusline_children=',
    '          for quirky_statusline_child in $quirky_statusline_children; do',
    '            quirky_statusline_collect_descendants "$quirky_statusline_child"',
    '            quirky_statusline_chain_descendants="$quirky_statusline_chain_descendants $quirky_statusline_child"',
    '          done',
    '        }',
    '        if command -v pgrep >/dev/null 2>&1; then',
    '          quirky_statusline_collect_descendants "$quirky_statusline_chain_pid"',
    '        fi',
    '        kill -TERM $quirky_statusline_chain_descendants "$quirky_statusline_chain_pid" 2>/dev/null || :',
    '        sleep 0.1',
    '        kill -KILL $quirky_statusline_chain_descendants "$quirky_statusline_chain_pid" 2>/dev/null || :',
    '      ) &',
    '      quirky_statusline_chain_watchdog=$!',
    '      wait "$quirky_statusline_chain_pid" 2>/dev/null',
    '      quirky_statusline_chain_status=$?',
    '      kill "$quirky_statusline_chain_watchdog" 2>/dev/null || :',
    '      wait "$quirky_statusline_chain_watchdog" 2>/dev/null || :',
    '      if [ "$quirky_statusline_chain_status" -eq 0 ]; then',
    '        cat "$quirky_statusline_chain_output" 2>/dev/null || :',
    '      fi',
    '    fi',
    '    rm -f "$quirky_statusline_chain_output" "$quirky_statusline_chain_input" 2>/dev/null || :',
    '  fi',
    'fi'
  ].join('\n')
}

function getWindowsChainBlock(): string {
  const runner = `%USERPROFILE%\\.quirky\\agent-hooks\\${WINDOWS_STATUSLINE_CHAIN_RUNNER}`
  const output = '%TEMP%\\quirky-statusline-chain-%QUIRKY_STATUSLINE_PANE_ID%.out'
  return [
    `if not defined ${SESSION_INFO_STATUSLINE_CHAIN_ENV} if exist "${runner}" (`,
    // the guard must be set before the child spawns so a user command that re-enters stops here
    `  set "${SESSION_INFO_STATUSLINE_CHAIN_ENV}=1"`,
    `  "%ComSpec%" /d /s /c ""${runner}" < "%QUIRKY_STATUSLINE_PAYLOAD_FILE%"" >"${output}" 2>nul`,
    `  if not errorlevel 1 type "${output}" 2>nul`,
    `  del "${output}" 2>nul`,
    ')'
  ].join('\r\n')
}

/** Include context telemetry for API-key sessions as well as subscriber rate limits. */
function widenStatusLineTelemetryGate(script: string, windows: boolean): string {
  if (windows) {
    const argumentEscape = '\\'
    return script.replace(
      `/c:${argumentEscape}"rate_limits${argumentEscape}" "%QUIRKY_STATUSLINE_PAYLOAD_FILE%"`,
      `/c:${argumentEscape}"rate_limits${argumentEscape}" /c:${argumentEscape}"context_window${argumentEscape}" "%QUIRKY_STATUSLINE_PAYLOAD_FILE%"`
    )
  }
  return script.replace(
    '  *\'"rate_limits"\'*) ;;',
    '  *\'"rate_limits"\'*|*\'"context_window"\'*) ;;'
  )
}

/** Add fail-open user-command chaining to the upstream managed statusline script. */
export function getManagedStatusLineScript(target: 'local' | 'posix' = 'local'): string {
  const windows = target === 'local' && process.platform === 'win32'
  const upstream = widenStatusLineTelemetryGate(getUpstreamStatusLineScript(target), windows)
  if (windows) {
    const anchor = 'set "QUIRKY_STATUSLINE_STAMP_FILE='
    const index = upstream.indexOf(anchor)
    if (index === -1) {
      return upstream
    }
    return `${upstream.slice(0, index)}${getWindowsChainBlock()}\r\n${upstream.slice(index)}`
  }

  const anchor = 'if [ -z "$payload" ]; then\n  exit 0\nfi\n'
  const index = upstream.indexOf(anchor)
  if (index === -1) {
    return upstream
  }
  const insertion = index + anchor.length
  return `${upstream.slice(0, insertion)}${getPosixChainBlock()}\n${upstream.slice(insertion)}`
}
