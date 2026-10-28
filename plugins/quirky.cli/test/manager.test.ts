import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'

const harnesses: Harness[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  removeTempDirs()
})

async function start() {
  const home = makeTempHome('quirky-cli-manager-home-')
  tempDirs.push(home)
  const builtins = makeTempDir('quirky-cli-manager-builtins-')
  symlinkSync(resolve(import.meta.dir, '..'), join(builtins, 'quirky.cli'))
  const harness = await startHarness({ home, builtinPluginsDir: builtins })
  harnesses.push(harness)
  return { home, caller: await harness.connect('cli') }
}

function entrypoint(dir: string, marker: string): string {
  const path = join(dir, 'cli target.mjs')
  writeFileSync(path, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ home: process.env.QUIRKY_HOME, args: process.argv.slice(2) }))\n`)
  return path
}

test('external command install reports missing then managed and invokes its pinned CLI target/profile', async () => {
  const { home, caller } = await start()
  const dir = mkdtempSync('/tmp/quirky-cli-manager-')
  tempDirs.push(dir)
  const commandPath = join(dir, 'commands with spaces', 'quirky')
  const marker = join(dir, 'launch.json')
  const target = entrypoint(dir, marker)
  const args = { path: commandPath, executablePath: process.execPath, entrypointPath: target, profileHome: join(dir, "profile with 'quote"), yes: true }

  expect(await caller.callAny('quirky.cli/commandStatus', { path: commandPath, profileHome: home })).toMatchObject({ state: 'missing', target: null })
  await caller.callAny('quirky.cli/commandInstall', args)
  expect(await caller.callAny('quirky.cli/commandStatus', { path: commandPath, profileHome: args.profileHome })).toMatchObject({
    path: commandPath, target, state: 'managed', profileHome: args.profileHome
  })
  expect(statSync(commandPath).mode & 0o777).toBe(0o755)
  execFileSync(commandPath, ['argument with spaces'], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: home, QUIRKY_HOME: home } })
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ home: args.profileHome, args: ['argument with spaces'] })
})

test('foreign launchers are preserved unless replacement is explicitly requested and replaced files are never uninstalled', async () => {
  const { home, caller } = await start()
  const dir = mkdtempSync('/tmp/quirky-cli-foreign-')
  tempDirs.push(dir)
  const commandPath = join(dir, 'quirky')
  const marker = join(dir, 'launch.json')
  const target = entrypoint(dir, marker)
  mkdirSync(dir, { recursive: true })
  writeFileSync(commandPath, '#!/bin/sh\nprintf foreign\n')
  chmodSync(commandPath, 0o755)
  const foreignContents = readFileSync(commandPath, 'utf8')
  const args = { path: commandPath, executablePath: process.execPath, entrypointPath: target, profileHome: home, yes: true }

  expect(await caller.callAny('quirky.cli/commandStatus', { path: commandPath, profileHome: home })).toMatchObject({ state: 'foreign', target: null })
  await expect(caller.callAny('quirky.cli/commandInstall', { ...args, replaceForeign: false })).rejects.toThrow(/foreign/)
  expect(readFileSync(commandPath, 'utf8')).toBe(foreignContents)

  await caller.callAny('quirky.cli/commandInstall', { ...args, replaceForeign: true })
  expect(await caller.callAny('quirky.cli/commandStatus', { path: commandPath, profileHome: home })).toMatchObject({ state: 'managed', target })
  writeFileSync(commandPath, '#!/bin/sh\nprintf replaced\n')
  expect(await caller.callAny('quirky.cli/commandUninstall', { path: commandPath, yes: true })).toMatchObject({ removed: false, state: 'foreign' })
  expect(existsSync(commandPath)).toBe(true)
  expect(readFileSync(commandPath, 'utf8')).toContain('replaced')
})

test('two profile launchers execute the same CLI entrypoint with isolated quoted QUIRKY_HOME values', async () => {
  const { home, caller } = await start()
  const dir = mkdtempSync('/tmp/quirky-cli-profiles-')
  tempDirs.push(dir)
  const marker = join(dir, 'launch.json')
  const target = entrypoint(dir, marker)
  const executablePath = process.execPath
  const profileHomes = [join(dir, "one profile 'green"), join(dir, 'second profile with spaces')]
  const launchers = [join(dir, 'bin', 'quirky-one'), join(dir, 'bin', 'quirky-two')]

  for (let index = 0; index < profileHomes.length; index++) {
    await caller.callAny('quirky.cli/profileLauncherInstall', {
      name: `profile-${index + 1}`, path: launchers[index], profileHome: profileHomes[index], executablePath, entrypointPath: target, yes: true
    })
    execFileSync(launchers[index], [`argument-${index + 1}`], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: home, QUIRKY_HOME: home } })
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ home: profileHomes[index], args: [`argument-${index + 1}`] })
  }
})
