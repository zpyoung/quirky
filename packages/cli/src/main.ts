#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RpcError, RpcErrorCode, type ApiDescription } from '@quirky/protocol'
import { connectDaemon } from '@quirky/protocol/node'
import { CommandFailed, UsageError } from './args'
import { resolveCommands } from './catalog'
import { COMMANDS, helpText, isGlobalToken, parseFor, route } from './commands'
import type { Command, Context, OpenResult } from './commands/types'
import { generatedCommands } from './generated'
import { DaemonUnavailableError, createDaemonLink, type DaemonLink } from './link'
import { Printer, type Writer } from './output'
import { suggestCommands } from './suggest'

export type Runtime = {
  argv: string[]
  env: Record<string, string | undefined>
  cwd: string
  writer: Writer
  link: DaemonLink
  openDesktopApp(): Promise<OpenResult>
}

/** True when the last of `--json`, `--json=true` and `--json=false` before `--` turns JSON on. */
function wantsJson(argv: readonly string[]): boolean {
  let json = false
  for (const token of argv) {
    if (token === '--') break
    if (token === '--json' || token === '--json=true') json = true
    else if (token === '--json=false') json = false
  }
  return json
}

const hasHelpFlag = (rest: readonly string[]) => rest.some((token) => token === '--help' || token === '-h')

/** True when the first token that is not a global switch is a word rather than a flag. */
function startsWithWord(tokens: readonly string[]): boolean {
  const first = tokens.find((token) => !isGlobalToken(token))
  return first !== undefined && !first.startsWith('-')
}

function typedWords(argv: readonly string[]): string {
  const words: string[] = []
  for (const token of argv) {
    if (isGlobalToken(token)) continue
    if (token.startsWith('-') || words.length === 2) break
    words.push(token)
  }
  return words.join(' ')
}

function unknownCommand(argv: readonly string[], commands: readonly Command[]): UsageError {
  const typed = typedWords(argv)
  return new UsageError(
    `unknown command "${typed}"`,
    suggestCommands(
      typed,
      commands.map((command) => command.name)
    )
  )
}

/** Tokens a `rawArgs` command parses itself: everything after its words except the global switches. */
function withoutGlobals(rest: readonly string[]): string[] {
  const end = rest.indexOf('--')
  const head = end === -1 ? rest : rest.slice(0, end)
  return [...head.filter((token) => !isGlobalToken(token)), ...(end === -1 ? [] : rest.slice(end))]
}

async function dispatch(runtime: Runtime, out: Printer, argv: readonly string[]): Promise<void> {
  const { writer } = runtime
  const ctx: Context = {
    rpc: runtime.link,
    out,
    env: runtime.env,
    cwd: runtime.cwd,
    readFile: (path) => readFileSync(resolve(runtime.cwd, path), 'utf8'),
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    openDesktopApp: runtime.openDesktopApp
  }
  let commands: readonly Command[] = COMMANDS
  let target = route(argv, commands)
  if (target.kind === 'command' && target.command.name === 'help') {
    const words = target.rest.filter((token) => !isGlobalToken(token))
    if (words.length && !words.some((word) => word.startsWith('-'))) return dispatch(runtime, out, [...words, '--help'])
  }
  const groupWithoutHelp = target.kind === 'group' && !startsWithWord(target.rest) && !hasHelpFlag(target.rest)
  const needsCatalog =
    (target.kind === 'unknown' && !target.word.startsWith('-')) || (target.kind === 'group' && startsWithWord(target.rest))
  if (needsCatalog || groupWithoutHelp) {
    try {
      const description = (await ctx.rpc.callAny('api.describe', {})) as ApiDescription
      commands = [...COMMANDS, ...resolveCommands(COMMANDS, generatedCommands(description)).active]
      target = route(argv, commands)
    } catch (error) {
      // a bare group is a usage error whether or not the daemon can list its plugin commands
      if (!groupWithoutHelp) throw error
    }
  }
  if (target.kind === 'unknown') {
    throw target.word.startsWith('-') ? new UsageError(`unknown flag ${target.word}`) : unknownCommand(argv, commands)
  }
  if (target.kind === 'top') {
    writer.stdout(`${helpText()}\n`)
    return
  }
  const wantsHelp = hasHelpFlag(target.rest)
  if (target.kind === 'group') {
    if (startsWithWord(target.rest)) throw unknownCommand(argv, commands)
    const text = helpText(target.words, commands)
    if (wantsHelp) {
      writer.stdout(`${text}\n`)
      return
    }
    throw new UsageError(`incomplete command "${target.words.join(' ')}"\n${text}`)
  }
  const { command } = target
  if (wantsHelp && command.name !== 'help') {
    writer.stdout(`${helpText(command.name.split(' '), commands)}\n`)
    return
  }
  const args = command.rawArgs
    ? { positionals: withoutGlobals(target.rest), flags: { json: out.json } }
    : parseFor(command, target.rest)
  await command.run(args, ctx)
}

const RPC_ERROR_CODES: Record<number, string> = {
  [RpcErrorCode.InvalidParams]: 'invalid-params',
  [RpcErrorCode.NotFound]: 'not-found',
  [RpcErrorCode.Conflict]: 'conflict',
  [RpcErrorCode.MethodNotFound]: 'method-not-found',
  [RpcErrorCode.Unauthorized]: 'unauthorized'
}

function errorCode(error: unknown): string {
  if (error instanceof UsageError) return 'usage'
  if (error instanceof DaemonUnavailableError) return 'daemon-unavailable'
  if (error instanceof RpcError) return RPC_ERROR_CODES[error.code] ?? 'internal'
  return 'internal'
}

/** Prints `error` the way the mode asks for and returns the exit code. */
function report(error: unknown, out: Printer, writer: Writer): number {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof UsageError ? 2 : 1
  if (error instanceof CommandFailed) {
    if (!out.json) writer.stderr(`quirky: ${message}\n`)
    return code
  }
  const suggestions = error instanceof UsageError ? error.suggestions : []
  if (out.json) {
    out.jsonLine({ error: { code: errorCode(error), message, ...(suggestions.length ? { suggestions } : {}) } })
    return code
  }
  writer.stderr(`quirky: ${message}\n`)
  if (suggestions.length) writer.stderr(`did you mean: ${suggestions.map((name) => `quirky ${name}`).join(', ')}\n`)
  if (error instanceof UsageError) writer.stderr("run 'quirky help' for usage\n")
  return code
}

/** Runs one invocation and returns the process exit code: 0 ok, 1 runtime error, 2 usage error. */
export async function run(runtime: Runtime): Promise<number> {
  const out = new Printer(runtime.writer, wantsJson(runtime.argv))
  try {
    await dispatch(runtime, out, runtime.argv)
    return 0
  } catch (error) {
    return report(error, out, runtime.writer)
  } finally {
    runtime.link.close()
  }
}

async function openDesktopApp(): Promise<OpenResult> {
  if (process.platform !== 'darwin') return { ok: false, reason: '`quirky open` is only supported on macOS' }
  const proc = Bun.spawn(['open', '-a', 'Quirky'], { stdout: 'ignore', stderr: 'pipe' })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code === 0) return { ok: true }
  return { ok: false, reason: `the Quirky desktop app is not installed (${stderr.trim() || `open exited ${code}`})` }
}

if (import.meta.main) {
  const code = await run({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    writer: {
      stdout: (text) => void process.stdout.write(text),
      stderr: (text) => void process.stderr.write(text)
    },
    link: createDaemonLink(() => connectDaemon({ role: 'cli', name: 'quirky' })),
    openDesktopApp
  })
  process.exitCode = code
}
