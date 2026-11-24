import { spawnSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixtureRepo } from './rename-to-quirky/fixture-repo.mjs'

const SCRIPT = join(import.meta.dirname, 'check-ipc-channel-parity.mjs')
const repos = []

function makeRepo(files) {
  const repo = createFixtureRepo(files)
  repos.push(repo)
  return repo
}

function parity(repo, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', repo.root, ...args], {
    encoding: 'utf8'
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function parityJson(repo, args = []) {
  const result = parity(repo, ['--json', ...args])
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null }
}

afterEach(() => {
  while (repos.length) {
    repos.pop().cleanup()
  }
})

const FIXTURE = {
  'src/main/ipc/a.ts': `
    import { ipcMain } from 'electron'
    ipcMain.handle('a:handled', () => 1)
    ipcMain.on("a:onlyMain", () => {})
    ipcMain.handleOnce(\`a:once\`, () => {})
    win.webContents.send('a:pushed', 1)
    mainWindow.webContents.send("a:pushedNobodyListens", 1)
    webContents.send('a:bare')
  `,
  'src/preload/index.ts': `
    ipcRenderer.invoke('a:handled')
    ipcRenderer.invoke('a:noHandler', {})
    ipcRenderer.send('a:sendNoHandler')
    ipcRenderer.sendSync('a:onlyMain')
    ipcRenderer.on('a:pushed', cb)
    ipcRenderer.once('a:bare', cb)
    ipcRenderer.invoke(
      'a:multiline',
      payload
    )
    ipcRenderer.invoke(\`a:template-\${id}\`)
  `,
  'src/main/ipc/a.test.ts': `ipcRenderer.invoke('a:fromTest')`
}

