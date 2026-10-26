import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiCatalog, Schema } from '@quirky/protocol'
import { renderSkill } from '../src/skill'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

const NOTE_PARAMS: Schema = {
  type: 'object',
  properties: { title: { type: 'string' }, body: { type: 'string' } },
  required: ['title']
}

let daemon: FakeDaemon
let skills: string

beforeEach(() => {
  daemon = new FakeDaemon().start()
  daemon.addMethod('acme.notes/add', { description: 'Add a note.', params: NOTE_PARAMS })
  daemon.addMethod('quirky.repo/list', { description: 'List repos.' })
  daemon.addMethod('quirky.repo/rename', { description: 'Rename a repo.' })
  skills = realpathSync(mkdtempSync(join(tmpdir(), 'qsk-')))
})
afterEach(() => {
  daemon.stop()
  rmSync(skills, { recursive: true, force: true })
})

const run = (args: string[]) => runCli(args, { home: daemon.home, cwd: skills })
const skillFile = () => join(skills, 'quirky', 'SKILL.md')

describe('SC-22: the skill is generated from the catalog', () => {
  test('quirky skill show prints the same file twice', async () => {
    const first = await run(['skill', 'show'])
    const second = await run(['skill', 'show'])
    expect(first.code).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    const text = first.stdout
    expect(text).toStartWith('---\nname: quirky\ndescription: ')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
    expect(text).not.toContain('\r')
    expect(text).toContain('quirky api --json')
    expect(text).toContain('quirky <command> --help')
    expect(text).toContain('quirky api call <method>')
    expect(text).toContain('Exit codes: 0 ok, 1 runtime error, 2 usage error')
    expect(text).toContain('{"error":{"code","message"}}')
    expect(text).toContain('quirky acme.notes add --title <string> [--body <string>] [--params <json>]  Add a note.')
    expect(text).toContain('quirky repo rename ')
  })

  test('a shadowed command has no line', async () => {
    const { stdout } = await run(['skill', 'show'])
    expect(stdout.split('\n').filter((line) => line.startsWith('quirky repo list '))).toEqual([
      'quirky repo list  list repositories'
    ])
    expect(stdout).not.toContain('List repos.')
  })

  test('renderSkill depends only on the catalog and orders groups', async () => {
    const doc = JSON.parse((await run(['api', '--json'])).stdout) as ApiCatalog
    const reversed = { ...doc, commands: [...doc.commands].reverse() }
    expect(renderSkill(reversed)).toBe(renderSkill(doc))
    const headings = renderSkill(doc).split('\n').filter((line) => line.startsWith('### '))
    expect(headings).toEqual([...headings].sort())
  })
})

describe('SC-23: the skill installs into a folder and reports when it is stale', () => {
  test('missing, installed, up-to-date, unchanged on repeat, stale after a catalog change', async () => {
    const status = async () => (await run(['skill', 'status', '--dir', '.'])).stdout.trim()
    expect(await status()).toBe('missing')

    const installed = await run(['skill', 'install', '--dir', '.'])
    expect(installed.code).toBe(0)
    expect(installed.stdout).toBe('installed\n')
    expect(readFileSync(skillFile(), 'utf8')).toBe((await run(['skill', 'show'])).stdout)
    expect(await status()).toBe('up-to-date')

    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(skillFile(), old, old)
    const again = await run(['skill', 'install', '--dir', '.'])
    expect(again.stdout).toBe('up-to-date\n')
    expect(statSync(skillFile()).mtimeMs).toBe(old.getTime())

    daemon.addMethod('acme.extra/ping', { description: 'Ping.' })
    expect(await status()).toBe('stale')
    expect((await run(['skill', 'install', '--dir', '.'])).stdout).toBe('installed\n')
    expect(readFileSync(skillFile(), 'utf8')).toContain('quirky acme.extra ping')
    expect(await status()).toBe('up-to-date')
  })

  test('install does not follow a symlink at an old-style temp path and leaves no temp file', async () => {
    const victim = join(skills, 'victim.txt')
    writeFileSync(victim, 'untouched')
    mkdirSync(join(skills, 'quirky'))
    symlinkSync(victim, `${skillFile()}.${process.pid}.tmp`)
    const result = await run(['skill', 'install', '--dir', '.'])
    expect(result.code).toBe(0)
    expect(readFileSync(victim, 'utf8')).toBe('untouched')
    expect(readFileSync(skillFile(), 'utf8')).toBe((await run(['skill', 'show'])).stdout)
    expect(readdirSync(join(skills, 'quirky')).filter((name) => name.endsWith('.tmp') && name.startsWith('.'))).toEqual([])
  })

  test('--json prints the status and the absolute path, and --dir is resolved against the cwd', async () => {
    const result = await run(['skill', 'status', '--dir', 'sub', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ status: 'missing', path: join(skills, 'sub', 'quirky', 'SKILL.md') })
    const install = await run(['skill', 'install', '--dir', 'sub', '--json'])
    expect(JSON.parse(install.stdout)).toEqual({ status: 'installed', path: join(skills, 'sub', 'quirky', 'SKILL.md') })
  })

  test('--dir is required', async () => {
    const result = await run(['skill', 'install'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing required flag --dir')
  })
})
