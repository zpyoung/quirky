import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixtureRepo } from './fixture-repo.mjs'
import { applyMapping, isBoundaryMatch, mapGeneric } from './mapping.mjs'
import { planPathMoves } from './plan-moves.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'rename.mjs')
const repos = []

function makeRepo(files) {
  const repo = createFixtureRepo(files)
  repos.push(repo)
  return repo
}

function rename(repo, { allowlist = {}, args = [] } = {}) {
  const allowlistFile = repo.writeAllowlist(allowlist)
  const reportFile = join(repo.root, '..', 'report.json')
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--root', repo.root, '--allowlist', allowlistFile, '--report', reportFile, ...args],
    { encoding: 'utf8' }
  )
  let report = null
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'))
  } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report }
}

afterEach(() => {
  while (repos.length) {
    repos.pop().cleanup()
  }
})

describe('mapGeneric', () => {
  it('maps every case form, longest first', () => {
    expect(mapGeneric('orcad Orcad ORCAD orca Orca ORCA')).toBe(
      'quirkyd Quirkyd QUIRKYD quirky Quirky QUIRKY'
    )
  })

  it('maps inside identifiers and env names', () => {
    expect(mapGeneric('OrcaRuntimeService orcaPage ORCA_USER_DATA_PATH orca-dev')).toBe(
      'QuirkyRuntimeService quirkyPage QUIRKY_USER_DATA_PATH quirky-dev'
    )
  })
})

describe('isBoundaryMatch', () => {
  const at = (text, needle) => isBoundaryMatch(text, text.indexOf(needle), needle.length)

  it('accepts separators, camel humps and string edges', () => {
    expect(at('orca', 'orca')).toBe(true)
    expect(at('orca-dev', 'orca')).toBe(true)
    expect(at('~/.orca/x', 'orca')).toBe(true)
    expect(at('ORCA_USER', 'ORCA')).toBe(true)
    expect(at('OrcaRuntime', 'Orca')).toBe(true)
    expect(at('orcaPage', 'orca')).toBe(true)
    expect(at('getOrca', 'Orca')).toBe(true)
    expect(at('v2orca3', 'orca')).toBe(true)
    expect(at('orcad', 'orcad')).toBe(true)
  })

  it('rejects matches buried inside a word', () => {
    expect(at('torcas', 'orca')).toBe(false)
    expect(at('Orcas', 'Orca')).toBe(false)
    expect(at('porcaro', 'orca')).toBe(false)
    expect(at('ORCAS', 'ORCA')).toBe(false)
    expect(at('XOrca', 'Orca')).toBe(false)
    expect(at('orcadia', 'orcad')).toBe(false)
  })
})

