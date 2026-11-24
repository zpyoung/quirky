import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixtureRepo } from './rename-to-quirky/fixture-repo.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-ipc-channel-parity.mjs')
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
      'src/preload/x.ts': `// ipcRenderer.invoke('c:commented')\n * ipcRenderer.invoke('c:doc')\n`,
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
        import { FOO_CHANNELS as CHANNELS } from '../../shared/contract'
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
})
