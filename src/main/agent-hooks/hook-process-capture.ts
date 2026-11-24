/** Capture before Quirky inserts its managed-script shell. */
export const CLAUDE_HOOK_PARENT_CAPTURE =
  'QUIRKY_HOOK_AGENT_PID="${PPID:-}"; export QUIRKY_HOOK_AGENT_PID; '

export function buildHookProcessCapture(): string[] {
  return [
    'quirky_agent_process=',
    // Why: skip the process reads for Claude sessions outside an Quirky pane.
    '[ -z "${QUIRKY_PANE_KEY:-}" ] || case "${QUIRKY_HOOK_AGENT_PID:-}" in ""|*[!0-9]*) ;; *)',
    '  if [ -r "/proc/$QUIRKY_HOOK_AGENT_PID/stat" ]; then',
    '    quirky_agent_stat=$(cat "/proc/$QUIRKY_HOOK_AGENT_PID/stat" 2>/dev/null) || quirky_agent_stat=',
    '    quirky_agent_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || quirky_agent_boot=',
    '    quirky_agent_fields=${quirky_agent_stat##*) }',
    '    quirky_agent_start=$(printf "%s" "$quirky_agent_fields" | awk \'{print $20}\')',
    '    case "$quirky_agent_start" in ""|*[!0-9]*) ;; *)',
    '      [ -z "$quirky_agent_boot" ] || quirky_agent_process=$(printf \'{"pid":%s,"platform":"linux","startTime":"%s:%s"}\' "$QUIRKY_HOOK_AGENT_PID" "$quirky_agent_boot" "$quirky_agent_start") ;; esac',
    '  elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then',
    // Why: lstart is local time; the host probe pins the same zone so the strings compare.
    '    quirky_agent_start=$(TZ=UTC0 LC_ALL=C /bin/ps -p "$QUIRKY_HOOK_AGENT_PID" -o lstart= 2>/dev/null | sed \'s/^ *//;s/ *$//\')',
    '    [ -z "$quirky_agent_start" ] || quirky_agent_process=$(printf \'{"pid":%s,"platform":"darwin","startTime":"%s"}\' "$QUIRKY_HOOK_AGENT_PID" "$quirky_agent_start")',
    '  fi ;;',
    'esac'
  ]
}
