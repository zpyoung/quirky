// Test-only (never imported by production code): the window-lane launch parity table for rows 2
// (typed prompt into a new tab) and 6 (continue from transcript). Renderer suites assert a real
// producer + pane sends `request`; main suites feed it to pty:spawn and assert `provider`.
import type {
  LaunchClient,
  LaunchWorkspace,
  WindowLaunchCase,
  WindowLaunchProducer,
  WindowProviderFacts,
  WindowRequestFacts
} from './launch-parity-window-request.test-fixture'

export const POSIX_PATH = '/home/alice/repo'
export const WIN_PATH = String.raw`C:\Users\alice\repo`

const SKIP = '--dangerously-skip-permissions'
const POSIX_CLAUDE = `claude '${SKIP}'`
const CMD_CLAUDE = `claude "${SKIP}"`
// The auto-submitted prompt rides on argv.
const posix = { command: `${POSIX_CLAUDE} 'fix Bob'"'"'s bug'`, agentCommand: POSIX_CLAUDE }
const ps = { command: `${POSIX_CLAUDE} 'fix Bob''s bug'`, agentCommand: POSIX_CLAUDE }
const cmd = { command: `${CMD_CLAUDE} "fix Bob's bug"`, agentCommand: CMD_CLAUDE }

const BRAIN = '.gemini/antigravity-ide/brain/ide-id/transcript_full.jsonl'
const MAC_T = `/Users/alice/${BRAIN}`
const WIN_T = `C:/Users/alice/${BRAIN}`
const reference = (path: string): string =>
  `Review the chat transcript at "${path}". Confirm your understanding of the previous conversation and continue from where it left off. This starts a new CLI conversation using the original transcript as a reference.`
const agy = (path: string): WindowRequestFacts => ({
  command: `agy '${SKIP}' --prompt-interactive '${reference(path)}'`,
  agentCommand: `agy '${SKIP}'`
})

const repo = (path: string, extra: Partial<LaunchWorkspace> = {}): LaunchWorkspace => ({
  kind: 'repo',
  path,
  ...extra
})
const folder = (path: string, extra: Partial<LaunchWorkspace> = {}): LaunchWorkspace => ({
  kind: 'folder',
  path,
  ...extra
})
const HOST_SENT = { projectRuntime: { kind: 'windows-host', reason: 'global-default' } } as const
const IN_PWSH = { shellOverride: 'powershell.exe' }
// Main runs a local pane in the settings shell; Windows adds the WSL distro it derived.
const ZSH = { shellOverride: '/bin/zsh' }
const PWSH = { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
const CMD_EXE = { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
const CMD = { terminalWindowsShell: 'cmd.exe' }

function launch(
  row: 2 | 6,
  producer: WindowLaunchProducer,
  name: string,
  client: LaunchClient,
  workspace: LaunchWorkspace,
  request: WindowRequestFacts,
  provider: WindowProviderFacts,
  settings?: Record<string, unknown>
): WindowLaunchCase {
  return { name, row, client, workspace, producer, request, provider, settings }
}
// A quick command's prompt; the apostrophe shows which shell the command was quoted for.
const quick = { kind: 'quick-command', agent: 'claude', prompt: "fix Bob's bug" } as const
const typed = launch.bind(null, 2, quick)
const resume = (transcript: string, cwd: string | null) =>
  launch.bind(null, 6, { kind: 'transcript-continue', transcript, cwd })

export const WINDOW_LAUNCH_CASES: WindowLaunchCase[] = [
  // C2 (typed-prompt tabs onto the pane trigger) and C5a-e (assembler merge) check against rows 2.
  typed(
    'macOS repo, saved default env',
    'darwin',
    repo(POSIX_PATH),
    { ...posix, agentEnv: { A: '1' } },
    ZSH,
    { agentDefaultEnv: { claude: { A: '1' } } }
  ),
  typed('macOS folder', 'darwin', folder(POSIX_PATH), posix, ZSH),
  // The draft rides --prefill.
  launch(
    2,
    {
      kind: 'continuation',
      agent: 'claude',
      prompt: "fix Bob's bug",
      initialCwd: `${POSIX_PATH}/pkg`
    },
    'macOS repo, terminal continuation in the pane cwd',
    'darwin',
    repo(POSIX_PATH),
    {
      command: `${POSIX_CLAUDE} --prefill 'fix Bob'"'"'s bug'`,
      agentCommand: POSIX_CLAUDE,
      cwd: `${POSIX_PATH}/pkg`
    },
    ZSH
  ),
  launch(
    2,
    { ...quick, agent: 'codex' },
    'macOS repo, codex auto-submit waits for the shell',
    'darwin',
    repo(POSIX_PATH),
    {
      command: `codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob'"'"'s bug'`,
      agentCommand: `codex '--dangerously-bypass-approvals-and-sandbox'`
    },
    ZSH
  ),
  // C1 reproduces this Windows platform/shell rule on the host planner.
  typed(
    'Windows C: repo, default PowerShell',
    'win32',
    repo(WIN_PATH),
    { ...ps, ...IN_PWSH, ...HOST_SENT },
    PWSH
  ),
  typed(
    'Windows C: repo, cmd.exe',
    'win32',
    repo(WIN_PATH),
    { ...cmd, shellOverride: 'cmd.exe', ...HOST_SENT },
    CMD_EXE,
    CMD
  ),
  typed('Windows C: folder', 'win32', folder(WIN_PATH), { ...ps, ...IN_PWSH }, PWSH),
  // C3 (Antigravity continue) checks against rows 6.
  resume(MAC_T, `${POSIX_PATH}/pkg`)(
    'continue, macOS repo, transcript cwd',
    'darwin',
    repo(POSIX_PATH),
    {
      ...agy(MAC_T),
      cwd: `${POSIX_PATH}/pkg`
    },
    ZSH
  ),
  resume(MAC_T, null)(
    'continue, macOS repo, no transcript cwd',
    'darwin',
    repo(POSIX_PATH),
    agy(MAC_T),
    ZSH
  ),
  // cmd escapes the prompt's inner quotes with a caret.
  resume(WIN_T, WIN_PATH)(
    'continue, Windows C: repo, cmd.exe',
    'win32',
    repo(WIN_PATH),
    {
      command: `agy "${SKIP}" --prompt-interactive "${reference(WIN_T).replace(/"/g, '^"')}"`,
      agentCommand: `agy "${SKIP}"`,
      shellOverride: 'cmd.exe',
      ...HOST_SENT
    },
    CMD_EXE,
    CMD
  )
]
