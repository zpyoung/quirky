/** The helper's environment: none of quirkyd's user-data or agent-browser overrides leak into it. */
export function electronServeEnvironment(userDataPath: string): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of [
    'QUIRKY_E2E_USER_DATA_DIR',
    'QUIRKY_USER_DATA',
    'QUIRKY_USER_DATA_PATH',
    'AGENT_BROWSER_ARGS',
    'AGENT_BROWSER_AUTO_CONNECT',
    'AGENT_BROWSER_CDP',
    'AGENT_BROWSER_ENGINE',
    'AGENT_BROWSER_EXECUTABLE_PATH',
    'AGENT_BROWSER_HEADED',
    'AGENT_BROWSER_PROFILE',
    'AGENT_BROWSER_PROVIDER',
    'AGENT_BROWSER_SESSION',
    'AGENT_BROWSER_SESSION_NAME',
    'AGENT_BROWSER_STATE'
  ]) {
    delete environment[key]
  }
  // Keep Electron's native home override active in isolated sidecars.
  if (process.env.QUIRKY_E2E_USER_DATA_DIR || process.env.QUIRKY_E2E_HOME_DIR) {
    environment.QUIRKY_E2E_USER_DATA_DIR = userDataPath
  }
  // Why not QUIRKY_BACKGROUND_LAUNCH: an older installed app would hide without handing opens to the desktop app.
  environment.QUIRKY_QUIRKYD_SIDECAR = '1'
  return environment
}
