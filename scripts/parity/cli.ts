import { CliRunFailure, parseCliArgs, runCliParity, type CliArguments, type CliRunOptions } from './cli-run'

export async function main(args = process.argv.slice(2), runOptions: Omit<CliRunOptions, 'signal'> = {}): Promise<number> {
  let options: CliArguments
  try { options = parseCliArgs(args) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2 }
  if (options.help) {
    console.log('Usage: bun scripts/parity/cli.ts [--json | --help]')
    return 0
  }
  const controller = new AbortController()
  const stop = () => controller.abort(new CliRunFailure('interrupted', 'CLI parity interrupted'))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const report = await runCliParity({ ...runOptions, signal: controller.signal })
    console.log(JSON.stringify(report, null, options.json ? undefined : 2))
    return report.ok ? 0 : 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (import.meta.main) process.exitCode = await main()
