// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../../shared/native-chat-session-options'
import { SettingsChip } from './SettingsChip'
import type { ComposerSettings } from './composer-types'

const select = (
  id: string,
  label: string,
  currentValue: string,
  values: string[],
  settable = true
): SessionOptionDescriptor => ({
  id,
  label,
  kind: {
    type: 'select',
    currentValue,
    choices: values.map((value) => ({ value, label: value }))
  },
  valueSource: 'applied',
  transport: 'agent-session',
  settable
})

function settingsOf(snapshot: SessionOptionDescriptor[]): ComposerSettings {
  return {
    surface: {
      getSnapshot: () => snapshot,
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    setOption: vi.fn().mockResolvedValue(true)
  }
}

const SNAPSHOT = [
  select('permissionMode', 'Permissions', 'ask', ['ask', 'accept-edits', 'plan']),
  select('model', 'Model', 'opus', ['opus', 'sonnet']),
  select('effort', 'Effort', 'high', ['low', 'high'], false)
]

function renderChip(planModeAvailable: boolean, onTogglePlan = vi.fn()) {
  const settings = settingsOf(SNAPSHOT)
  render(
    <SettingsChip
      settings={settings}
      planModeAvailable={planModeAvailable}
      open
      onOpenChange={() => {}}
      section={null}
      onTogglePlan={onTogglePlan}
    />
  )
  return { settings, onTogglePlan }
}

afterEach(cleanup)

describe('SettingsChip', () => {
  it('lists model, effort and permission mode and sets a pick through the controller', () => {
    const { settings } = renderChip(false)
    expect(screen.getByRole('radiogroup', { name: 'Model' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Effort' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'sonnet' }))
    expect(settings.setOption).toHaveBeenCalledWith('model', 'sonnet')
  })

  it('leaves a control the session cannot change disabled', () => {
    renderChip(false)
    expect(screen.getByRole('radio', { name: 'low' })).toBeDisabled()
  })

  it('offers no plan mode where the agent has none', () => {
    renderChip(false)
    expect(screen.queryByRole('switch', { name: /Plan mode/ })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'plan' })).toBeNull()
  })

  it('offers a plan mode switch where the agent supports it', () => {
    const { onTogglePlan } = renderChip(true)
    fireEvent.click(screen.getByRole('switch', { name: /Plan mode/ }))
    expect(onTogglePlan).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('radio', { name: 'plan' })).toBeNull()
  })

  it('re-renders when the option surface changes', () => {
    let snapshot = [select('model', 'Model', 'opus', ['opus', 'sonnet'])]
    const listeners = new Set<(next: SessionOptionDescriptor[]) => void>()
    const settings: ComposerSettings = {
      surface: {
        getSnapshot: () => snapshot,
        setOption: vi.fn(),
        invokeAction: vi.fn(),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      },
      setOption: vi.fn().mockResolvedValue(true)
    }
    render(
      <SettingsChip
        settings={settings}
        planModeAvailable={false}
        open
        onOpenChange={() => {}}
        section={null}
        onTogglePlan={() => {}}
      />
    )
    expect(screen.getByRole('radio', { name: 'opus' }).getAttribute('aria-checked')).toBe('true')
    act(() => {
      snapshot = [select('model', 'Model', 'sonnet', ['opus', 'sonnet'])]
      listeners.forEach((listener) => listener(snapshot))
    })
    expect(screen.getByRole('radio', { name: 'sonnet' }).getAttribute('aria-checked')).toBe('true')
  })
})
