import { parseBrowserArgs, BrowserFailure, type BrowserArguments } from './browser-world'
import { runBrowserParity } from './browser-run'

export async function main(args = process.argv.slice(2)): Promise<number> {
  let options: BrowserArguments
  try { options = parseBrowserArgs(args) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2 }
  if (options.help) { console.log('Usage: bun scripts/parity/browser.ts [--json | --help]'); return 0 }
  const controller = new AbortController()
  const stop = () => controller.abort(new BrowserFailure('deadline', 'browser parity interrupted'))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    const report = await runBrowserParity({ signal: controller.signal })
    console.log(JSON.stringify(report, null, options.json ? undefined : 2))
    return report.ok ? 0 : 1
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

if (import.meta.main) process.exitCode = await main()
