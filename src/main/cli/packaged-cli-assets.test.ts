import { execFile, spawn } from 'node:child_process'
import { globSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createPackageWithOptions, statFile } from '@electron/asar'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@quirky/process-host'
import { stagePackagedProcessHost } from '../../../config/scripts/packaged-process-host-fixture.mjs'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const itRunsUnixShell = process.platform === 'win32' ? it.skip : it
const unixTerminationSignals = ['SIGINT', 'SIGTERM'] as const
const builderConfig = require('../../../config/electron-builder.config.cjs') as {
  files?: string[]
  asarUnpack?: string[]
}
const darwinLauncherAsset = new URL('../../../resources/darwin/bin/quirky', import.meta.url)
const unixLauncherFixtures = [
  {
    name: 'macOS',
    asset: darwinLauncherAsset,
    appDir: ['Quirky.app'],
    launcher: ['Contents', 'Resources', 'bin', 'quirky'],
    executable: ['Contents', 'MacOS', 'Quirky'],
    cli: ['Contents', 'Resources', 'app.asar.unpacked', 'out', 'cli', 'index.js']
  }
] as const

describe('packaged CLI assets', () => {
  it('ships embedded skill guides with the CLI instead of source Markdown', () => {
    // Why: `skills get` must work from the packaged CLI without falling back to
    // authoring-only files that do not exist in installed applications.
    expect(builderConfig.asarUnpack).toContain('out/cli/**')
    expect(builderConfig.files).toContain('!skill-guides{,/**/*}')
  })

  it('loads worktree link validation from the installed CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quirky-cli-gitlab-package-'))
    const projectDir = fileURLToPath(new URL('../../../', import.meta.url))
    const source = join(root, 'app-source')
    const archive = join(root, 'resources', 'app.asar')
    try {
      const compile = await runProcess({
        program: process.execPath,
        args: [
          join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc'),
          '-p',
          join(projectDir, 'config', 'tsconfig.build.cli.json'),
          '--outDir',
          join(source, 'out'),
          '--composite',
          'false',
          '--incremental',
          'false',
          // This fixture checks the emitted package; the CLI typecheck runs separately.
          '--noCheck'
        ],
        cwd: projectDir,
        timeoutMs: 60_000
      })
      expect(compile.code, compile.stdout + compile.stderr).toBe(0)
      expect(globSync('**/*.{test,spec}.{js,jsx,cjs,mjs}', { cwd: join(source, 'out') })).toEqual(
        []
      )
      await mkdir(dirname(archive), { recursive: true })
      await writeFile(join(source, 'out', 'package.json'), JSON.stringify({ type: 'commonjs' }))
      for (const name of ['zod', 'tweetnacl']) {
        await cp(
          join(projectDir, 'node_modules', name),
          join(root, 'resources', 'node_modules', name),
          {
            recursive: true,
            dereference: true
          }
        )
      }
      await stagePackagedProcessHost(join(root, 'resources'))
      await createPackageWithOptions(source, archive, {
        unpack: `{${builderConfig.asarUnpack?.map((pattern) => join(source, pattern).split(sep).join('/')).join(',')}}`
      })
      expect(statFile(archive, join('out', 'cli', 'index.js')).unpacked).toBe(true)
      const result = await runProcess({
        program: process.execPath,
        args: [
          join(`${archive}.unpacked`, 'out', 'cli', 'index.js'),
          'worktree',
          'create',
          '--repo',
          'id:repo',
          '--name',
          'packaged-link',
          '--no-parent',
          '--pr',
          '0',
          '--json'
        ],
        cwd: root,
        env: {
          ...process.env,
          QUIRKY_BACKGROUND_LAUNCH: '1',
          NODE_PATH: '',
          NODE_OPTIONS: '',
          QUIRKY_USER_DATA_PATH: join(root, 'user-data'),
          HOME: join(root, 'home')
        },
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(2)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument', message: 'Pass a positive safe integer for --pr.' }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries an incomplete listener-state write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quirky-listener-state-'))
    const statePath = join(root, 'listener-state.json')
    const expectedState = { pid: 1234, port: 5678 }
    await writeFile(statePath, '{"pid":', 'utf8')
    const completedWrite = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        writeFile(statePath, JSON.stringify(expectedState), 'utf8').then(resolve, reject)
      }, 50)
    })

    try {
      await expect(waitForListenerState(statePath)).resolves.toEqual(expectedState)
    } finally {
      await completedWrite
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { state: { pid: '1234', port: 5678 }, reason: 'non-numeric pid' },
    { state: { pid: 0, port: 5678 }, reason: 'non-positive pid' },
    { state: { pid: 1234, port: '5678' }, reason: 'non-numeric port' },
    { state: { pid: 1234, port: 65_536 }, reason: 'out-of-range port' }
  ])('rejects $reason in listener state', async ({ state }) => {
    const root = await mkdtemp(join(tmpdir(), 'quirky-listener-state-'))
    const statePath = join(root, 'listener-state.json')
    try {
      await writeFile(statePath, JSON.stringify(state), 'utf8')
      await expect(waitForListenerState(statePath)).rejects.toThrow(
        'Invalid launcher listener state'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  itRunsUnixShell.each(unixLauncherFixtures)(
    'delivers Unix termination signals to the $name executable and releases its listener',
    async (launcherFixture) => {
      for (const signal of unixTerminationSignals) {
        const root = await mkdtemp(join(tmpdir(), 'quirky-unix-cli-signal-'))
        const appDir = join(root, ...launcherFixture.appDir)
        const launcherPath = join(appDir, ...launcherFixture.launcher)
        const electronPath = join(appDir, ...launcherFixture.executable)
        const cliPath = join(appDir, ...launcherFixture.cli)
        const statePath = join(root, `${signal}-listener-state.json`)
        let executablePid: number | null = null
        let launcher: ReturnType<typeof spawn> | null = null
        try {
          await mkdir(dirname(launcherPath), { recursive: true })
          await mkdir(dirname(electronPath), { recursive: true })
          await mkdir(dirname(cliPath), { recursive: true })
          await copyFile(launcherFixture.asset, launcherPath)
          await writeFile(cliPath, '', 'utf8')
          await writeFile(
            electronPath,
            `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const server = net.createServer()
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.QUIRKY_TEST_LISTENER_STATE, JSON.stringify({
    pid: process.pid,
    port: server.address().port
  }))
})
`,
            { encoding: 'utf8', mode: 0o755 }
          )

          launcher = spawn(launcherPath, [], {
            env: { ...process.env, QUIRKY_TEST_LISTENER_STATE: statePath },
            stdio: 'ignore'
          })
          const state = await waitForListenerState(statePath)
          executablePid = state.pid
          const launcherPid = launcher.pid
          const launcherExitPromise = waitForChildExit(launcher, 5_000)
          launcher.kill(signal)
          const launcherExit = await launcherExitPromise
          const exitCode = launcherExit?.[0]
          const exitSignal = launcherExit?.[1]

          expect.soft(executablePid).toBe(launcherPid)
          expect.soft(launcherExit).not.toBeNull()
          expect.soft(exitCode).toBe(0)
          expect.soft(exitSignal).toBeNull()
          expect.soft(await waitForPortRelease(state.port)).toBe(true)
        } finally {
          if (launcher?.pid) {
            await terminateSyntheticProcess(launcher.pid)
          }
          if (executablePid && executablePid !== launcher?.pid) {
            await terminateSyntheticProcess(executablePid)
          }
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  )

  // Observe each launcher's actual child env and argv, including arguments with spaces.
  itRunsUnixShell.each(unixLauncherFixtures)(
    'sanitizes node env and forwards argv verbatim through the $name launcher',
    async (launcherFixture) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'quirky-unix-cli-env-')))
      try {
        const appDir = join(root, ...launcherFixture.appDir)
        const launcherPath = join(appDir, ...launcherFixture.launcher)
        const electronPath = join(appDir, ...launcherFixture.executable)
        const cliPath = join(appDir, ...launcherFixture.cli)

        await mkdir(dirname(launcherPath), { recursive: true })
        await mkdir(dirname(electronPath), { recursive: true })
        await mkdir(dirname(cliPath), { recursive: true })
        await copyFile(launcherFixture.asset, launcherPath)
        await writeFile(cliPath, '', 'utf8')
        await writeFile(
          electronPath,
          `#!/usr/bin/env bash
node -e 'console.log(JSON.stringify({
  argv: process.argv.slice(1),
  runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  quirkyNodeOptions: process.env.QUIRKY_NODE_OPTIONS ?? null,
  nodeReplExternalModule: process.env.NODE_REPL_EXTERNAL_MODULE ?? null,
  quirkyNodeReplExternalModule: process.env.QUIRKY_NODE_REPL_EXTERNAL_MODULE ?? null
}))' -- "$@"
`,
          { encoding: 'utf8', mode: 0o755 }
        )

        const result = await execFileAsync(launcherPath, ['--help', 'two words'], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '0',
            NODE_OPTIONS: '--trace-warnings',
            NODE_REPL_EXTERNAL_MODULE: 'external-loader'
          }
        })
        const payload = JSON.parse(result.stdout) as {
          argv: string[]
          runAsNode: string
          nodeOptions: string | null
          quirkyNodeOptions: string | null
          nodeReplExternalModule: string | null
          quirkyNodeReplExternalModule: string | null
        }

        expect(payload.argv).toEqual([cliPath, '--help', 'two words'])
        expect(payload.runAsNode).toBe('1')
        // Why: Electron's node bootstrap must not inherit these, but the CLI
        // still needs to see what the user set.
        expect(payload.nodeOptions).toBeNull()
        expect(payload.quirkyNodeOptions).toBe('--trace-warnings')
        expect(payload.nodeReplExternalModule).toBeNull()
        expect(payload.quirkyNodeReplExternalModule).toBe('external-loader')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

async function waitForListenerState(path: string): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const state: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (
        typeof state !== 'object' ||
        state === null ||
        !('pid' in state) ||
        typeof state.pid !== 'number' ||
        !Number.isInteger(state.pid) ||
        state.pid <= 0 ||
        !('port' in state) ||
        typeof state.port !== 'number' ||
        !Number.isInteger(state.port) ||
        state.port <= 0 ||
        state.port > 65_535
      ) {
        throw new Error('Invalid launcher listener state')
      }
      return { pid: state.pid, port: state.port }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error('Timed out waiting for launcher listener state')
}

async function waitForPortRelease(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net')
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (!connected) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<readonly [number | null, NodeJS.Signals | null] | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve([child.exitCode, child.signalCode])
      return
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout)
      resolve([code, signal])
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(null)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function terminateSyntheticProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  if (await waitForProcessExit(pid, 1_000)) {
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
  if (!(await waitForProcessExit(pid, 1_000))) {
    throw new Error(`Failed to terminate synthetic launcher process ${pid}`)
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return !isProcessAlive(pid)
}
