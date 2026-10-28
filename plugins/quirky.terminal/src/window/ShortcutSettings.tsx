import { useEffect, useRef, useState } from 'react'
import { Button, EmptyState, FormRow, ToolPanelFrame } from '@quirky/ui'
import type { UiKeybinding, UiModel, UiPluginContext } from '@quirky/protocol'

/** Edits the same daemon-owned binding overrides the public keybinding API exposes. */
export function ShortcutSettings({ context, report }: { context: UiPluginContext; report?(state: unknown): void }) {
  const [bindings, setBindings] = useState<UiKeybinding[]>([])
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const epoch = useRef(0)

  const mounted = useRef(false)
  const mutating = useRef(false)
  useEffect(() => {
    let active = true
    mounted.current = true
    const refresh = async () => {
      const attempt = ++epoch.current
      try {
        const model = await context.call('ui.contributions', {}) as UiModel
        if (!active || attempt !== epoch.current) return
        setBindings(model.keybindings.filter((binding) => binding.plugin === 'quirky.terminal'))
        setTitles(Object.fromEntries(model.commands.map((command) => [command.id, command.title])))
        setError(null)
      } catch (reason) {
        if (active && attempt === epoch.current) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (active && attempt === epoch.current) setLoading(false)
      }
    }
    void refresh()
    const stop = context.subscribe((event) => {
      if (event.type === 'ui.keybindings.changed' || event.type === 'plugin.changed') void refresh()
    })
    return () => { active = false; mounted.current = false; epoch.current++; stop() }
  }, [context])
  useEffect(() => { report?.({ bindings, loading, pending, error }) }, [report, bindings, loading, pending, error])

  const mutate = async (binding: UiKeybinding, action: 'save' | 'disable' | 'reset') => {
    if (mutating.current) return
    mutating.current = true
    epoch.current++
    setPending(binding.id)
    setError(null)
    try {
      const rows = await context.call(action === 'reset' ? 'keybinding.reset' : 'keybinding.set', {
        id: binding.id,
        ...(action === 'reset' ? {} : { key: action === 'disable' ? null : drafts[binding.id] ?? binding.key })
      }) as UiKeybinding[]
      if (!mounted.current) return
      setBindings(rows.filter((row) => row.plugin === 'quirky.terminal'))
      setDrafts((current) => { const next = { ...current }; delete next[binding.id]; return next })
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      mutating.current = false
      if (mounted.current) setPending(null)
    }
  }
  return (
    <section className="tt-tool-panel-fill tt-shortcut-settings">
      <ToolPanelFrame title="Terminal Shortcuts">
        <p className="ui-text-muted">Remap terminal shortcuts for this profile. Context conditions and Terminal-first policy remain in effect. Reset restores the current plugin or distro default.</p>
        {loading ? <p className="ui-text-muted" role="status">Loading shortcuts…</p> : null}
        {error ? <div className="ui-error-text" role="alert">{error}</div> : null}
        {!loading && bindings.length === 0 ? <EmptyState message="No terminal shortcuts are available." /> : null}
        <div className="tt-shortcut-list">
          {bindings.map((binding) => {
            const inputId = `terminal-shortcut-${binding.id}`
            return (
              <div key={binding.id} className="tt-shortcut-row">
                <FormRow label={titles[binding.command] ?? binding.command} htmlFor={inputId}>
                  <input
                    id={inputId}
                    aria-label={`Shortcut for ${binding.id}`}
                    className="ui-text-field__input"
                    value={drafts[binding.id] ?? (binding.status === 'unbound' ? '' : binding.key)}
                    onChange={(event) => setDrafts((current) => ({ ...current, [binding.id]: event.target.value }))}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void mutate(binding, 'save') } }}
                    placeholder="mod+shift+k"
                    disabled={pending !== null}
                  />
                </FormRow>
                <small className="tt-shortcut-status">{binding.status}{binding.shadowedBy ? ` · ${binding.shadowedBy}` : ''}</small>
                <div className="ui-cluster">
                  <Button disabled={pending !== null} onClick={() => void mutate(binding, 'save')}>Save</Button>
                  <Button disabled={pending !== null} onClick={() => void mutate(binding, 'disable')}>Disable</Button>
                  <Button disabled={pending !== null} onClick={() => void mutate(binding, 'reset')}>Reset</Button>
                </div>
              </div>
            )
          })}
        </div>
      </ToolPanelFrame>
    </section>
  )
}
