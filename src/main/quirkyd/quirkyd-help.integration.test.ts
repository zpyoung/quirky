import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '@quirky/process-host'
import {
  QUIRKYD_LAUNCHER_FILENAME,
  QUIRKYD_SERVER_ENTRY_FILENAME
} from '../../shared/quirkyd-artifacts'

let directory = ''
let launcher = ''

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'quirkyd-help-'))
  launcher = join(directory, QUIRKYD_LAUNCHER_FILENAME)
  const builder = pathToFileURL(join(process.cwd(), 'config/scripts/quirkyd-entry-build.mjs')).href
  const built = await runProcess({
    program: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      `import {buildQuirkydEntry,buildQuirkydLauncher} from ${JSON.stringify(builder)};` +
        `await buildQuirkydEntry(${JSON.stringify(join(directory, QUIRKYD_SERVER_ENTRY_FILENAME))});` +
        `await buildQuirkydLauncher(${JSON.stringify(launcher)});`
    ],
    env: { ...process.env, QUIRKY_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 60_000
  })
  expect(built.code, built.stderr).toBe(0)
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('real quirkyd executable help', () => {
  it.each([['--help'], ['-h'], ['--json', '--help'], ['--help', '--json']])(
    'prints usage to stdout and exits without creating a profile: %j',
    async (...argv) => {
      const dataRoot = join(directory, `absent-${argv.join('-')}`)
      const result = await runProcess({
        program: process.execPath,
        args: [launcher, ...argv],
        env: { ...process.env, QUIRKY_BACKGROUND_LAUNCH: '1', QUIRKY_USER_DATA: dataRoot },
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('Usage: quirkyd [options]')
      expect(result.stdout).toContain('--bind <ip>')
      expect(result.stdout).not.toContain('"type":"quirky_server_ready"')
      await expect(readdir(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('leaves an existing instance lock untouched', async () => {
    const dataRoot = join(directory, 'locked-profile')
    await mkdir(dataRoot)
    const lock = join(dataRoot, 'quirkyd.lock')
    const content = 'an existing instance owns this profile\n'
    await writeFile(lock, content)
    const result = await runProcess({
      program: process.execPath,
      args: [launcher, '--help'],
      env: { ...process.env, QUIRKY_BACKGROUND_LAUNCH: '1', QUIRKY_USER_DATA: dataRoot },
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(await readFile(lock, 'utf8')).toBe(content)
    expect(await readdir(dataRoot)).toEqual(['quirkyd.lock'])
  })
})
