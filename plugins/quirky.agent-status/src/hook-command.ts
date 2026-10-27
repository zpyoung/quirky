/**
 * The shell command every installed hook runs. It does nothing outside a Quirky session or when the
 * shim is missing (Quirky uninstalled), and it always exits 0 so a hook never blocks its agent.
 * `event` is set only for agents whose payload doesn't name the event (cursor, antigravity, copilot).
 */
export function hookCommand(source: string, event?: string): string {
  const eventEnv = event ? ` QUIRKY_HOOK_EVENT=${event}` : ''
  return `[ -n "\${QUIRKY_SESSION_ID-}" ] && [ -x "\${QUIRKY_HOME-}/bin/quirky-hook" ] && QUIRKY_HOOK_AGENT_PID="\${PPID-}"${eventEnv} "$QUIRKY_HOME/bin/quirky-hook" ${source}; exit 0`
}

/** True for a command an installer wrote; installers find and remove their own entries by this. */
export function isQuirkyHookCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes('/bin/quirky-hook"')
}
