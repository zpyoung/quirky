// Why: the pty IPC suites force darwin and rewrite a dozen agent-home env vars per test;
// this scope captures the real values once and puts them back afterwards.
export function createPtyIpcProcessEnvScope() {
  const savedOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
  const savedQuirkyOpenCodeConfigDir = process.env.QUIRKY_OPENCODE_CONFIG_DIR
  const savedQuirkyOpenCodeSourceConfigDir = process.env.QUIRKY_OPENCODE_SOURCE_CONFIG_DIR
  const savedPiAgentDir = process.env.PI_CODING_AGENT_DIR
  const savedQuirkyPiAgentDir = process.env.QUIRKY_PI_CODING_AGENT_DIR
  const savedQuirkyPiSourceAgentDir = process.env.QUIRKY_PI_SOURCE_AGENT_DIR
  const savedQuirkyCodexHome = process.env.QUIRKY_CODEX_HOME
  const savedQuirkyOmpAgentDir = process.env.QUIRKY_OMP_CODING_AGENT_DIR
  const savedQuirkyOmpSourceAgentDir = process.env.QUIRKY_OMP_SOURCE_AGENT_DIR
  const savedQuirkyOmpStatusExtension = process.env.QUIRKY_OMP_STATUS_EXTENSION
  const savedPrimeAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR
  const savedQuirkyPrimeAgentSourceDir = process.env.QUIRKY_PRIME_AGENT_SOURCE_AGENT_DIR
  const savedQuirkyPrimeAgentStatusExtension = process.env.QUIRKY_PRIME_AGENT_STATUS_EXTENSION
  const savedQuirkyClaudeAgentStatusSettings = process.env.QUIRKY_CLAUDE_AGENT_STATUS_SETTINGS
  const savedProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const savedDisableMacosLoginShell = process.env.QUIRKY_DISABLE_MACOS_LOGIN_SHELL
  const savedQuirkyUserDataPath = process.env.QUIRKY_USER_DATA_PATH

  function applyTestEnvDefaults() {
    // Why: most PTY spawn tests assert POSIX shell behavior; Windows cases opt into win32 explicitly below.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // Why: forced darwin makes the TCC login(1) wrapper rewrite every asserted argv; its own test below re-enables it.
    process.env.QUIRKY_DISABLE_MACOS_LOGIN_SHELL = '1'
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.QUIRKY_OPENCODE_SOURCE_CONFIG_DIR
    delete process.env.QUIRKY_OPENCODE_CONFIG_DIR
    delete process.env.QUIRKY_AGENT_HOOK_ENDPOINT
    delete process.env.QUIRKY_CLAUDE_AGENT_STATUS_SETTINGS
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.QUIRKY_PI_SOURCE_AGENT_DIR
    delete process.env.QUIRKY_PI_CODING_AGENT_DIR
    delete process.env.QUIRKY_CODEX_HOME
    delete process.env.QUIRKY_OMP_SOURCE_AGENT_DIR
    delete process.env.QUIRKY_OMP_CODING_AGENT_DIR
    delete process.env.QUIRKY_OMP_STATUS_EXTENSION
    delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    delete process.env.QUIRKY_PRIME_AGENT_SOURCE_AGENT_DIR
    delete process.env.QUIRKY_PRIME_AGENT_STATUS_EXTENSION
  }

  function restoreProcessEnv() {
    if (savedProcessPlatform) {
      Object.defineProperty(process, 'platform', savedProcessPlatform)
    }
    if (savedDisableMacosLoginShell !== undefined) {
      process.env.QUIRKY_DISABLE_MACOS_LOGIN_SHELL = savedDisableMacosLoginShell
    } else {
      delete process.env.QUIRKY_DISABLE_MACOS_LOGIN_SHELL
    }
    if (savedQuirkyUserDataPath !== undefined) {
      process.env.QUIRKY_USER_DATA_PATH = savedQuirkyUserDataPath
    } else {
      delete process.env.QUIRKY_USER_DATA_PATH
    }
    if (savedOpenCodeConfigDir !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = savedOpenCodeConfigDir
    } else {
      delete process.env.OPENCODE_CONFIG_DIR
    }
    if (savedQuirkyOpenCodeConfigDir !== undefined) {
      process.env.QUIRKY_OPENCODE_CONFIG_DIR = savedQuirkyOpenCodeConfigDir
    } else {
      delete process.env.QUIRKY_OPENCODE_CONFIG_DIR
    }
    if (savedQuirkyOpenCodeSourceConfigDir !== undefined) {
      process.env.QUIRKY_OPENCODE_SOURCE_CONFIG_DIR = savedQuirkyOpenCodeSourceConfigDir
    } else {
      delete process.env.QUIRKY_OPENCODE_SOURCE_CONFIG_DIR
    }
    if (savedPiAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = savedPiAgentDir
    } else {
      delete process.env.PI_CODING_AGENT_DIR
    }
    if (savedQuirkyPiAgentDir !== undefined) {
      process.env.QUIRKY_PI_CODING_AGENT_DIR = savedQuirkyPiAgentDir
    } else {
      delete process.env.QUIRKY_PI_CODING_AGENT_DIR
    }
    if (savedQuirkyPiSourceAgentDir === undefined) {
      delete process.env.QUIRKY_PI_SOURCE_AGENT_DIR
    } else {
      process.env.QUIRKY_PI_SOURCE_AGENT_DIR = savedQuirkyPiSourceAgentDir
    }
    if (savedQuirkyCodexHome === undefined) {
      delete process.env.QUIRKY_CODEX_HOME
    } else {
      process.env.QUIRKY_CODEX_HOME = savedQuirkyCodexHome
    }
    if (savedQuirkyOmpAgentDir !== undefined) {
      process.env.QUIRKY_OMP_CODING_AGENT_DIR = savedQuirkyOmpAgentDir
    } else {
      delete process.env.QUIRKY_OMP_CODING_AGENT_DIR
    }
    if (savedQuirkyOmpSourceAgentDir !== undefined) {
      process.env.QUIRKY_OMP_SOURCE_AGENT_DIR = savedQuirkyOmpSourceAgentDir
    } else {
      delete process.env.QUIRKY_OMP_SOURCE_AGENT_DIR
    }
    if (savedQuirkyOmpStatusExtension !== undefined) {
      process.env.QUIRKY_OMP_STATUS_EXTENSION = savedQuirkyOmpStatusExtension
    } else {
      delete process.env.QUIRKY_OMP_STATUS_EXTENSION
    }
    if (savedPrimeAgentDir !== undefined) {
      process.env.PRIME_AGENT_CODING_AGENT_DIR = savedPrimeAgentDir
    } else {
      delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    }
    if (savedQuirkyPrimeAgentSourceDir !== undefined) {
      process.env.QUIRKY_PRIME_AGENT_SOURCE_AGENT_DIR = savedQuirkyPrimeAgentSourceDir
    } else {
      delete process.env.QUIRKY_PRIME_AGENT_SOURCE_AGENT_DIR
    }
    if (savedQuirkyPrimeAgentStatusExtension !== undefined) {
      process.env.QUIRKY_PRIME_AGENT_STATUS_EXTENSION = savedQuirkyPrimeAgentStatusExtension
    } else {
      delete process.env.QUIRKY_PRIME_AGENT_STATUS_EXTENSION
    }
    if (savedQuirkyClaudeAgentStatusSettings === undefined) {
      delete process.env.QUIRKY_CLAUDE_AGENT_STATUS_SETTINGS
    } else {
      process.env.QUIRKY_CLAUDE_AGENT_STATUS_SETTINGS = savedQuirkyClaudeAgentStatusSettings
    }
  }

  return { applyTestEnvDefaults, restoreProcessEnv }
}
