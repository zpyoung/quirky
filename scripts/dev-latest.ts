#!/usr/bin/env bun
/**
 * Runs `bun run dev` on this checkout's newest code: fast-forwards the branch from its upstream,
 * installs dependencies, replaces a daemon that runs older or other-checkout sources, then starts
 * the dev app. Terminals survive the daemon restart because the PTY host keeps them, so the PTY
 * host itself is reported but never stopped.
 *
 *   bun run dev:latest [--no-pull] [--no-launch]
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const USAGE = 'usage: bun scripts/dev-latest.ts [--no-pull] [--no-launch]'
const root = resolve(import.meta.dir, '..')
const flags = new Set(Bun.argv.slice(2))
for (const flag of flags) {
  if (flag !== '--no-pull' && flag !== '--no-launch') {
    console.error(`unknown option ${flag}\n${USAGE}`)
    process.exit(2)
  }
}

function step(message: string): void {
  console.error(`[dev-latest] ${message}`)
}

function git(...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() }
}

function run(command: string[], env: Record<string, string | undefined> = process.env): void {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, stdio: 'inherit', env })
  if (result.status !== 0) {
    step(`${command.join(' ')} failed`)
    process.exit(result.status ?? 1)
  }
}

if (flags.has('--no-pull')) {
  step('skipping git pull')
} else {
  const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
  if (!upstream.ok) {
    step('branch has no upstream, so there is nothing to pull')
  } else {
    const before = git('rev-parse', '--short', 'HEAD').out
    step(`pulling ${upstream.out}`)
    const pull = git('pull', '--ff-only')
    if (!pull.ok) {
      console.error(pull.out)
      step('git pull --ff-only failed; fix the branch or rerun with --no-pull')
      process.exit(1)
    }
    const after = git('rev-parse', '--short', 'HEAD').out
    step(before === after ? `already at ${after}` : `updated ${before} -> ${after}`)
  }
}

step('installing dependencies')
run(['bun', 'install', '--frozen-lockfile'])

// imported after install, so a fresh checkout without node_modules still gets this far
const { daemonEntryHash, ensureDaemon, isDaemonAlive, quirkyHome, readRuntime } = await import(
  '@quirky/protocol/node'
)
const home = quirkyHome()
const entry = join(root, 'packages', 'daemon', 'src', 'main.ts')
const running = readRuntime(home)
const alive = await isDaemonAlive(running)

if (alive && running?.entryHash === daemonEntryHash(entry)) {
  step(`daemon ${running.pid} is current`)
} else if (!alive && !flags.has('--no-launch')) {
  step('no daemon running; the dev app will start it')
} else {
  step(alive ? `daemon ${running?.pid} runs older or other-checkout sources; restarting it` : 'no daemon running; starting one')
  // the dev app's bundled bun, so the dev shell finds the daemon it would have started itself
  const devBun = join(root, 'apps', 'desktop', 'build', 'dev-macos-arm64', 'Quirky-dev.app', 'Contents', 'MacOS', 'bun')
  const info = await ensureDaemon({
    home,
    daemonEntry: entry,
    bunPath: existsSync(devBun) ? devBun : process.execPath,
    replaceStale: true
  })
  step(`daemon ${info.pid} started from ${root}`)
}
if (alive || flags.has('--no-launch')) reportPtyHost()

/** Names a PTY host left over from another build, since only stopping it by hand picks up its changes. */
function reportPtyHost(): void {
  const status = spawnSync('bun', [join(root, 'packages', 'cli', 'src', 'main.ts'), '--json', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, QUIRKY_HOME: home }
  })
  if (status.status !== 0) return
  const pid: number | undefined = JSON.parse(status.stdout).ptyHost?.pid
  if (!pid) return
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  if (command && !command.includes(root)) {
    step(`PTY host ${pid} runs another build (${command}). It holds every terminal, so it is left running.`)
  }
}

if (flags.has('--no-launch')) process.exit(0)
step('starting the dev app')
run(['bun', 'run', 'dev'])
