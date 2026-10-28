import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, EmptyState, ListRow, SectionHeader, TextField } from '@quirky/ui'
import type { FolderPickerResult, UiPluginContext } from '@quirky/protocol'
import type {
  CliLaunchTarget,
  InstalledCommandStatus,
  PairedRuntimeSummary,
  ProfileLauncherStatus
} from '@quirky/protocol/node'

const SETTINGS_VIEW = 'view:quirky.cli/settings'

type CliTarget = {
  available: boolean
  executablePath: CliLaunchTarget['executablePath'] | null
  entrypointPath: CliLaunchTarget['entrypointPath'] | null
}


function statusTone(state: InstalledCommandStatus['state'] | ProfileLauncherStatus['state']): 'neutral' | 'needs-you' {
  if (state === 'foreign') return 'needs-you'
  return 'neutral'
}

function statusDot(state: InstalledCommandStatus['state'] | ProfileLauncherStatus['state']): 'idle' | 'done' | 'needs-you' {
  if (state === 'managed') return 'done'
  if (state === 'foreign') return 'needs-you'
  return 'idle'
}

function CliSettings({ context }: { context: UiPluginContext }) {
  const [status, setStatus] = useState<InstalledCommandStatus | null>(null)
  const [target, setTarget] = useState<CliTarget | null>(null)
  const [launchers, setLaunchers] = useState<ProfileLauncherStatus[]>([])
  const [runtimes, setRuntimes] = useState<PairedRuntimeSummary[]>([])
  const [profileName, setProfileName] = useState('')
  const [profileHome, setProfileHome] = useState('')
  const [profilePath, setProfilePath] = useState('')
  const [runtimeName, setRuntimeName] = useState('')
  const [pairingOffer, setPairingOffer] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const active = useRef(false)
  const refreshSequence = useRef(0)
  const actionInFlight = useRef(false)

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    if (active.current) {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const [rawStatus, rawTarget, rawLaunchers, rawRuntimes] = await Promise.all([
        context.call('quirky.cli/commandStatus', {}),
        context.call('quirky.cli/commandTarget', {}),
        context.call('quirky.cli/profileLauncherList', {}),
        context.call('quirky.cli/runtimeList', {})
      ])
      if (!active.current || sequence !== refreshSequence.current) return

      const nextStatus = rawStatus as InstalledCommandStatus
      const nextTarget = rawTarget as CliTarget
      const nextLaunchers = rawLaunchers as { launchers: ProfileLauncherStatus[] }
      const nextRuntimes = rawRuntimes as { runtimes: PairedRuntimeSummary[] }
      setStatus(nextStatus)
      setTarget(nextTarget)
      setLaunchers(nextLaunchers.launchers)
      setRuntimes(nextRuntimes.runtimes)
      setProfileHome((current) => current || nextStatus.profileHome)
    } catch (error) {
      if (active.current && sequence === refreshSequence.current) setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (active.current && sequence === refreshSequence.current) setLoading(false)
    }
  }, [context])

  useEffect(() => {
    active.current = true
    void refresh()
    return () => {
      active.current = false
      refreshSequence.current++
    }
  }, [refresh])

  const runAction = useCallback(async (action: () => Promise<void>) => {
    if (!active.current || actionInFlight.current) return
    actionInFlight.current = true
    setBusy(true)
    setActionError(null)
    try {
      await action()
      if (!active.current) return
      await refresh()
    } catch (error) {
      if (active.current) setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      actionInFlight.current = false
      if (active.current) setBusy(false)
    }
  }, [refresh])

  const chooseProfileHome = () => runAction(async () => {
    const result = await context.call('desktop.folder.pick', {
      title: 'Choose profile QUIRKY_HOME',
      ...(profileHome ? { startingFolder: profileHome } : {}),
      multiple: false
    }) as FolderPickerResult
    if (active.current && !result.cancelled && result.paths.length === 1) setProfileHome(result.paths[0])
  })

  const createProfileLauncher = () => runAction(async () => {
    if (!target?.available || !target.executablePath || !target.entrypointPath) {
      throw new Error('no verified CLI executable and entrypoint are available')
    }
    if (!profileName.trim() || !profileHome.trim()) throw new Error('profile name and QUIRKY_HOME are required')
    await context.call('quirky.cli/profileLauncherInstall', {
      name: profileName,
      profileHome,
      ...(profilePath ? { path: profilePath } : {}),
      executablePath: target.executablePath,
      entrypointPath: target.entrypointPath
    })
    if (active.current) {
      setProfileName('')
      setProfilePath('')
    }
  })

  const saveRuntime = () => runAction(async () => {
    if (!runtimeName.trim() || !pairingOffer.trim()) throw new Error('runtime name and pairing offer are required')
    await context.call('quirky.cli/runtimeAdd', { name: runtimeName, pairingCode: pairingOffer })
    if (active.current) {
      setPairingOffer('')
      setRuntimeName('')
    }
  })

  const installCommand = () => runAction(async () => {
    if (!status || !target?.available || !target.executablePath || !target.entrypointPath) {
      throw new Error('no verified CLI executable and entrypoint are available')
    }
    let replaceForeign = false
    if (status.state === 'foreign') {
      replaceForeign = await context.confirm({
        title: 'Replace foreign command?',
        body: `Replace the foreign launcher at ${status.path}?`
      })
      if (!replaceForeign || !active.current) return
    }
    await context.call('quirky.cli/commandInstall', {
      path: status.path,
      profileHome: status.profileHome,
      executablePath: target.executablePath,
      entrypointPath: target.entrypointPath,
      replaceForeign
    })
  })

  const statusReadout = status
    ? [
        `Status: ${status.state}`,
        `Path: ${status.path}`,
        `Target: ${status.target ?? 'none'}`,
        `Profile: ${status.profileHome}`,
        target?.available
          ? `Install target: ${target.entrypointPath ?? 'none'}`
          : 'No verified CLI entrypoint is available in this desktop host; install from the CLI invocation that supplies its real target.'
      ].join('\n')
    : loading ? 'Loading CLI and runtime profile status…' : 'CLI and runtime profile status is unavailable.'

  return (
    <section className="ui-stack" aria-label="CLI and Runtime Profiles">
      <section className="ui-stack" aria-label="External CLI command">
        <SectionHeader title="External CLI command" />
        <pre className="ui-readout" aria-label="External CLI command status">{statusReadout}</pre>
        <div className="ui-cluster">
          <Button
            variant="primary"
            disabled={busy || loading || !status || !target?.available}
            onClick={() => void installCommand()}
          >
            {status?.state === 'managed' ? 'Update managed command' : 'Install command'}
          </Button>
          {status?.state === 'managed' && (
            <>
              <Button disabled={busy || loading} onClick={() => void runAction(async () => {
                await context.call('quirky.cli/commandReveal', {})
              })}>Reveal command</Button>
              <Button variant="destructive" disabled={busy || loading} onClick={() => void runAction(async () => {
                await context.call('quirky.cli/commandUninstall', { path: status.path })
              })}>Uninstall command</Button>
            </>
          )}
        </div>
      </section>

      <section className="ui-stack" aria-label="Profile launchers">
        <SectionHeader title="Profile launchers" />
        <form className="ui-stack" onSubmit={(event) => event.preventDefault()}>
          <TextField label="Profile launcher name" value={profileName} onChange={(event) => setProfileName(event.currentTarget.value)} />
          <TextField label="Profile QUIRKY_HOME" value={profileHome} onChange={(event) => setProfileHome(event.currentTarget.value)} />
          <TextField label="Launcher path (optional)" value={profilePath} onChange={(event) => setProfilePath(event.currentTarget.value)} />
          <div className="ui-cluster">
            <Button disabled={busy || loading} onClick={() => void chooseProfileHome()}>Choose profile folder</Button>
            <Button variant="primary" disabled={busy || loading} onClick={() => void createProfileLauncher()}>Create profile launcher</Button>
          </div>
        </form>
        {launchers.length === 0 ? <EmptyState message="No profile launchers are installed." /> : (
          <div className="ui-stack">
            {launchers.map((launcher) => (
              <ListRow
                key={launcher.path}
                title={launcher.name}
                description={<span className="ui-stack">{`Path: ${launcher.path}`}<span>{`QUIRKY_HOME: ${launcher.profileHome}`}</span></span>}
                status={statusDot(launcher.state)}
                trailing={(
                  <div className="ui-cluster">
                    <Badge tone={statusTone(launcher.state)}>{launcher.state}</Badge>
                    {launcher.state === 'managed' && (
                      <Button variant="destructive" disabled={busy || loading} onClick={() => void runAction(async () => {
                        await context.call('quirky.cli/profileLauncherRemove', { path: launcher.path })
                      })}>Remove {launcher.name}</Button>
                    )}
                  </div>
                )}
              />
            ))}
          </div>
        )}
      </section>

      <section className="ui-stack" aria-label="Saved paired runtimes">
        <SectionHeader title="Saved paired runtimes" />
        <form className="ui-stack" onSubmit={(event) => event.preventDefault()}>
          <TextField label="Runtime name" value={runtimeName} onChange={(event) => setRuntimeName(event.currentTarget.value)} />
          <TextField label="Pairing offer" type="password" autoComplete="off" value={pairingOffer} onChange={(event) => setPairingOffer(event.currentTarget.value)} />
          <div className="ui-cluster">
            <Button variant="primary" disabled={busy || loading} onClick={() => void saveRuntime()}>Save paired runtime</Button>
          </div>
        </form>
        {runtimes.length === 0 ? <EmptyState message="No paired runtimes are saved." /> : (
          <div className="ui-stack">
            {runtimes.map((runtime) => (
              <ListRow
                key={runtime.id}
                title={runtime.name}
                description={<span className="ui-stack">{`ID: ${runtime.id}`}<span>{`Endpoint: ${runtime.endpoint}`}</span><span>{`Paired device: ${runtime.pairedDeviceId}`}</span></span>}
                status="done"
                trailing={(
                  <div className="ui-cluster">
                    <Badge tone="neutral">Saved</Badge>
                    <Button variant="destructive" disabled={busy || loading} onClick={() => void runAction(async () => {
                      await context.call('quirky.cli/runtimeRemove', { selector: runtime.id })
                    })}>Remove {runtime.name}</Button>
                  </div>
                )}
              />
            ))}
          </div>
        )}
      </section>

      {loading && <p aria-live="polite">Refreshing CLI and runtime status…</p>}
      {loadError && (
        <div role="alert" className="ui-stack">
          <p>{loadError}</p>
          <Button disabled={loading || busy} onClick={() => void refresh()}>Retry status</Button>
        </div>
      )}
      {actionError && <p role="alert">{actionError}</p>}
    </section>
  )
}

export function activate(context: UiPluginContext): void {
  context.provide(SETTINGS_VIEW, (element: HTMLElement) => {
    const root = createRoot(element)
    root.render(<CliSettings context={context} />)
    return () => root.unmount()
  })
}
