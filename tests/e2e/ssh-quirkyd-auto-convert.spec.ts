/**
 * A relay-era SSH host converts to managed quirkyd on connect (#24979), on a real host:
 *
 * A relay-era profile (repository, folder workspace, editor tab) converts on its first connect,
 * and the new server lists them. The source rows stay retained and hidden.
 *
 * A managed host also updates to a relaunched app's bundled quirkyd on its next idle connect, and
 * reaches its server when another runtime already holds quirkyd's preferred port.
 *
 * Host: `QUIRKY_E2E_QUIRKYD_CONVERT_HOST=docker` (Linux fixture) or a Windows host-cell descriptor.
 * Template: `QUIRKY_E2E_QUIRKYD_CONVERT_TEMPLATE`, built for that host's target.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/quirky-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/quirky-restart'
import {
  convertAndRetain,
  managedServer,
  reconnect,
  serverCall
} from './helpers/quirkyd-convert-flow'
import {
  isQuirkydFullVersion,
  makeQuirkydTemplateVariant,
  readHostQuirkydActivation
} from './helpers/quirkyd-template-variant'
import { seedRelayEraProfile } from './helpers/quirkyd-upgrade-profile'
import { findQuirkydMigrationSourceCutoverForTarget } from '../../src/main/ssh/quirkyd-migration-cutover-journal'
import { toSshExecutionHostId } from '../../src/shared/execution-host'
import {
  decommissionConvertedHost,
  type ConvertedHostTeardown
} from './helpers/quirkyd-convert-teardown'
import {
  QUIRKYD_CONVERT_HOST_ENV,
  startQuirkydConvertHost,
  type QuirkydConvertHost
} from './helpers/quirkyd-convert-host'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab
} from './helpers/paired-host-terminal'
import { expectTerminalAccessibilityText } from './helpers/terminal-accessibility-tree'

const HOST = process.env[QUIRKYD_CONVERT_HOST_ENV]
const TEMPLATE_SOURCE = process.env.QUIRKY_E2E_QUIRKYD_CONVERT_TEMPLATE
// Fixed per worker so the app's launch env can name them before the test runs.
const SCRATCH = path.join(os.tmpdir(), `quirky-quirkyd-convert-${process.pid}`)
const TEMPLATE_DIR = path.join(SCRATCH, 'quirkyd-template')

// Whole file: every test needs a real host and a template built for it.
test.skip(
  !HOST || !TEMPLATE_SOURCE,
  `Set ${QUIRKYD_CONVERT_HOST_ENV} and QUIRKY_E2E_QUIRKYD_CONVERT_TEMPLATE`
)

let host: QuirkydConvertHost | null = null
function startHost(testInfo: TestInfo): QuirkydConvertHost {
  host = startQuirkydConvertHost(HOST!, testInfo)
  return host
}

test.beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
})

test.afterEach(() => {
  host?.cleanup()
  host = null
  rmSync(SCRATCH, { recursive: true, force: true })
})

test.use({
  quirkyAppExtraEnv: {
    QUIRKY_QUIRKYD_TEMPLATE_PATH: TEMPLATE_DIR
  }
})

test('a relay-era profile converts its SSH host on the first connect after upgrading', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(20 * 60_000)
  const host = startHost(testInfo)
  const session = createRestartSession(testInfo, {
    QUIRKY_QUIRKYD_TEMPLATE_PATH: TEMPLATE_SOURCE!
  })
  let app: ElectronApplication | null = null
  let teardown: (ConvertedHostTeardown & { page: Page }) | null = null
  try {
    // The first launch only establishes the profile the relay-era rows are written into.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate((repoPath) => window.api.repos.add({ path: repoPath }), testRepoPath)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(
      session.userDataDir,
      host.input,
      { repoPath: host.remoteRepoPath, folderPath: host.remoteFolderPath },
      { terminalTab: true, parkedScrollback: true }
    )
    // No relay ever ran here, so the terminal gate must prove `exited` from an empty lease set.
    // This launch bypasses the fixture's log relay; keep the SSH lines a failed move explains itself by.
    const upgraded = await session.launch({
      onStderr: (chunk) => {
        if (chunk.includes('[ssh]')) {
          process.stderr.write(chunk)
        }
      }
    })
    app = upgraded.app
    await waitForSessionReady(upgraded.page)
    // The relay-era terminal tab never spawns on the unconverted row; mounting it dials the host,
    // as the relay-era pane did, and that connect converts it.
    await upgraded.page.evaluate(
      ({ worktreeId, hostId, tabId }) => {
        const state = window.__store!.getState()
        state.setActiveWorktree(worktreeId, hostId)
        state.setActiveTab(tabId)
        state.setActiveTabType('terminal', worktreeId)
      },
      {
        worktreeId: seeded.worktreeId,
        hostId: toSshExecutionHostId(seeded.targetId),
        tabId: seeded.terminalTabId!
      }
    )
    await expect
      .poll(() => managedServer(upgraded.page, seeded.targetId), { timeout: 8 * 60_000 })
      .toMatchObject({ kind: 'managed' })
    await upgraded.page.screenshot({ path: testInfo.outputPath('relay-era-terminal-dialed.png') })
    await convertAndRetain(upgraded.page, session.userDataDir, seeded)
    // #30126: the parked panes' history rode the snapshot channel; inlined, it overflowed the manifest.
    const moved = findQuirkydMigrationSourceCutoverForTarget(session.userDataDir, seeded.targetId)
      ?.manifest.payload.dormantState
    expect(moved?.workspaceSession?.localOnlyScrollbackByTabId).toBeUndefined()
    expect(
      Object.fromEntries(
        (moved?.terminalScrollbackSnapshots ?? [])
          .filter((snapshot) => snapshot.tabId === seeded.terminalTabId)
          .map((snapshot) => [snapshot.leafId, snapshot.byteLength])
      )
    ).toEqual(
      Object.fromEntries(
        Object.entries(seeded.parkedScrollbackByLeafId).map(([leafId, buffer]) => [
          leafId,
          Buffer.byteLength(buffer)
        ])
      )
    )
    const environment = (
      await upgraded.page.evaluate(() => window.api.runtimeEnvironments.list())
    ).find((entry) => entry.quirkydDeployment?.sshTargetId === seeded.targetId)
    if (!environment) {
      throw new Error('Converted host is missing from the environment catalog')
    }
    teardown = {
      page: upgraded.page,
      environmentId: environment.id,
      targetId: seeded.targetId,
      worktreeId: seeded.worktreeId
    }
    const hostId = `runtime:${environment.id}` as const
    await upgraded.page.evaluate((hostId) => {
      const state = window.__store!.getState()
      state.setGroupBy('none')
      window.__store!.setState({ visibleWorkspaceHostIds: ['local', hostId] })
    }, hostId)
    const folder = upgraded.page.getByText('quirkyd upgrade folder', { exact: true })
    await expect(folder).toBeVisible()
    await upgraded.page.screenshot({ path: testInfo.outputPath('managed-folder-host-section.png') })
    const sectionHeader = folder.locator('xpath=preceding::*[@data-host-header-drag-id][1]')
    await expect(sectionHeader).toHaveAttribute('data-host-header-drag-id', hostId)
    const managedHeader = upgraded.page.locator(`[data-host-header-drag-id="${hostId}"]`)
    await managedHeader.click()
    await expect(folder).toBeHidden()
    await managedHeader.click()
    await expect(folder).toBeVisible()
    if (!host.exec) {
      return
    }
    await upgraded.page.evaluate(
      ({ worktreeId, environmentId }) => {
        window.__store!.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { worktreeId: seeded.worktreeId, environmentId: environment.id }
    )
    const terminal = await createPairedHostTerminal(
      upgraded.page,
      environment.id,
      seeded.worktreeId,
      'bash'
    )
    await openPairedClientTab(upgraded.page, seeded.worktreeId, terminal.webTabId)
    await callEnvironment(upgraded.page, environment.id, 'terminal.send', {
      terminal: terminal.terminal,
      text: "quirky status --json > /tmp/quirky-cli-status.json && quirky worktree ps --json > /tmp/quirky-cli-workers.json && printf 'QA_%s\\n' 'CLI_READY'",
      enter: true
    })
    await expectTerminalAccessibilityText(upgraded.page, terminal.webTabId, 'QA_CLI_READY')
    const status = JSON.parse(host.exec('cat /tmp/quirky-cli-status.json'))
    expect(status.result.runtime).toMatchObject({
      reachable: true,
      runtimeId: environment.runtimeId
    })
    expect(status.result.app.desktopWindowStatus).toBe('blocked')
    await upgraded.page.screenshot({ path: testInfo.outputPath('managed-cli-ready.png') })
  } finally {
    try {
      // The Windows account survives client exit; stop its owned runtime before the lane's grace.
      if (HOST !== 'docker' && teardown) {
        const { page, ...owned } = teardown
        const stopped = await page.evaluate(decommissionConvertedHost, owned)
        await testInfo.attach('converted-host-teardown', {
          body: JSON.stringify(stopped),
          contentType: 'application/json'
        })
      }
    } finally {
      try {
        if (app) {
          await session.close(app)
        }
      } finally {
        await session.dispose()
      }
    }
  }
})

test('a host whose sshd refuses TCP forwarding runs a managed server over the stdio bridge', async ({
  quirkyPage: page
}, testInfo) => {
  test.skip(HOST !== 'docker', 'Only the Docker host can change its sshd policy mid-test')
  test.setTimeout(15 * 60_000)
  cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
  const host = startHost(testInfo)
  host.blockTcpForwarding!()
  await waitForSessionReady(page)
  // Just the connect: a managed host serves repositories through its server, not the relay.
  const targetId = await page.evaluate(async (input) => {
    const { target } = await window.api.ssh.addTarget({ target: input })
    await window.api.ssh.connect({ targetId: target.id })
    return target.id
  }, host.input)
  const mainServer = (): Promise<string> =>
    page.evaluate(
      async (id) =>
        JSON.stringify((await window.api.ssh.getState({ targetId: id }))?.managedServer ?? null),
      targetId
    )

  await expect.poll(mainServer, { timeout: 8 * 60_000 }).toContain('"kind":"managed"')
  const target = await page.evaluate(
    async (id) => (await window.api.ssh.listTargets()).find((entry) => entry.id === id),
    targetId
  )
  expect(target?.quirkydFence).toBeTruthy()
  expect(target).not.toHaveProperty('managedServerUnavailable')
  const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
    (entry) => entry.quirkydDeployment?.sshTargetId === targetId
  )
  expect(environment, 'a managed server registered for the host').toBeTruthy()
  // sshd refuses every forward, so this call can only have ridden a stdio bridge.
  await serverCall(page, environment!.id, 'repo.list')

  // A reconnect rebuilds the tunnel the same way.
  await reconnect(page, targetId)
  await expect.poll(mainServer, { timeout: 2 * 60_000 }).toContain('"kind":"managed"')
  await serverCall(page, environment!.id, 'repo.list')
})

const heldPortProbe = `(echo > /dev/tcp/127.0.0.1/6768) 2>/dev/null && echo held || true`
// Every installed slot's readiness line names the endpoint that quirkyd actually bound.
const BOUND_ENDPOINTS = `cat /root/.quirky-remote/quirkyd-*/.quirkyd-readiness 2>/dev/null | grep -o 'ws://[0-9.:]*' || true`

test('a host whose port 6768 another runtime holds still runs a managed server', async ({
  quirkyPage: page
}, testInfo) => {
  test.skip(HOST !== 'docker', 'Only the Docker host can start a listener mid-test')
  test.setTimeout(15 * 60_000)
  cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
  const host = startHost(testInfo)
  // Stands in for a desktop Quirky on the host: it holds 6768 and turns every client away.
  host.exec!(
    `setsid nohup node -e "require('net').createServer((s) => s.destroy()).listen(6768, '127.0.0.1')" >/dev/null 2>&1 &`
  )
  await expect.poll(() => host.exec!(heldPortProbe)).toContain('held')
  await waitForSessionReady(page)
  const targetId = await page.evaluate(async (input) => {
    const { target } = await window.api.ssh.addTarget({ target: input })
    await window.api.ssh.connect({ targetId: target.id })
    return target.id
  }, host.input)

  await expect
    .poll(() => managedServer(page, targetId), { timeout: 8 * 60_000 })
    .toMatchObject({ kind: 'managed' })
  const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
    (entry) => entry.quirkydDeployment?.sshTargetId === targetId
  )
  expect(environment, 'a managed server registered for the host').toBeTruthy()
  // The other listener drops every connection, so this call can only have reached quirkyd.
  await serverCall(page, environment!.id, 'repo.list')
  // Without these the case passes vacuously whenever the stand-in is gone before quirkyd starts.
  expect(host.exec!(heldPortProbe)).toContain('held')
  expect(host.exec!(BOUND_ENDPOINTS)).toMatch(/ws:\/\/127\.0\.0\.1:(?!6768\b)\d+/)

  // A reconnect reads the bound port again rather than assuming 6768.
  await reconnect(page, targetId)
  await expect
    .poll(() => managedServer(page, targetId), { timeout: 2 * 60_000 })
    .toMatchObject({ kind: 'managed' })
  await serverCall(page, environment!.id, 'repo.list')
})

test('a managed host updates to the bundled quirkyd on the first connect after an app update', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(HOST !== 'docker', 'Reads the activation record through the Docker host')
  test.setTimeout(20 * 60_000)
  cpSync(TEMPLATE_SOURCE!, TEMPLATE_DIR, { recursive: true })
  const host = startHost(testInfo)
  const session = createRestartSession(testInfo, {
    QUIRKY_QUIRKYD_TEMPLATE_PATH: TEMPLATE_DIR
  })
  let app: ElectronApplication | null = null
  try {
    // Template A: the empty host deploys managed quirkyd on its first connect.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const targetId = await first.page.evaluate(async (input) => {
      const { target } = await window.api.ssh.addTarget({ target: input })
      return target.id
    }, host.input)
    await connectOnce(first.page, targetId)
    await expect
      .poll(() => managedServer(first.page, targetId), { timeout: 8 * 60_000 })
      .toMatchObject({ kind: 'managed' })
    const deployed = readHostQuirkydActivation(host.exec!)
    expect(isQuirkydFullVersion(deployed.active)).toBe(true)
    await session.close(app)
    app = null

    // Template B, as an app update would bundle: the tunnel restore or the next connect updates it.
    makeQuirkydTemplateVariant(TEMPLATE_DIR, 'B')
    const updated = await session.launch({
      onStderr: (chunk) => {
        if (chunk.includes('[ssh]')) {
          process.stderr.write(chunk)
        }
      }
    })
    app = updated.app
    await waitForSessionReady(updated.page)
    // Why connect, not disconnect first: on launch the app already reaches the server through its
    // tunnel, and a disconnect racing that restore cancels the connect that runs the update.
    const attempts: string[] = []
    await expect
      .poll(
        async () => {
          attempts.push(await connectOnce(updated.page, targetId))
          const record = readHostQuirkydActivation(host.exec!)
          return record.active !== deployed.active
            ? 'updated'
            : JSON.stringify({ attempts: attempts.slice(-3), record })
        },
        { timeout: 8 * 60_000, intervals: [5_000] }
      )
      .toBe('updated')
    await expect
      .poll(() => managedServer(updated.page, targetId), { timeout: 60_000 })
      .toEqual({ kind: 'managed', environmentId: expect.any(String) })
    const record = readHostQuirkydActivation(host.exec!)
    expect(isQuirkydFullVersion(record.active)).toBe(true)
    expect(record.previous).toBe(deployed.active)
    expect(record.activeAppVersion).toBeTruthy()
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})

/** One connect; returns its managed-server state, or why it threw, for a poll to report. */
function connectOnce(page: Page, targetId: string): Promise<string> {
  return page.evaluate(async (id) => {
    try {
      const state = await window.api.ssh.connect({ targetId: id })
      return JSON.stringify(state?.managedServer ?? null)
    } catch (error) {
      return `connect threw: ${String(error)}`
    }
  }, targetId)
}

test('reconnect restores the managed host name after its conversion catalog fails', async ({
  testRepoPath
}, testInfo) => {
  test.skip(HOST !== 'docker', 'Catalog fault injection uses the isolated Linux Docker host')
  test.setTimeout(180_000)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'quirky-catalog-retry-'))
  const templateDir = path.join(scratch, 'template')
  const host = startQuirkydConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { QUIRKY_QUIRKYD_TEMPLATE_PATH: templateDir })
  let app: Awaited<ReturnType<typeof session.launch>>['app'] | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    // A local project keeps a second host section, so the managed host header renders.
    await first.page.evaluate((repoPath) => window.api.repos.add({ path: repoPath }), testRepoPath)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
      folderPath: host.remoteFolderPath
    })
    // The saved profile is the relay era: no connect has run, so the first one converts.
    const upgraded = await session.launch()
    app = upgraded.app
    const page = upgraded.page
    await waitForSessionReady(page)
    await page.evaluate(() => window.__store!.getState().setGroupBy('none'))

    // Fail the local catalog IPC during a real SSH migration; healing restores its production handler.
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: unknown, ...args: unknown[]) => unknown
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron's registered invoke handlers are a Map of channel callbacks.
      const registry = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
        ._invokeHandlers
      const original = registry?.get('runtimeEnvironments:list')
      if (!original) {
        throw new Error('runtimeEnvironments:list is not registered')
      }
      ipcMain.removeHandler('runtimeEnvironments:list')
      ipcMain.handle('runtimeEnvironments:list', () => {
        throw new Error('catalog-retry: managed-host catalog temporarily unavailable')
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test installs and removes its own recovery callback within this app.
      const state = globalThis as typeof globalThis & { healCatalogFault?: () => void }
      state.healCatalogFault = () => {
        ipcMain.removeHandler('runtimeEnvironments:list')
        ipcMain.handle('runtimeEnvironments:list', original)
      }
    })
    const failure = page.waitForEvent('console', {
      predicate: (message) =>
        message.text().includes('Could not refresh the managed server list') ||
        message.text().includes('Could not load the managed server catalogs')
    })
    cpSync(TEMPLATE_SOURCE!, templateDir, { recursive: true })
    await reconnect(page, seeded.targetId)
    await expect.poll(() => managedServer(page, seeded.targetId)).toMatchObject({ kind: 'managed' })
    await failure
    await page.screenshot({ path: testInfo.outputPath('catalog-failure.png') })

    await app.evaluate(() => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fault installation above owns this optional callback.
      const state = globalThis as typeof globalThis & { healCatalogFault?: () => void }
      state.healCatalogFault?.()
    })
    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (entry) => entry.quirkydDeployment?.sshTargetId === seeded.targetId
    )
    if (!environment) {
      throw new Error('Managed host missing from main catalog')
    }
    await page.evaluate(
      (id) => window.__store!.setState({ visibleWorkspaceHostIds: ['local', `runtime:${id}`] }),
      environment.id
    )
    await reconnect(page, seeded.targetId)
    // The folder row must retain its managed execution host after the catalog heals.
    const folder = page.locator('[data-worktree-host-identity]').filter({
      has: page.getByText('quirkyd upgrade folder', { exact: true })
    })
    await expect(folder).toHaveCount(1, { timeout: 30_000 })
    await expect(folder).toHaveAttribute('data-worktree-host-identity', /runtime:/)
    await expect(
      page.locator('[data-host-header-drag-id^="runtime:"]').filter({ hasText: environment.name })
    ).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('catalog-recovered.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    host.cleanup()
    rmSync(scratch, { recursive: true, force: true })
  }
})
