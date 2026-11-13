#!/usr/bin/env bun
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { collectInventory } from './ui-scoreboard/inventory'
import { measureVisuals, notRunVisuals } from './ui-scoreboard/visual'
import { buildReport, formatMarkdown } from './ui-scoreboard/report'
import { checkRatchet, parseRatchetConfig } from './ui-scoreboard/ratchet'
import { captureApplication } from './ui-review/capture'
import { reviewManifest } from './ui-review/review'
import { DEFAULT_REVIEWER_ALIAS } from './ui-review/arguments'
import type { ModelFamily } from './ui-review/contracts'
import type { VisualDependencies } from './ui-scoreboard/contracts'

type SignalName = 'SIGINT' | 'SIGTERM'
export type SignalSource = { on(name: SignalName, listener: () => void): void; off(name: SignalName, listener: () => void): void }
export type ScoreboardDependencies = {
  repoRoot?: string; collectInventory?: typeof collectInventory
  captureApplication?: VisualDependencies['capture']; reviewManifest?: VisualDependencies['review']
  mkdir?: (path: string) => Promise<unknown>; writeFile?: (path: string, content: string) => Promise<unknown>
  readFile?: (path: string) => Promise<string>; signals?: SignalSource
  stdout?: (text: string) => void; stderr?: (text: string) => void
}
const HELP = `Usage:
  bun run ui:scoreboard -- --author-family <openai|anthropic|google|xai> --output /absolute/fresh/directory [--reviewer <alias>] [--browser <executable>]
  bun run ui:scoreboard -- --static-only --output /absolute/fresh/directory
  bun run ui:scoreboard:check
  bun run ui:scoreboard -- --help

Full mode builds and captures every surface in both themes and reviews every image at 85.
Static-only never starts runtime and cannot certify screenshots. State/action audits are not implemented.
--check-ratchet checks enrolled static results without artifacts or runtime.
Output paths must not exist. No prerequisites are installed automatically.
Exit: 0 complete passing full run (or valid passing ratchet); 1 measured failures; 2 operational/inventory/argument error; 130/143 after signal cleanup.
`
type Arguments = { mode: 'full' | 'static-only'; outputDir: string; authorFamily: ModelFamily; reviewerAlias: string; browserExecutable?: string } | { mode: 'help' } | { mode: 'ratchet' }
function parseArguments(argv: readonly string[]): Arguments {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const values = new Map<string, string>(); const flags = new Set<string>()
  const booleans = ['--help', '--static-only', '--check-ratchet']; const options = ['--output', '--author-family', '--reviewer', '--browser']
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (values.has(arg) || flags.has(arg)) throw new Error(`Duplicate option: ${arg}`)
    if (booleans.includes(arg)) flags.add(arg)
    else if (options.includes(arg)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      values.set(arg, value)
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (flags.has('--help') || flags.has('--check-ratchet')) {
    if (args.length !== 1) throw new Error('Help and ratchet modes accept no other options')
    return { mode: flags.has('--help') ? 'help' : 'ratchet' }
  }
  const outputDir = values.get('--output')
  if (!outputDir || !isAbsolute(outputDir)) throw new Error('--output requires a fresh absolute directory')
  if (flags.has('--static-only')) {
    if (values.size !== 1) throw new Error('Static-only accepts only --output')
    return { mode: 'static-only', outputDir, authorFamily: 'openai', reviewerAlias: DEFAULT_REVIEWER_ALIAS }
  }
  const authorFamily = values.get('--author-family') as ModelFamily
  if (!['openai', 'anthropic', 'google', 'xai'].includes(authorFamily)) throw new Error('--author-family requires openai, anthropic, google or xai')
  return { mode: 'full', outputDir, authorFamily, reviewerAlias: values.get('--reviewer') ?? DEFAULT_REVIEWER_ALIAS, browserExecutable: values.get('--browser') }
}

/** Run developer-only measurement with owned runtime and injectable I/O. */
export async function runUiScoreboard(argv: readonly string[], dependencies: ScoreboardDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? console.log; const stderr = dependencies.stderr ?? console.error
  let args: Arguments
  try { args = parseArguments(argv) } catch (error) { stderr(String(error)); return 2 }
  if (args.mode === 'help') { stdout(HELP); return 0 }
  const repoRoot = dependencies.repoRoot ?? resolve(import.meta.dir, '..')
  const inventoryCollector = dependencies.collectInventory ?? collectInventory
  if (args.mode === 'ratchet') {
    try {
      const inventory = inventoryCollector(repoRoot)
      const config = parseRatchetConfig(await (dependencies.readFile ?? ((path) => readFile(path, 'utf8')))(join(repoRoot, 'scripts/ui-scoreboard-ratchet.json')))
      const result = checkRatchet(inventory, config)
      for (const evidence of result.failures) stderr(`${evidence.code}: ${evidence.message}${evidence.source ? ` (${evidence.source.file}:${evidence.source.line}:${evidence.source.column})` : ''}`)
      stdout(`Static ratchet: ${result.exitCode === 0 ? 'passed' : 'failed'}`)
      return result.exitCode
    } catch (error) { stderr(String(error)); return 2 }
  }
  const controller = new AbortController(); let signalExit = 0
  const signals = dependencies.signals ?? process
  const onInt = () => { signalExit ||= 130; controller.abort(new Error('SIGINT')) }
  const onTerm = () => { signalExit ||= 143; controller.abort(new Error('SIGTERM')) }
  signals.on('SIGINT', onInt); signals.on('SIGTERM', onTerm)
  try {
    await (dependencies.mkdir ?? mkdir)(args.outputDir)
    const inventory = inventoryCollector(repoRoot)
    let visuals = notRunVisuals(inventory)
    if (args.mode === 'full' && inventory.failures.length === 0) {
      try {
        visuals = await measureVisuals(inventory, { outputDir: args.outputDir, authorFamily: args.authorFamily, reviewerAlias: args.reviewerAlias, browserExecutable: args.browserExecutable, signal: controller.signal }, { capture: dependencies.captureApplication ?? captureApplication, review: dependencies.reviewManifest ?? reviewManifest })
      } catch (error) {
        visuals = notRunVisuals(inventory, 'measurement-error'); visuals.operationalError = true
        visuals.failures.push({ code: 'measurement-error', message: String(error) })
      }
    }
    const report = buildReport(inventory, visuals, args.mode)
    const write = dependencies.writeFile ?? writeFile
    const jsonPath = join(args.outputDir, 'scoreboard.json'); const markdownPath = join(args.outputDir, 'scoreboard.md')
    await write(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
    await write(markdownPath, formatMarkdown(report))
    const checks = [...report.plugins.flatMap((plugin) => plugin.checks), ...report.host.checks]
    stdout(`${report.status}: ${report.plugins.length} plugins; ${checks.filter((check) => check.applicable && check.status === 'pass').length} applicable passes, ${checks.filter((check) => check.status === 'fail').length} failures, ${checks.filter((check) => !check.applicable).length} non-applicable; ${report.cells.length} visual cells\n${jsonPath}\n${markdownPath}`)
    return signalExit || (report.status === 'error' ? 2 : report.goalPassed ? 0 : 1)
  } catch (error) { stderr(String(error)); return signalExit || 2 }
  finally { signals.off('SIGINT', onInt); signals.off('SIGTERM', onTerm) }
}

if (import.meta.main) process.exitCode = await runUiScoreboard(Bun.argv.slice(2))
