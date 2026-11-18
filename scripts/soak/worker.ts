import { accessSync, appendFileSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'

export const DEFAULT_BEAT_MS = 10_000
const PING_LINE = /^soak-ping ([0-9a-f]{8}-[1-9]\d{0,8})$/

export function pongFor(line: string): string | null {
  const match = PING_LINE.exec(line)
  if (match === null || match[0] !== line) return null
  return `\nsoak-pong ${match[1]}\n`
}

const SPINNER_REDRAW_PREFIX = '\x1b[24;1H\x1b[2K'
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸']

export function agentCycleChunks(worker: number, cycle: number): string[] {
  const frameRows = [
    '╭─ SOAK AGENT ────────────────────────────────────────────────────────────────╮',
    `│  worker ${worker}  ·  cycle ${cycle}                                           │`,
    '├─ Task ──────────────────────────────────────────────────────────────────────┤',
    '│                                                                              │',
    '│  > Inspecting the current worktree                                           │',
    '│    Checking repository state and project instructions                       │',
    '│                                                                              │',
    '│  > Reading implementation and tests                                         │',
    '│    Following existing worker timing and subprocess behavior                 │',
    '│                                                                              │',
    '│  ● Working                                                                   │',
    '│    ├─ Reviewing source                                                       │',
    '│    ├─ Preparing terminal updates                                            │',
    '│    └─ Preserving the beat schedule                                          │',
    '│                                                                              │',
    '│  Changes                                                                     │',
    '│    + agent-style screen frames                                              │',
    '│    + paced spinner redraws                                                  │',
    '│    + concise completion output                                             │',
    '│                                                                              │',
    '│  Tools  0  │  Tokens  —  │  Context  ███████░░░                             │',
    '│  Press Ctrl-C to interrupt                                                  │',
    '│                                                                              │',
    '╰──────────────────────────────────────────────────────────────────────────────╯'
  ]
  const chunks = [
    `\x1b]0;soak agent ${worker} cycle ${cycle}\x07`,
    '\x1b[?1049h',
    '\x1b[?25l',
    '\x1b[2J\x1b[H',
    ...frameRows.map((line, index) => `\x1b[${index + 1};1H${line}\x1b[K`),
    ...Array.from({ length: 40 }, (_, index) =>
      `${SPINNER_REDRAW_PREFIX}${SPINNER_FRAMES[index % SPINNER_FRAMES.length]} Working · cycle ${cycle} · ${index + 1}/40`
    ),
    Array.from({ length: 200 }, (_, index) =>
      `\x1b[${30 + index % 8}msoak agent ${worker} cycle ${cycle} output ${index + 1}\x1b[0m`
    ).join('\n') + '\n',
    '\x1b[?25h',
    '\x1b[?1049l',
    Array.from({ length: 40 }, (_, index) =>
      `soak worker ${worker} cycle ${cycle} line ${index + 1}`
    ).join('\n') + '\n'
  ]
  return chunks
}

async function writeAgentCycle(worker: number, cycle: number, beat: number): Promise<void> {
  const spinnerDelayMs = Math.max(1, Math.floor(beat / 400))
  let spinnerRedraws = 0
  for (const chunk of agentCycleChunks(worker, cycle)) {
    if (chunk.startsWith(SPINNER_REDRAW_PREFIX)) {
      if (spinnerRedraws > 0) await Bun.sleep(spinnerDelayMs)
      spinnerRedraws++
    }
    process.stdout.write(chunk)
  }
}

const workerIndex = Number.isSafeInteger(Number(process.argv[2])) && Number(process.argv[2]) >= 0
  ? Number(process.argv[2])
  : 0
const worktreePath = process.cwd()
const launchAt = performance.now()
const hookPath = findOnPath('quirky-hook')

function findOnPath(command: string): string | null {
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(entry || worktreePath, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reportFailure(step: string, error: unknown): void {
  console.error(`[soak worker ${workerIndex}] ${step}: ${errorMessage(error)}`)
}

async function runGit(args: string[]): Promise<void> {
  const child = Bun.spawn(['git', ...args], {
    cwd: worktreePath,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe'
  })
  const stderrText = new Response(child.stderr).text()
  const [code, stderr] = await Promise.all([child.exited, stderrText])
  if (code !== 0) throw new Error(`git ${args.join(' ')} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
}

async function runHook(cycle: number): Promise<void> {
  if (hookPath === null) throw new Error('could not find quirky-hook on PATH')
  const payload = cycle % 2 === 0
    ? { hook_event_name: 'UserPromptSubmit', prompt: `soak cycle ${cycle}` }
    : { hook_event_name: 'Stop', last_assistant_message: `soak cycle ${cycle} done` }
  const child = Bun.spawn([hookPath, 'claude'], {
    cwd: worktreePath,
    env: { ...process.env, QUIRKY_HOOK_AGENT_PID: String(process.pid) },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'pipe'
  })
  child.stdin.write(JSON.stringify(payload))
  child.stdin.end()
  const stderrText = new Response(child.stderr).text()
  const [code, stderr] = await Promise.all([child.exited, stderrText])
  if (code !== 0) throw new Error(`quirky-hook claude exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
}

async function attempt(step: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    reportFailure(step, error)
  }
}

async function runCycle(cycle: number, beat: number): Promise<void> {
  await writeAgentCycle(workerIndex, cycle, beat)

  try {
    appendFileSync(join(worktreePath, 'soak-heartbeat.log'), `cycle ${cycle} ${new Date().toISOString()}\n`)
  } catch (error) {
    reportFailure('heartbeat', error)
  }

  await attempt('git status --porcelain', () => runGit(['status', '--porcelain']))
  await attempt('quirky-hook claude', () => runHook(cycle))
  if (cycle % 6 === 0) {
    await attempt('git add -A', () => runGit(['add', '-A']))
    await attempt(`git commit --quiet -m "soak cycle ${cycle}"`, () => runGit(['commit', '--quiet', '-m', `soak cycle ${cycle}`]))
  }
}
async function run(): Promise<void> {
  let cycle = 1
  const configuredBeat = Number(process.env.QUIRKY_SOAK_BEAT_MS)
  const beat = Number.isSafeInteger(configuredBeat) && configuredBeat > 0 ? configuredBeat : DEFAULT_BEAT_MS
  let nextStart = launchAt + workerIndex * (beat / 10)
  for (;;) {
    const delay = nextStart - performance.now()
    if (delay > 0) await Bun.sleep(delay)
    await runCycle(cycle, beat)
    cycle++
    nextStart += beat
    const now = performance.now()
    if (nextStart <= now) {
      // leave a full beat after an overrun so recovery cannot compress the next hook interval
      const skipped = Math.ceil((now + beat - nextStart) / beat)
      nextStart += skipped * beat
      try {
        appendFileSync(join(worktreePath, 'soak-skips.log'), `skipped ${skipped} ${new Date().toISOString()}\n`)
      } catch (error) {
        reportFailure('skipped beats', error)
      }
    }
  }
}

if (import.meta.main) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  process.stdin.on('error', () => undefined)
  input.on('error', () => undefined)
  input.on('line', (line) => {
    const pong = pongFor(line)
    if (pong !== null) process.stdout.write(pong)
  })
  void run()
}
