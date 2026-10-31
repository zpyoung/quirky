import { useState } from 'react'
import type { AgentInfo, AgentListing, PermissionMode } from '../core/types'
import { Badge, Button, IconButton, ListRow } from '@quirky/ui'
import { Field } from './Field'
import { Segmented, Switch } from './controls'
import { MODE_LABEL, replacementMode, type AgentsStore } from './model'
import { s } from './styles'

const envText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')

/** Reads `KEY=VALUE` lines; a line without a name or `=` is refused with a message. */
function parseEnv(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator <= 0) return { error: `Invalid environment line; expected KEY=VALUE: ${line}` }
    env[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return { env }
}

const isCustom = (info: AgentInfo) =>
  info.permissions.mode === 'custom' || (info.permissions.mode === null && info.argsOverridden && info.args.trim() !== '')

function Permissions({ info, listing, store }: { info: AgentInfo; listing: AgentListing; store: AgentsStore }) {
  const { mode, hasAuto } = info.permissions
  if (mode === null) return null
  if (mode === 'custom') {
    const replacement = replacementMode(listing, hasAuto)
    return (
      <div style={s.inline}>
        <span>Permissions</span>
        <Badge>Custom arguments</Badge>
        <Button type="button" onClick={() => void store.setPermissions(replacement, info.id, true)}>
          Replace with {MODE_LABEL[replacement]}
        </Button>
      </div>
    )
  }
  const options = (['manual', 'auto', 'yolo'] as PermissionMode[])
    .filter((value) => value !== 'auto' || hasAuto)
    .map((value) => ({ value, label: MODE_LABEL[value] }))
  return (
    <div style={s.inline}>
      <span>Permissions</span>
      <Segmented
        value={mode}
        options={options}
        label={`${info.label} permissions`}
        onChange={(next) => next !== mode && void store.setPermissions(next, info.id)}
      />
    </div>
  )
}

function Details({ info, listing, store }: { info: AgentInfo; listing: AgentListing; store: AgentsStore }) {
  return (
    <div style={s.detail}>
      <Permissions info={info} listing={listing} store={store} />
      <Field
        label="Command"
        value={info.command}
        overridden={info.commandOverridden}
        onSave={(text) => store.configure(info.id, { command: text })}
        onReset={() => void store.configure(info.id, { reset: ['command'] })}
      />
      <Field
        label="Arguments"
        value={info.args}
        overridden={info.argsOverridden}
        onSave={(text) => store.configure(info.id, { args: text })}
        onReset={() => void store.configure(info.id, { reset: ['args'] })}
      />
      {info.showEnv && (
        <Field
          label="Environment"
          multiline
          value={envText(info.env)}
          overridden={info.envOverridden}
          onSave={async (text) => {
            const parsed = parseEnv(text)
            return 'error' in parsed ? parsed.error : store.configure(info.id, { env: parsed.env })
          }}
          onReset={() => void store.configure(info.id, { reset: ['env'] })}
        />
      )}
      <p style={s.sectionHint}>Override the binary path or name, and edit the default launch arguments or environment for this agent.</p>
    </div>
  )
}

/** One agent: its name and command, availability, default and docs controls, and, for an installed one, its editable settings. */
export function AgentRow({ info, listing, store }: { info: AgentInfo; listing: AgentListing; store: AgentsStore }) {
  const [open, setOpen] = useState(false)
  const link = info.homepage ?? info.install
  const subtitle = `${info.command} ${info.args}`.trim()
  const canDefault = info.installed && info.enabled

  return (
    <li data-agent={info.id}>
      <ListRow
        title={
          <span style={s.rowTitle}>
            <strong>{info.label}</strong>
            {!info.enabled && <Badge>Disabled</Badge>}
            {isCustom(info) && <Badge>Custom</Badge>}
          </span>
        }
        description={<code style={s.command}>{subtitle}</code>}
        trailing={
          <div style={s.rowActions}>
            <Switch checked={info.enabled} label="Enabled" ariaLabel={`Enabled: ${info.label}`} onChange={(enabled) => void store.setEnabled(info.id, enabled)} />
            {canDefault && (
              <Button
                type="button"
                variant={info.isDefault ? 'primary' : 'secondary'}
                aria-label={`${info.isDefault ? 'Default' : 'Set default'}: ${info.label}`}
                onClick={() => void store.setDefault(info.isDefault ? 'auto' : info.id)}
              >
                {info.isDefault ? 'Default' : 'Set default'}
              </Button>
            )}
            {link !== null && (
              <a style={s.link} href={link} target="_blank" rel="noreferrer" aria-label={`${info.installed ? 'Docs' : 'Install'}: ${info.label}`}>
                {info.installed ? 'Docs' : 'Install'}
              </a>
            )}
            {info.installed && (
              <IconButton
                label={open ? 'Collapse agent settings' : 'Expand agent settings'}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                {open ? '▴' : '▾'}
              </IconButton>
            )}
          </div>
        }
      />
      {open && info.installed && <Details info={info} listing={listing} store={store} />}
    </li>
  )
}
