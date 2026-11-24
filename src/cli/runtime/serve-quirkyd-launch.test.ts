import { describe, expect, it, vi } from 'vitest'
import { formatServeRuntimeSelection } from '../../shared/quirkyd-local-serve-selection'
import type { runProcess } from '@quirky/process-host'
import { resolveLocalServeRuntime } from './serve-quirkyd-launch'
import { quirkydServeArgs, serveOptionArgs } from '../../shared/quirkyd-serve-argv'

type RunProcess = typeof runProcess

function answering(stdout: string, code = 0): RunProcess {
  return vi.fn<RunProcess>(async () => ({
    code,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false
  }))
}

const options = {
  executable: '/Applications/Quirky.app/Contents/MacOS/Quirky',
  appRoot: '/Applications/Quirky.app/Contents/Resources/app.asar',
  userDataPath: '/Users/u/Library/Application Support/quirky',
  usesMacUpdateHandoff: false
}

describe('quirky serve asking the app which host to run', () => {
  it("runs the app's own selection entry as plain Node and reads its answer", async () => {
    const selection = {
      kind: 'quirkyd' as const,
      runtime: '/rt/node',
      entry: '/slot/quirkyd.js',
      version: '1'
    }
    const run = answering(`noise\n${formatServeRuntimeSelection(selection)}\n`)
    expect(await resolveLocalServeRuntime(options, run)).toEqual(selection)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: options.executable,
        args: [
          `${options.appRoot}/out/main/quirkyd/quirkyd-local-serve-selection-entry.js`,
          '--user-data',
          options.userDataPath,
          '--app-root',
          options.appRoot
        ],
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
        stdio: ['ignore', 'pipe', 'inherit']
      })
    )
  })

  it('keeps packaged macOS on Electron without starting the app to ask', async () => {
    const run = answering('')
    expect(await resolveLocalServeRuntime({ ...options, usesMacUpdateHandoff: true }, run)).toEqual(
      {
        kind: 'electron',
        reason: expect.stringContaining('packaged macOS')
      }
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('serves on Electron, and says why, when the app gives no answer', async () => {
    expect(await resolveLocalServeRuntime(options, answering('', 1))).toEqual({
      kind: 'electron',
      reason: expect.stringContaining('did not answer')
    })
    const failing = vi.fn<RunProcess>(async () => {
      throw new Error('spawn ENOENT')
    })
    expect(await resolveLocalServeRuntime(options, failing)).toEqual({
      kind: 'electron',
      reason: expect.stringContaining('spawn ENOENT')
    })
  })

  it('forwards every desktop serve flag, binding wide as Electron serve does', () => {
    expect(
      quirkydServeArgs({
        json: true,
        port: '6768',
        pairingAddress: '10.0.0.5',
        noPairing: true,
        mobilePairing: true,
        recipeJson: true,
        projectRoot: '/work/app'
      })
    ).toEqual([
      '--bind',
      '0.0.0.0',
      '--json',
      '--port',
      '6768',
      '--pairing-address',
      '10.0.0.5',
      '--no-pairing',
      '--mobile-pairing',
      '--recipe-json',
      '--project-root',
      '/work/app'
    ])
    expect(quirkydServeArgs({})).toEqual(['--bind', '0.0.0.0'])
  })

  // #30100: the slot carries no browser client, so without this quirkyd served no web page.
  it("hands quirkyd the app's browser client directory when the app has one", () => {
    expect(
      quirkydServeArgs({ port: '6768' }, '/opt/Quirky/resources/app.asar.unpacked/out/web')
    ).toEqual([
      '--bind',
      '0.0.0.0',
      '--port',
      '6768',
      '--web-client-root',
      '/opt/Quirky/resources/app.asar.unpacked/out/web'
    ])
  })

  it('spells the same flags with the --serve- prefix for the Electron host', () => {
    expect(
      serveOptionArgs(
        {
          json: true,
          port: '6768',
          pairingAddress: '10.0.0.5',
          noPairing: true,
          mobilePairing: true,
          grantDesktopControl: true,
          recipeJson: true,
          projectRoot: '/work/app'
        },
        '--serve-'
      )
    ).toEqual([
      '--serve-json',
      '--serve-port',
      '6768',
      '--serve-pairing-address',
      '10.0.0.5',
      '--serve-no-pairing',
      '--serve-mobile-pairing',
      '--serve-grant-desktop-control',
      '--serve-recipe-json',
      '--serve-project-root',
      '/work/app'
    ])
    expect(serveOptionArgs({ recipeJson: true }, '--serve-')).toEqual([])
  })
})
