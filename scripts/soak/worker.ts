import { accessSync, appendFileSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

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

async function runCycle(cycle: number): Promise<void> {
  for (let line = 1; line <= 40; line++) console.log(`soak worker ${workerIndex} cycle ${cycle} line ${line}`)

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
  let nextStart = launchAt + workerIndex * 1000
  for (;;) {
    const delay = nextStart - performance.now()
    if (delay > 0) await Bun.sleep(delay)
    await runCycle(cycle)
    cycle++
    nextStart += 10_000
  }
}

void run()
