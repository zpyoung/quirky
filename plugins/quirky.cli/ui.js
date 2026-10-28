const SETTINGS_VIEW = 'view:quirky.cli/settings'

function node(tag, text, className) {
  const value = document.createElement(tag)
  if (text !== undefined) value.textContent = text
  if (className) value.className = className
  return value
}

function button(label, handler) {
  const value = node('button', label)
  value.type = 'button'
  value.addEventListener('click', handler)
  return value
}

function field(label, type = 'text') {
  const wrapper = node('label', undefined, 'quirky-cli-field')
  wrapper.append(node('span', label))
  const input = node('input')
  input.type = type
  wrapper.append(input)
  return { wrapper, input }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

export function activate(context) {
  context.provide(SETTINGS_VIEW, (element) => {
    const root = node('section', undefined, 'quirky-cli-settings')
    const statusArea = node('div', 'Loading CLI and runtime profile status…', 'muted')
    const profiles = node('div')
    const runtimes = node('div')
    const notice = node('p', '', 'muted')
    const commandButtons = node('div', undefined, 'quirky-cli-actions')
    const runtimeForm = node('form', undefined, 'quirky-cli-form')
    const runtimeName = field('Runtime name')
    const pairingCode = field('Pairing offer', 'password')
    const profileForm = node('form', undefined, 'quirky-cli-form')
    const profileName = field('Profile launcher name')
    const profileHome = field('Profile QUIRKY_HOME')
    const profilePath = field('Launcher path (optional)')
    let disposed = false
    let currentStatus = null
    let currentTarget = null

    root.append(
      node('h2', 'External CLI command'), statusArea, commandButtons,
      node('h2', 'Profile launchers'), profileForm, profiles,
      node('h2', 'Saved paired runtimes'), runtimeForm, runtimes, notice
    )
    element.append(root)

    async function runAction(action) {
      notice.textContent = ''
      try {
        await action()
        await refresh()
      } catch (error) {
        if (!disposed) notice.textContent = errorText(error)
      }
    }

    async function refresh() {
      const [statusResult, targetResult, profilesResult, runtimesResult] = await Promise.all([
        context.call('quirky.cli/commandStatus', {}),
        context.call('quirky.cli/commandTarget', {}),
        context.call('quirky.cli/profileLauncherList', {}),
        context.call('quirky.cli/runtimeList', {})
      ])
      if (disposed) return
      currentStatus = statusResult
      currentTarget = targetResult
      const status = statusResult
      const target = targetResult
      statusArea.replaceChildren(
        node('p', `Status: ${status.state}`),
        node('p', `Path: ${status.path}`),
        node('p', `Target: ${status.target ?? 'none'}`),
        node('p', `Profile: ${status.profileHome}`),
        node('p', target.available ? `Install target: ${target.entrypointPath}` : 'No verified CLI entrypoint is available in this desktop host; install from the CLI invocation that supplies its real target.')
      )
      commandButtons.replaceChildren()
      const install = button(status.state === 'managed' ? 'Update managed command' : 'Install command', () => runAction(async () => {
        if (!target.available) throw new Error('no verified CLI executable and entrypoint are available')
        let replaceForeign = false
        if (status.state === 'foreign') {
          replaceForeign = await context.confirm({
            title: 'Replace foreign command?',
            body: `Replace the foreign launcher at ${status.path}?`
          })
          if (!replaceForeign) return
        }
        await context.call('quirky.cli/commandInstall', {
          path: status.path,
          profileHome: status.profileHome,
          executablePath: target.executablePath,
          entrypointPath: target.entrypointPath,
          replaceForeign
        })
      }))
      install.disabled = !target.available
      commandButtons.append(install)
      if (status.state === 'managed') {
        commandButtons.append(button('Reveal command', () => runAction(() => context.call('quirky.cli/commandReveal', {}))))
        commandButtons.append(button('Uninstall command', () => runAction(() => context.call('quirky.cli/commandUninstall', { path: status.path }))))
      }

      profiles.replaceChildren()
      for (const entry of profilesResult.launchers) {
        profiles.append(node('p', `${entry.name}: ${entry.state} · ${entry.path} · QUIRKY_HOME=${entry.profileHome}`))
        if (entry.state === 'managed') {
          profiles.append(button(`Remove ${entry.name}`, () => runAction(() => context.call('quirky.cli/profileLauncherRemove', { path: entry.path }))))
        }
      }
      profileHome.input.value ||= status.profileHome

      runtimes.replaceChildren()
      for (const runtime of runtimesResult.runtimes) {
        const row = node('p', `${runtime.name} · ${runtime.id} · ${runtime.endpoint} · paired device ${runtime.pairedDeviceId}`)
        row.append(button(`Remove ${runtime.name}`, () => runAction(() => context.call('quirky.cli/runtimeRemove', { selector: runtime.id }))))
        runtimes.append(row)
      }
    }

    profileForm.append(profileName.wrapper, profileHome.wrapper, profilePath.wrapper)
    const chooseHome = button('Choose profile folder', () => runAction(async () => {
      const result = await context.call('desktop.folder.pick', {
        title: 'Choose profile QUIRKY_HOME',
        ...(profileHome.input.value ? { startingFolder: profileHome.input.value } : {}),
        multiple: false
      })
      if (!result.cancelled && result.paths.length === 1) profileHome.input.value = result.paths[0]
    }))
    profileForm.append(chooseHome)
    profileForm.append(button('Create profile launcher', () => runAction(async () => {
      if (!currentTarget?.available) throw new Error('no verified CLI executable and entrypoint are available')
      if (!profileName.input.value.trim() || !profileHome.input.value.trim()) throw new Error('profile name and QUIRKY_HOME are required')
      await context.call('quirky.cli/profileLauncherInstall', {
        name: profileName.input.value,
        profileHome: profileHome.input.value,
        ...(profilePath.input.value ? { path: profilePath.input.value } : {}),
        executablePath: currentTarget.executablePath,
        entrypointPath: currentTarget.entrypointPath
      })
      profileName.input.value = ''
      profilePath.input.value = ''
    })))
    runtimeForm.append(runtimeName.wrapper, pairingCode.wrapper)
    const addRuntime = button('Save paired runtime', () => runAction(async () => {
      if (!runtimeName.input.value.trim() || !pairingCode.input.value.trim()) throw new Error('runtime name and pairing offer are required')
      await context.call('quirky.cli/runtimeAdd', { name: runtimeName.input.value, pairingCode: pairingCode.input.value })
      pairingCode.input.value = ''
      runtimeName.input.value = ''
    }))
    runtimeForm.append(addRuntime)
    runtimeForm.addEventListener('submit', (event) => event.preventDefault())
    profileForm.addEventListener('submit', (event) => event.preventDefault())
    void refresh().catch((error) => { if (!disposed) notice.textContent = errorText(error) })
    return () => {
      disposed = true
      root.remove()
    }
  })
}
