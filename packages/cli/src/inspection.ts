import type { DistroInspection, PluginInspection } from '@quirky/protocol'

const singleLine = (text: string) => text.replace(/\r\n|\r|\n/g, '\\n')

function aligned(rows: [label: string, text: string][]): string[] {
  const width = Math.max(0, ...rows.map(([label]) => label.length))
  return rows.map(([label, text]) => `${label.padEnd(width)} ${singleLine(text)}`)
}

function scalar(value: unknown): string {
  if (value === undefined || value === null) return '-'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * The install screen for one plugin: its ID, version and name, then one line per contribution,
 * override and disable. A reinstall shows `old → new` and `+`/`-` lines for what changed.
 */
export function renderPluginInspection(inspection: PluginInspection): string {
  const { id, name, version, installed } = inspection
  const header = installed ? `${id} ${installed.version} → ${version} (${name})` : `${id} ${version} (${name})`
  const rows: [string, string][] = [
    ...inspection.contributions.map(({ kind, id: contribution, data }): [string, string] => {
      const key = kind === 'keybinding' && typeof data.key === 'string' ? `  ${data.key}` : ''
      return [kind, `${contribution}${key}`]
    }),
    ...inspection.overrides.map((override): [string, string] => ['override', `${override.id} (replaces ${override.replaces}'s)`]),
    ...inspection.disables.map((disabled): [string, string] => ['disable', disabled])
  ]
  const changes = [
    ...(installed?.added ?? []).map((added) => `+ ${added}`),
    ...(installed?.removed ?? []).map((removed) => `- ${removed}`)
  ]
  return [header, ...aligned(rows), ...changes].join('\n')
}

/** The install screen for a distro: its plugins' screens, then what it turns off and changes. */
export function renderDistroInspection(inspection: DistroInspection): string {
  const { manifest } = inspection
  const rows: [string, string][] = [
    ...(manifest.disable ?? []).map((id): [string, string] => ['disable', id]),
    ...inspection.settings.map((setting): [string, string] => [
      'setting',
      `${setting.id}  ${scalar(setting.current)} → ${scalar(setting.next)}`
    ]),
    ...(manifest.theme ? [['theme', manifest.theme] as [string, string]] : []),
    ...Object.entries(manifest.keybindings ?? {}).map(([chord, command]): [string, string] => [
      'keybinding',
      `${chord}  ${command}`
    ])
  ]
  const sections = [
    `${manifest.id} ${manifest.version} (${manifest.name})`,
    ...inspection.plugins.map(renderPluginInspection),
    ...(rows.length ? [aligned(rows).join('\n')] : [])
  ]
  return sections.join('\n\n')
}