describe('check-ipc-channel-parity.mjs', () => {
  it('reports renderer calls without a main handler and main sends without a listener', () => {
    const { status, json } = parityJson(makeRepo(FIXTURE))
    expect(status).toBe(0)
    expect(json.rendererWithoutMain).toEqual(['a:multiline', 'a:noHandler', 'a:sendNoHandler'])
    expect(json.mainSendWithoutRenderer).toEqual(['a:pushedNobodyListens'])
  })

  it('prints a readable listing without --json', () => {
    const { status, stdout } = parity(makeRepo(FIXTURE))
    expect(status).toBe(0)
    expect(stdout).toContain('rendererWithoutMain (3)')
    expect(stdout).toContain('  a:noHandler')
    expect(stdout).toContain('mainSendWithoutRenderer (1)')
  })

  it('ignores comment lines and test files', () => {
    const repo = makeRepo({
      'src/preload/x.ts': `// ipcRenderer.invoke('c:commented')\n/**\n * ipcRenderer.invoke('c:doc')\n */\n`,
      'src/preload/x.test.tsx': `ipcRenderer.invoke('c:test')`
    })
    expect(parityJson(repo).json.rendererWithoutMain).toEqual([])
  })

  it('resolves channel constants, including an aliased _CHANNELS import and a _CHANNEL string', () => {
    const repo = makeRepo({
      'src/shared/contract.ts': `
        export const FOO_CHANNELS = { listPanes: 'foo:listPanes', attach: 'foo:attach' } as const
        export const FOO_PROGRESS_CHANNEL = 'foo:progress'
        export const NOT_A_CHANNEL_LIST = { x: 'foo:ignored' }
      `,
      'src/main/ipc/foo.ts': `
        import { FOO_CHANNELS as CHANNELS, FOO_PROGRESS_CHANNEL } from '../../shared/contract'
        ipcMain.handle(CHANNELS.listPanes, () => [])
        window.webContents.send(FOO_PROGRESS_CHANNEL, 1)
        window.webContents.send(CHANNELS['attach'], 1)
      `,
      'src/preload/foo.ts': `
        import { FOO_CHANNELS as CHANNELS } from '../shared/contract'
        ipcRenderer.invoke(CHANNELS.listPanes)
        ipcRenderer.invoke(CHANNELS.attach)
        ipcRenderer.on(CHANNELS.attach, cb)
      `
    })
    const { json } = parityJson(repo)
    expect(json.rendererWithoutMain).toEqual(['foo:attach'])
    expect(json.mainSendWithoutRenderer).toEqual(['foo:progress'])
  })

  it('collects array-valued _CHANNELS consts without crashing on unresolved identifiers', () => {
    const repo = makeRepo({
      'src/main/ssh.ts': `
        const SSH_IPC_CHANNELS = ['ssh:a', 'ssh:b'] as const
        for (const ch of SSH_IPC_CHANNELS) ipcMain.removeHandler(ch)
        ipcMain.handle(dynamicName, () => 1)
      `,
      'src/preload/ssh.ts': `ipcRenderer.invoke('ssh:a')`
    })
    const { status, json } = parityJson(repo)
    expect(status).toBe(0)
    expect(json.rendererWithoutMain).toEqual(['ssh:a'])
  })

  it('exits 0 with a baseline that already lists every mismatch', () => {
    const repo = makeRepo(FIXTURE)
    const baseline = join(repo.root, '..', 'baseline.json')
    writeFileSync(baseline, JSON.stringify(parityJson(repo).json))
    expect(parity(repo, ['--baseline', baseline]).status).toBe(0)
  })

  it('exits 1 and lists mismatches missing from the baseline', () => {
    const repo = makeRepo(FIXTURE)
    const baseline = join(repo.root, '..', 'baseline.json')
    writeFileSync(
      baseline,
      JSON.stringify({ rendererWithoutMain: ['a:noHandler'], mainSendWithoutRenderer: [] })
    )
    const { status, json } = parityJson(repo, ['--baseline', baseline])
    expect(status).toBe(1)
    expect(json.rendererWithoutMain).toEqual(['a:multiline', 'a:sendNoHandler'])
    expect(json.mainSendWithoutRenderer).toEqual(['a:pushedNobodyListens'])
  })

  it('compares against an orca baseline after --apply-rename-mapping', () => {
    const repo = makeRepo({
      'src/preload/index.ts': `
        ipcRenderer.invoke('quirky:noHandler')
        ipcRenderer.invoke('QUIRKY_PING')
      `,
      'src/main/ipc/a.ts': `window.webContents.send('quirkyd:pushed', 1)`
    })
    const baseline = join(repo.root, '..', 'baseline.json')
    writeFileSync(
      baseline,
      JSON.stringify({
        rendererWithoutMain: ['orca:noHandler', 'ORCA_PING'],
        mainSendWithoutRenderer: ['orcad:pushed']
      })
    )
    expect(parity(repo, ['--baseline', baseline]).status).toBe(1)
    expect(parity(repo, ['--baseline', baseline, '--apply-rename-mapping']).status).toBe(0)
  })

  it('exits 2 on bad arguments and an unreadable baseline', () => {
    const repo = makeRepo(FIXTURE)
    expect(parity(repo, ['--wat']).status).toBe(2)
    expect(parity(repo, ['--baseline', '/no/such/file.json']).status).toBe(2)
  })

  it('keeps same-named constants from different modules apart', () => {
    const repo = makeRepo({
      'src/shared/a.ts': `export const SHARED_CHANNEL = 'p:one'`,
      'src/shared/b.ts': `export const SHARED_CHANNEL = 'p:two'`,
      'src/main/handler.ts': `
        import { SHARED_CHANNEL } from '../shared/a'
        ipcMain.handle(SHARED_CHANNEL, () => 1)
      `,
      'src/preload/caller.ts': `
        import { SHARED_CHANNEL as OTHER } from '../shared/b'
        ipcRenderer.invoke(OTHER)
      `
    })
    expect(parityJson(repo).json.rendererWithoutMain).toEqual(['p:two'])
  })

  it('resolves a constant through a barrel re-export and prefers a local declaration', () => {
    const repo = makeRepo({
      'src/shared/real.ts': `export const BAR_CHANNELS = { go: 'bar:go' }`,
      'src/shared/other.ts': `export const BAR_CHANNELS = { go: 'bar:wrong' }`,
      'src/shared/index.ts': `export { BAR_CHANNELS } from './real'`,
      'src/main/handler.ts': `
        import { BAR_CHANNELS } from '../shared'
        ipcMain.handle(BAR_CHANNELS.go, () => 1)
      `,
      'src/preload/caller.ts': `
        import { BAR_CHANNELS } from '../shared/other'
        ipcRenderer.invoke(BAR_CHANNELS.go)
      `,
      'src/preload/local.ts': `
        const BAR_CHANNELS = { go: 'bar:local' }
        ipcRenderer.invoke(BAR_CHANNELS.go)
      `
    })
    expect(parityJson(repo).json.rendererWithoutMain).toEqual(['bar:local', 'bar:wrong'])
  })

  it('ignores calls inside multiline block comments and string literals', () => {
    const repo = makeRepo({
      'src/preload/x.ts': [
        '/*',
        "  ipcRenderer.invoke('c:inBlock')",
        '*/',
        "const url = 'http://example.com'; ipcRenderer.invoke('c:afterUrl')",
        'const text = "ipcRenderer.invoke(\'c:inString\')"',
        "const tpl = `ipcRenderer.invoke('c:inTemplate')`",
        "ipcRenderer.invoke(/* c:inline */ 'c:live')",
        ''
      ].join('\n')
    })
    expect(parityJson(repo).json.rendererWithoutMain).toEqual(['c:afterUrl', 'c:live'])
  })

  it('compares channel names after decoding literal escapes', () => {
    const repo = makeRepo({
      'src/main/h.ts': String.raw`
        ipcMain.handle('a\x3ab', () => 1)
        ipcMain.handle("it\'s", () => 1)
        ipcMain.handle('u\u003av', () => 1)
        const E_CHANNEL = 'e\x3af'
        ipcMain.handle(E_CHANNEL, () => 1)
      `,
      'src/preload/c.ts': String.raw`
        ipcRenderer.invoke('a:b')
        ipcRenderer.invoke('it\'s')
        ipcRenderer.invoke('u:v')
        ipcRenderer.invoke('e:f')
      `
    })
    expect(parityJson(repo).json.rendererWithoutMain).toEqual([])
  })

  it('reads backtick literals that hold $ without interpolation', () => {
    const repo = makeRepo({
      'src/preload/c.ts': 'ipcRenderer.invoke(`a:$cost`)\nipcRenderer.invoke(`a:${id}`)\n'
    })
    expect(parityJson(repo).json.rendererWithoutMain).toEqual(['a:$cost'])
  })

  it('exits 2 with a message when src is missing, empty or unreadable', () => {
    const missing = parity(makeRepo({}))
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('src')
    expect(missing.stdout).toBe('')

    const empty = makeRepo({ 'src/notes.md': 'x', 'src/only.test.ts': `ipcRenderer.invoke('t:x')` })
    expect(parity(empty).status).toBe(2)

    const locked = makeRepo({ 'src/a.ts': `ipcRenderer.invoke('l:x')` })
    chmodSync(join(locked.root, 'src'), 0o000)
    try {
      expect(parity(locked).status).toBe(2)
    } finally {
      chmodSync(join(locked.root, 'src'), 0o755)
    }
  })
})
