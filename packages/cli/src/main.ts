#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RpcError, RpcErrorCode, type ApiDescription } from '@quirky/protocol'
import { connectDaemon } from '@quirky/protocol/node'
import pkg from '../package.json'
import { CommandFailed, StderrFailure, UsageError, extractGlobals, wantsHelp } from './args'
import { resolveCommands } from './catalog'
import { COMMANDS, helpText, isGlobalToken, parseFor, route } from './commands'
import type { Command, Context, OpenResult } from './commands/types'
import { generatedCommands } from './generated'
import { ConnectionLostError, DaemonUnavailableError, createDaemonLink, type DaemonLink } from './link'
import { Printer, type Writer } from './output'
import { declaredCommands } from './plugin-commands'
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

/** True when `--version` or `-v` is the only switch besides an optional `--json`. */
function wantsVersion(argv: readonly string[]): boolean {
  const versionFlag = (token: string) => token === '--version' || token === '-v'
  const jsonFlag = (token: string) => token === '--json' || token === '--json=true' || token === '--json=false'
  return argv.some(versionFlag) && argv.every((token) => versionFlag(token) || jsonFlag(token))
}

/** The global switches before the first other token; later help flags belong to a `rawArgs` command. */
function leadingGlobals(tokens: readonly string[]): string[] {
  const end = tokens.findIndex((token) => !isGlobalToken(token))
  return end === -1 ? [...tokens] : tokens.slice(0, end)
}

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
  const groupWithoutHelp = target.kind === 'group' && !startsWithWord(target.rest) && !wantsHelp(target.rest, {})
  const needsCatalog =
    (target.kind === 'unknown' && !target.word.startsWith('-')) || (target.kind === 'group' && startsWithWord(target.rest))
  if (needsCatalog || groupWithoutHelp) {
    try {
      const description = (await ctx.rpc.callAny('api.describe', {})) as ApiDescription
      commands = [
        ...COMMANDS,
        ...resolveCommands(COMMANDS, declaredCommands(description), generatedCommands(description)).active
      ]
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
  const helpRequested =
    target.kind === 'command' && !target.command.rawArgs
      ? wantsHelp(target.rest, target.command.flags)
      : wantsHelp(target.kind === 'command' ? leadingGlobals(target.rest) : target.rest, {})
  if (target.kind === 'group') {
    if (startsWithWord(target.rest)) throw unknownCommand(argv, commands)
    const text = helpText(target.words, commands)
    if (helpRequested) {
      writer.stdout(`${text}\n`)
      return
    }
    throw new UsageError(`incomplete command "${target.words.join(' ')}"\n${text}`)
  }
  const { command } = target
  if (helpRequested && command.name !== 'help') {
    writer.stdout(`${helpText(command.name.split(' '), commands)}\n`)
    return
  }
  const args = command.rawArgs
    ? { positionals: target.rest, flags: { json: out.json } }
    : parseFor(command, target.rest)
  await command.run(args, ctx)
}

const RPC_ERROR_CODES: Record<number, string> = {
  [RpcErrorCode.InvalidParams]: 'invalid-params',
  [RpcErrorCode.NotFound]: 'not-found',
  [RpcErrorCode.Conflict]: 'conflict',
  [RpcErrorCode.MethodNotFound]: 'method-not-found',
  [RpcErrorCode.Unauthorized]: 'unauthorized',
  [RpcErrorCode.ConfirmationRequired]: 'confirmation-required'
}

function errorCode(error: unknown): string {
  if (error instanceof UsageError) return 'usage'
  if (error instanceof DaemonUnavailableError) return 'daemon-unavailable'
  if (error instanceof ConnectionLostError) return 'connection-lost'
  if (error instanceof RpcError) {
    return error.code === RpcErrorCode.Conflict && error.message === 'declined' ? 'declined' : (RPC_ERROR_CODES[error.code] ?? 'internal')
  }
  return 'internal'
}

/** The machine-readable reason a plugin attached to an RPC error as `data.reason`, if it did. */
function errorReason(error: unknown): string | undefined {
  if (!(error instanceof RpcError)) return undefined
  const data = error.data
  if (typeof data !== 'object' || data === null) return undefined
  const reason = (data as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : undefined
}

/** The `data` object an RPC error carries, verbatim, when it is a non-null object. */
function errorData(error: unknown): object | undefined {
  if (!(error instanceof RpcError)) return undefined
  const data: unknown = error.data
  return typeof data === 'object' && data !== null ? data : undefined
}

/** Prints `error` the way the mode asks for and returns the exit code. */
function report(error: unknown, out: Printer, writer: Writer): number {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof UsageError ? 2 : 1
  if (error instanceof CommandFailed) {
    if (!out.json || error instanceof StderrFailure) writer.stderr(`quirky: ${message}\n`)
    return code
  }
  const suggestions = error instanceof UsageError ? error.suggestions : []
  if (out.json) {
    const reason = errorReason(error)
    const data = errorData(error)
    out.jsonLine({
      error: {
        code: errorCode(error),
        message,
        ...(reason !== undefined ? { reason } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(suggestions.length ? { suggestions } : {})
      }
    })
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
    if (wantsVersion(runtime.argv)) {
      out.result({ version: pkg.version }, () => `quirky ${pkg.version}`)
      return 0
    }
    await dispatch(runtime, out, extractGlobals(runtime.argv).argv)
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

/** The link's settings from the argv; a malformed switch is left for `run` to report as a usage error. */
function linkOptions(argv: readonly string[]) {
  try {
    const { options } = extractGlobals(argv)
    return { yes: options.yes, requestBase: options.retryRequest }
  } catch {
    return {}
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const stderr = (text: string) => void process.stderr.write(text)
  const connectOptions: Parameters<typeof connectDaemon>[0] = {
    role: 'cli',
    name: 'quirky',
    transport: 'socket',
    identity: {
      cwd: process.cwd(),
      sessionId: process.env.QUIRKY_SESSION_ID,
      worktreeId: process.env.QUIRKY_WORKTREE_ID
    }
  }
  const code = await run({
    argv,
    env: process.env,
    cwd: process.cwd(),
    writer: { stdout: (text) => void process.stdout.write(text), stderr },
    link: createDaemonLink(() => connectDaemon(connectOptions), { ...linkOptions(argv), stderr }),
    openDesktopApp
  })
  process.exitCode = code
}
