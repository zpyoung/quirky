import { GoalLoopFailure, parseGoalLoopArgs, runGoalLoop, type GoalLoopArguments } from './goal-loop-run'

export async function main(args = process.argv.slice(2)): Promise<number> {
  let parsed: GoalLoopArguments
  try {
    parsed = parseGoalLoopArgs(args)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write('Usage: bun scripts/parity/goal-loop.ts [--json | --help]\n')
    return 0
  }
  const controller = new AbortController()
  const stop = () => controller.abort(new GoalLoopFailure('interrupted', 'Goal loop rehearsal interrupted'))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const report = await runGoalLoop({ signal: controller.signal })
    process.stdout.write(`${JSON.stringify(report, null, parsed.json ? undefined : 2)}\n`)
    return report.ok ? 0 : 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (import.meta.main) process.exitCode = await main()
