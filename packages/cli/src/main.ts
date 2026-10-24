#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectDaemon } from '@quirky/protocol/node'
import { UsageError, flagBoolean } from './args'
import { helpText, parseFor, route } from './commands'
import type { Context, OpenResult } from './commands/types'
import { createDaemonLink, type DaemonLink } from './link'
import { Printer, type Writer } from './output'

export type Runtime = {
  argv: string[]
  env: Record<string, string | undefined>
  cwd: string
  writer: Writer
  link: DaemonLink
  openDesktopApp(): Promise<OpenResult>
}

/** Runs one invocation and returns the process exit code: 0 ok, 1 runtime error, 2 usage error. */
export async function run(runtime: Runtime): Promise<number> {
  const { writer } = runtime
  try {
    const target = route(runtime.argv)
    if (target.kind === 'unknown') {
      throw new UsageError(
        target.word.startsWith('-') ? `unknown flag ${target.word}` : `unknown command "${target.word}"`
      )
    }
    if (target.kind === 'top') {
      writer.stdout(`${helpText()}\n`)
      return 0
    }
    const wantsHelp = target.rest.some((token) => token === '--help' || token === '-h')
    if (target.kind === 'group') {
      const text = helpText(target.words)
      if (wantsHelp) {
        writer.stdout(`${text}\n`)
        return 0
      }
      throw new UsageError(`incomplete command "${target.words.join(' ')}"\n${text}`)
    }
    if (wantsHelp && target.command.name !== 'help') {
      writer.stdout(`${helpText(target.command.name.split(' '))}\n`)
      return 0
    }
    const args = parseFor(target.command, target.rest)
    const ctx: Context = {
      rpc: runtime.link,
      out: new Printer(writer, flagBoolean(args, 'json')),
      env: runtime.env,
      cwd: runtime.cwd,
      readFile: (path) => readFileSync(resolve(runtime.cwd, path), 'utf8'),
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
      openDesktopApp: runtime.openDesktopApp
    }
    await target.command.run(args, ctx)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writer.stderr(`quirky: ${message}\n`)
    if (error instanceof UsageError) {
      writer.stderr("run 'quirky help' for usage\n")
      return 2
    }
    return 1
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