describe('applyMapping', () => {
  it('lets explicit identity mappings beat the generic ones', () => {
    const { text } = applyMapping('Orca Dev|com.stablyai.orca.computer-use|com.stably.orca.mobile')
    expect(text).toBe('Quirky|com.zpyoung.quirky.computer-use|com.zpyoung.quirky.mobile')
  })

  it('only treats Orca Dev as the product name when it is a whole word', () => {
    expect(applyMapping('Orca Developer docs').text).toBe('Quirky Developer docs')
  })

  it('protects keepTokens from every mapping', () => {
    const { text, keepHits } = applyMapping('Orca stablyai/orca orca', {
      keepTokens: ['stablyai/orca']
    })
    expect(text).toBe('Quirky stablyai/orca quirky')
    expect(keepHits).toBe(1)
  })

  it('remaps the homepage field even though stablyai/orca is a keep token', () => {
    const input = '{"homepage": "https://github.com/stablyai/orca", "bugs": "github.com/stablyai/orca/issues"}'
    const { text } = applyMapping(input, { relPath: 'package.json', keepTokens: ['stablyai/orca'] })
    expect(text).toBe(
      '{"homepage": "https://github.com/zpyoung/quirky", "bugs": "github.com/stablyai/orca/issues"}'
    )
  })

  it('does not treat zpyoung/orca as a keep token', () => {
    expect(applyMapping('zpyoung/orca', { keepTokens: ['stablyai/orca'] }).text).toBe('zpyoung/quirky')
  })

  it('moves the websocket ports only in the two pinned files', () => {
    const port = 'const P = 6768; const D = 6769'
    expect(
      applyMapping(port, { relPath: 'src/main/runtime/runtime-rpc/runtime-rpc-pairing-types.ts' }).text
    ).toBe('const P = 6778; const D = 6779')
    expect(applyMapping(port, { relPath: 'src/main/runtime/rpc/ws-fallback-port-store.ts' }).text).toBe(
      'const P = 6778; const D = 6779'
    )
    expect(applyMapping(port, { relPath: 'src/other.ts' }).text).toBe(port)
    expect(
      applyMapping('x = 16768', { relPath: 'src/main/runtime/rpc/ws-fallback-port-store.ts' }).text
    ).toBe('x = 16768')
  })

  it('reports suspicious matches with their line and still maps them', () => {
    const { text, suspicious } = applyMapping('ok orcaPage\nthe torcas here\nporcaro')
    expect(text).toBe('ok quirkyPage\nthe tquirkys here\npquirkyro')
    expect(suspicious.map((s) => s.line)).toEqual([2, 3])
    expect(applyMapping('torcas porcaro').suspicious).toHaveLength(1)
    expect(suspicious[0].text).toBe('the torcas here')
  })
})

describe('planPathMoves', () => {
  const mapPath = (p) => p.replaceAll('orca', 'quirky')

  it('plans a move for every changed path', () => {
    const plan = planPathMoves(['a/orca/x.ts', 'b.ts'], mapPath, () => false)
    expect(plan.moves).toEqual([{ from: 'a/orca/x.ts', to: 'a/quirky/x.ts' }])
    expect(plan.collisions).toEqual([])
  })

  it('flags two sources that map to one target, ignoring case', () => {
    const plan = planPathMoves(['a/orca.txt', 'a/Orca.txt'], (p) => p.toLowerCase().replace('orca', 'quirky'), () => false)
    expect(plan.collisions).toHaveLength(1)
  })

  it('flags a target that already exists', () => {
    const plan = planPathMoves(['a/orca.txt'], mapPath, (p) => p === 'a/quirky.txt')
    expect(plan.collisions).toEqual([{ from: 'a/orca.txt', to: 'a/quirky.txt', reason: 'target exists' }])
  })
})

