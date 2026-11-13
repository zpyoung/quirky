import { createRoot } from 'react-dom/client'
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Badge, Button, EmptyState, InlineError, ListRow, NoticeLine, SectionHeader, TextField } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { InstalledCommandStatus, ProfileLauncherStatus } from '@quirky/protocol/node'
import { CliSettingsModel } from './settings-model'

const SETTINGS_VIEW = 'view:quirky.cli/settings'

function statusTone(state: InstalledCommandStatus['state'] | ProfileLauncherStatus['state']): 'neutral' | 'needs-you' {
  if (state === 'foreign') return 'needs-you'
  return 'neutral'
}

function statusDot(state: InstalledCommandStatus['state'] | ProfileLauncherStatus['state']): 'idle' | 'done' | 'needs-you' {
  if (state === 'managed') return 'done'
  if (state === 'foreign') return 'needs-you'
  return 'idle'
}

function CliSettings({ model }: { model: CliSettingsModel }) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
  const [profileName, setProfileName] = useState('')
  const [profileHome, setProfileHome] = useState('')
  const [profilePath, setProfilePath] = useState('')
  const [runtimeName, setRuntimeName] = useState('')
  const [pairingOffer, setPairingOffer] = useState('')
  const profileHomeFromStatus = snapshot.status?.profileHome
  const status = snapshot.status
  const target = snapshot.target
  const launchers = snapshot.launchers
  const runtimes = snapshot.runtimes
  const actionsDisabled = snapshot.phase === 'loading' || snapshot.refreshing || snapshot.busy
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
    : null

  useEffect(() => {
    if (profileHomeFromStatus === undefined) return
    setProfileHome((current) => current || profileHomeFromStatus)
  }, [profileHomeFromStatus])

  const refresh = () => {
    void model.refresh()
  }
  const installCommand = () => {
    void model.installCommand()
  }
  const revealCommand = () => {
    void model.revealCommand()
  }
  const uninstallCommand = () => {
    void model.uninstallCommand()
  }
  const chooseProfileHome = async () => {
    const selected = await model.pickProfileHome(profileHome)
    if (selected !== null) setProfileHome(selected)
  }
  const submitProfileLauncher = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const created = await model.createProfileLauncher({ name: profileName, profileHome, path: profilePath })
    if (!created) return
    setProfileName('')
    setProfilePath('')
  }
  const submitRuntime = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const saved = await model.saveRuntime({ name: runtimeName, pairingOffer })
    if (!saved) return
    setPairingOffer('')
    setRuntimeName('')
  }

  return (
    <section className="ui-stack" aria-label="CLI and Runtime Profiles">
      <section className="ui-stack" aria-label="External CLI command">
        <SectionHeader title="External CLI command" />
        {snapshot.phase === 'loading' && <NoticeLine>Loading CLI and runtime profile status…</NoticeLine>}
        {status && <pre className="ui-readout" aria-label="External CLI command status">{statusReadout}</pre>}
        <div className="ui-cluster">
          <Button
            variant="primary"
            disabled={actionsDisabled || !status || !target?.available}
            onClick={installCommand}
          >
            {status?.state === 'managed' ? 'Update managed command' : 'Install command'}
          </Button>
          {status?.state === 'managed' && (
            <>
              <Button disabled={actionsDisabled} onClick={revealCommand}>Reveal command</Button>
              <Button variant="destructive" disabled={actionsDisabled} onClick={uninstallCommand}>Uninstall command</Button>
            </>
          )}
        </div>
      </section>

      <section className="ui-stack" aria-label="Profile launchers">
        <SectionHeader title="Profile launchers" />
        <form className="ui-stack" onSubmit={submitProfileLauncher}>
          <TextField label="Profile launcher name" value={profileName} onChange={(event) => setProfileName(event.currentTarget.value)} />
          <TextField label="Profile QUIRKY_HOME" value={profileHome} onChange={(event) => setProfileHome(event.currentTarget.value)} />
          <TextField label="Launcher path (optional)" value={profilePath} onChange={(event) => setProfilePath(event.currentTarget.value)} />
          <div className="ui-cluster">
            <Button type="button" disabled={actionsDisabled} onClick={chooseProfileHome}>Choose profile folder</Button>
            <Button type="submit" variant="primary" disabled={actionsDisabled}>Create profile launcher</Button>
          </div>
        </form>
        {launchers === null ? null : launchers.length === 0 ? <EmptyState message="No profile launchers are installed." /> : (
          <div className="ui-stack">
            {launchers.map((launcher) => {
              const removeProfileLauncher = () => {
                void model.removeProfileLauncher(launcher.path)
              }
              return (
                <ListRow
                  key={launcher.path}
                  title={launcher.name}
                  description={<span className="ui-stack">{`Path: ${launcher.path}`}<span>{`QUIRKY_HOME: ${launcher.profileHome}`}</span></span>}
                  status={statusDot(launcher.state)}
                  trailing={(
                    <div className="ui-cluster">
                      <Badge tone={statusTone(launcher.state)}>{launcher.state}</Badge>
                      {launcher.state === 'managed' && (
                        <Button variant="destructive" disabled={actionsDisabled} onClick={removeProfileLauncher}>Remove {launcher.name}</Button>
                      )}
                    </div>
                  )}
                />
              )
            })}
          </div>
        )}
      </section>

      <section className="ui-stack" aria-label="Saved paired runtimes">
        <SectionHeader title="Saved paired runtimes" />
        <form className="ui-stack" onSubmit={submitRuntime}>
          <TextField label="Runtime name" value={runtimeName} onChange={(event) => setRuntimeName(event.currentTarget.value)} />
          <TextField label="Pairing offer" type="password" autoComplete="off" value={pairingOffer} onChange={(event) => setPairingOffer(event.currentTarget.value)} />
          <div className="ui-cluster">
            <Button type="submit" variant="primary" disabled={actionsDisabled}>Save paired runtime</Button>
          </div>
        </form>
        {runtimes === null ? null : runtimes.length === 0 ? <EmptyState message="No paired runtimes are saved." /> : (
          <div className="ui-stack">
            {runtimes.map((runtime) => {
              const removeRuntime = () => {
                void model.removeRuntime(runtime.id)
              }
              return (
                <ListRow
                  key={runtime.id}
                  title={runtime.name}
                  description={<span className="ui-stack">{`ID: ${runtime.id}`}<span>{`Endpoint: ${runtime.endpoint}`}</span><span>{`Paired device: ${runtime.pairedDeviceId}`}</span></span>}
                  status="done"
                  trailing={(
                    <div className="ui-cluster">
                      <Badge tone="neutral">Saved</Badge>
                      <Button variant="destructive" disabled={actionsDisabled} onClick={removeRuntime}>Remove {runtime.name}</Button>
                    </div>
                  )}
                />
              )
            })}
          </div>
        )}
      </section>

      <div aria-live="polite">
        {snapshot.phase === 'ready' && snapshot.refreshing && <NoticeLine>Refreshing CLI and runtime status…</NoticeLine>}
      </div>
      {snapshot.loadError !== null && (
        <InlineError
          message={`Could not load CLI status: ${snapshot.loadError}`}
          action={{ label: 'Retry status', onAction: refresh }}
        />
      )}
      {snapshot.actionError !== null && <InlineError message={snapshot.actionError} />}
    </section>
  )
}

export function activate(context: UiPluginContext): void {
  context.provide(SETTINGS_VIEW, (element: HTMLElement) => {
    const model = new CliSettingsModel(context)
    const root = createRoot(element)
    root.render(<CliSettings model={model} />)
    void model.refresh()
    return () => {
      model.dispose()
      root.unmount()
    }
  })
}