describe('rename.mjs', () => {
  it('rewrites content with case-preserving mapping', () => {
    const repo = makeRepo({
      'src/a.ts':
        "export class OrcaRuntimeService {}\nconst orcaPage = process.env.ORCA_USER_DATA_PATH\nconst c = 'orca:open'\nconst d = 'orcad'\n",
      'src/style.css': '.orca-sidebar { color: red }\n',
      'src/data.json': '{"orca": {"orcaId": "Orca"}}\n'
    })
    const { status, report } = rename(repo)
    expect(status).toBe(0)
    expect(repo.read('src/a.ts')).toBe(
      "export class QuirkyRuntimeService {}\nconst quirkyPage = process.env.QUIRKY_USER_DATA_PATH\nconst c = 'quirky:open'\nconst d = 'quirkyd'\n"
    )
    expect(repo.read('src/style.css')).toBe('.quirky-sidebar { color: red }\n')
    expect(repo.read('src/data.json')).toBe('{"quirky": {"quirkyId": "Quirky"}}\n')
    expect(report.filesChanged).toBe(3)
    expect(report.matchesByFile['src/a.ts']).toBe(5)
  })

  it('applies explicit identity mappings over the generic ones', () => {
    const repo = makeRepo({
      'config/app.json':
        '{"productName": "Orca Dev", "id": "com.stablyai.orca.computer-use", "mobile": "com.stably.orca.mobile", "repo": "zpyoung/orca"}\n',
      'package.json': '{"name": "orca", "homepage": "https://github.com/stablyai/orca"}\n'
    })
    rename(repo, { allowlist: { keepTokens: ['stablyai/orca'] } })
    expect(repo.read('config/app.json')).toBe(
      '{"productName": "Quirky", "id": "com.zpyoung.quirky.computer-use", "mobile": "com.zpyoung.quirky.mobile", "repo": "zpyoung/quirky"}\n'
    )
    expect(repo.read('package.json')).toBe(
      '{"name": "quirky", "homepage": "https://github.com/zpyoung/quirky"}\n'
    )
  })

  it('moves the pinned websocket ports in their two files', () => {
    const repo = makeRepo({
      'src/main/runtime/rpc/ws-fallback-port-store.ts': 'const DEV_PINNED_WS_PORT = 6769\n',
      'src/main/other.ts': 'const p = 6769\n'
    })
    rename(repo)
    expect(repo.read('src/main/runtime/rpc/ws-fallback-port-store.ts')).toBe(
      'const DEV_PINNED_WS_PORT = 6779\n'
    )
    expect(repo.read('src/main/other.ts')).toBe('const p = 6769\n')
  })

  it('keeps keepTokens wherever they appear', () => {
    const url = 'https://github.com/stablyai/orca/pull/1'
    const repo = makeRepo({ 'docs/a.md': `${url}\nOrca is at ${url} and orca too\n` })
    const { report } = rename(repo, { allowlist: { keepTokens: ['stablyai/orca'] } })
    expect(repo.read('docs/a.md')).toBe(`${url}\nQuirky is at ${url} and quirky too\n`)
    expect(report.skippedByAllowlist.keepTokenHits).toBe(2)
  })

  it('leaves skipPaths unedited and unmoved', () => {
    const repo = makeRepo({
      'vendor/orca-lib/x.txt': 'orca\n',
      'LICENSE': 'Orca license\n',
      'src/keep.ts': 'orca\n'
    })
    const { report } = rename(repo, { allowlist: { skipPaths: ['vendor/**', 'LICENSE'] } })
    expect(repo.read('vendor/orca-lib/x.txt')).toBe('orca\n')
    expect(repo.read('LICENSE')).toBe('Orca license\n')
    expect(repo.read('src/keep.ts')).toBe('quirky\n')
    expect(report.skippedByAllowlist.paths).toBe(2)
    expect(report.pathMoves).toEqual([])
  })

  it('moves files and nested directories with git mv', () => {
    const repo = makeRepo({
      'src/orca/orca-utils/orcaThing.ts': 'export const orcaThing = 1\n',
      'src/orca/readme.md': 'hello\n',
      'src/main/orca-profiles/index.ts': 'export {}\n'
    })
    const { status, report } = rename(repo)
    expect(status).toBe(0)
    expect(repo.tracked()).toEqual([
      'src/main/quirky-profiles/index.ts',
      'src/quirky/quirky-utils/quirkyThing.ts',
      'src/quirky/readme.md'
    ])
    expect(repo.read('src/quirky/quirky-utils/quirkyThing.ts')).toBe('export const quirkyThing = 1\n')
    expect(repo.exists('src/orca')).toBe(false)
    expect(repo.git('status', '--porcelain')).not.toMatch(/^\?\?/m)
    expect(report.pathMoves).toContainEqual({
      from: 'src/orca/orca-utils/orcaThing.ts',
      to: 'src/quirky/quirky-utils/quirkyThing.ts'
    })
    expect(report.pathMoves).toHaveLength(3)
  })

  it('exits 1 without touching anything when a target already exists', () => {
    const repo = makeRepo({ 'a/orca.txt': 'orca\n', 'a/quirky.txt': 'already here\n' })
    const { status, stderr } = rename(repo)
    expect(status).toBe(1)
    expect(stderr).toContain('a/quirky.txt')
    expect(repo.read('a/orca.txt')).toBe('orca\n')
    expect(repo.read('a/quirky.txt')).toBe('already here\n')
  })

  it('never edits binary files but still moves them', () => {
    const bytes = Buffer.concat([Buffer.from('PNG'), Buffer.from([0, 1, 2]), Buffer.from('orca Orca')])
    const repo = makeRepo({ 'assets/orca-logo.png': bytes })
    const { report } = rename(repo)
    expect(repo.readBytes('assets/quirky-logo.png').equals(bytes)).toBe(true)
    expect(report.filesChanged).toBe(0)
    expect(report.pathMoves).toEqual([{ from: 'assets/orca-logo.png', to: 'assets/quirky-logo.png' }])
  })

  it('leaves files that are not valid utf8 alone', () => {
    const bytes = Buffer.from([0x6f, 0x72, 0x63, 0x61, 0xff, 0xfe])
    const repo = makeRepo({ 'legacy.txt': bytes })
    rename(repo)
    expect(repo.readBytes('legacy.txt').equals(bytes)).toBe(true)
  })

  it('changes nothing on --dry-run but writes the report', () => {
    const repo = makeRepo({ 'src/orca/a.ts': 'orca\n' })
    const before = repo.git('status', '--porcelain')
    const { status, report } = rename(repo, { args: ['--dry-run'] })
    expect(status).toBe(0)
    expect(repo.read('src/orca/a.ts')).toBe('orca\n')
    expect(repo.git('status', '--porcelain')).toBe(before)
    expect(report.filesChanged).toBe(1)
    expect(report.matchesByFile).toEqual({ 'src/orca/a.ts': 1 })
    expect(report.pathMoves).toEqual([{ from: 'src/orca/a.ts', to: 'src/quirky/a.ts' }])
  })

  it('is idempotent', () => {
    const repo = makeRepo({
      'src/orca/a.ts': 'Orca Dev orca ORCA_X com.stablyai.orca\n',
      'src/main/runtime/rpc/ws-fallback-port-store.ts': 'const DEV_PINNED_WS_PORT = 6769\n',
      'package.json': '{"homepage": "https://github.com/stablyai/orca"}\n'
    })
    const allowlist = { keepTokens: ['stablyai/orca'] }
    rename(repo, { allowlist })
    const afterFirst = { files: repo.tracked(), content: repo.read('src/quirky/a.ts') }
    const second = rename(repo, { allowlist })
    expect(second.status).toBe(0)
    expect(second.report.filesChanged).toBe(0)
    expect(second.report.pathMoves).toEqual([])
    expect(repo.tracked()).toEqual(afterFirst.files)
    expect(repo.read('src/quirky/a.ts')).toBe(afterFirst.content)
  })

  it('lists suspicious matches with file and line', () => {
    const repo = makeRepo({
      'src/a.ts': 'const ok = orcaPage\nconst bad = "torcas"\n',
      'src/b.ts': 'Orcas and porcaro\nORCA_X\n'
    })
    const { report } = rename(repo)
    expect(report.suspiciousMatches).toEqual([
      { file: 'src/a.ts', line: 2, text: 'const bad = "torcas"' },
      { file: 'src/b.ts', line: 1, text: 'Orcas and porcaro' }
    ])
    expect(repo.read('src/a.ts')).toContain('tquirkys')
  })

  it('prints the report to stdout without --report', () => {
    const repo = makeRepo({ 'a.txt': 'orca\n' })
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--dry-run', '--root', repo.root, '--allowlist', repo.writeAllowlist()],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).filesChanged).toBe(1)
  })

  it('exits 2 on bad arguments', () => {
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }).status
    expect(run('--nope')).toBe(2)
    expect(run('--report')).toBe(2)
    expect(run('--root', '/definitely/not/a/dir')).toBe(2)
  })

  it('exits 2 on a malformed allowlist', () => {
    const repo = makeRepo({ 'a.txt': 'orca\n' })
    const bad = repo.writeAllowlist({ skipPaths: 'nope' })
    const result = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', repo.root, '--allowlist', bad], {
      encoding: 'utf8'
    })
    expect(result.status).toBe(2)
  })
})
