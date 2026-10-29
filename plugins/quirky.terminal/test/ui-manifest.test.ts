import { describe, expect, test } from 'bun:test'
import { checkUiKindEntry } from '../../../packages/daemon/src/plugins/ui-kinds'
import { parseChord } from '@quirky/protocol'
import manifest from '../quirky-plugin.json'
import sessionManifest from '../../quirky.session/quirky-plugin.json'

type Binding = { id: string; key: string; command: string; when?: string }
type Command = { id: string; title: string; args?: { properties?: Record<string, unknown>; required?: string[] } }

const bindings = manifest.contributes.keybinding as Binding[]
const commands = manifest.contributes.command as Command[]
const T = 'terminalFocus'

describe('the manifest overrides', () => {
  test('SC-70: the session view and tab commands are overridden', () => {
    const ids = (manifest as { overrides?: { id: string }[] }).overrides?.map((entry) => entry.id)
    expect(ids).toEqual([
      'view:quirky.session/worktree',
      'command:quirky.session/new-shell',
      'command:quirky.session/close-session',
      'command:quirky.session/select-tab',
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `command:quirky.session/select-tab-${n}`)
    ])
  })

  test('the select-tab override redeclares the session args schema exactly', () => {
    const own = (manifest as { overrides: { id: string; args?: unknown }[] }).overrides.find((entry) => entry.id === 'command:quirky.session/select-tab')
    const theirs = sessionManifest.contributes.command.find((entry) => entry.id === 'select-tab')
    expect(own?.args).toEqual(theirs?.args)
  })

  test('every override is a valid contribution of its kind and keeps the session titles for the tab digits', () => {
    for (const entry of (manifest as { overrides: ({ id: string } & Record<string, unknown>)[] }).overrides) {
      const [, kind] = /^([a-z-]+):/.exec(entry.id)!
      const errors: string[] = []
      checkUiKindEntry(kind!, entry.id, entry, errors)
      expect(errors).toEqual([])
      expect(typeof entry.title).toBe('string')
    }
    const overrides = (manifest as { overrides: { id: string; title: string }[] }).overrides
    for (let n = 1; n <= 9; n += 1) {
      expect(overrides.find((entry) => entry.id === `command:quirky.session/select-tab-${n}`)?.title).toBe(`Select tab ${n}`)
    }
    expect(overrides.find((entry) => entry.id === 'view:quirky.session/worktree')?.title).toBe('Worktree')
  })

  test('declares the Quick Commands panel and the floating overlay', () => {
    expect(manifest.contributes.panel).toEqual([
      { id: 'sessions', title: 'Terminal Sessions' },
      { id: 'quick-commands', title: 'Quick Commands' }
    ])
    expect((manifest.contributes as { overlay?: unknown }).overlay).toEqual([{ id: 'floating', title: 'Floating Workspace' }])
  })
})

describe('the commands and keybindings', () => {

  test('every chord and `when` pair is used once, so no binding of this plugin shadows another', () => {
    const seen = bindings.map((binding) => `${binding.key}\0${binding.when ?? ''}`)
    expect(new Set(seen).size).toBe(seen.length)
    expect(new Set(bindings.map((binding) => binding.id)).size).toBe(bindings.length)
  })


  test('every key is written as its canonical chord and points at a command this plugin declares or overrides', () => {
    const own = new Set(commands.map((command) => command.id))
    const overridden = new Set((manifest as { overrides: { id: string }[] }).overrides.map((entry) => entry.id))
    for (const binding of bindings) {
      const parsed = parseChord(binding.key)
      expect(parsed.ok && parsed.chord).toBe(binding.key)
      expect(own.has(binding.command) || overridden.has(binding.command)).toBe(true)
    }
  })

  test('every command and key passes the kernel checks', () => {
    for (const command of commands) {
      const errors: string[] = []
      checkUiKindEntry('command', command.id, command, errors)
      expect(errors).toEqual([])
      expect(command.title.length).toBeGreaterThan(0)
    }
    for (const binding of bindings) {
      const errors: string[] = []
      checkUiKindEntry('keybinding', binding.id, binding, errors)
      expect(errors).toEqual([])
    }
  })

  test('window-only commands declare the args the tech spec lists', () => {
    const props = (id: string) => Object.keys(commands.find((command) => command.id === id)?.args?.properties ?? {}).sort()
    expect(props('search')).toEqual(['caseSensitive', 'query', 'regex'])
    for (const id of ['zoom-in', 'zoom-out', 'zoom-reset', 'copy', 'select-all']) expect(props(id)).toContain('pane')
    expect(props('paste')).toEqual(['pane', 'text'])
    expect(props('open-menu')).toEqual(['kind', 'target'])
    expect(commands.find((command) => command.id === 'open-menu')?.args?.required).toEqual(['kind'])
  })


  test('mod+w keeps two groups: the session close-session without a condition and close-pane under terminalFocus', () => {
    const closeKeys = bindings.filter((binding) => binding.key === 'mod+w')
    expect(closeKeys).toEqual([expect.objectContaining({ command: 'close-pane', when: T })])
    const sessionKeys = sessionManifest.contributes.keybinding.filter((binding) => binding.key === 'mod+w')
    expect(sessionKeys.map((binding) => (binding as { when?: string }).when)).toEqual([undefined])
  })
})

describe('the manifest follow-ups', () => {
  test('clearPane and resetPane take a revision and answer with the workspace', () => {
    for (const id of ['clearPane', 'resetPane']) {
      const method = manifest.contributes.method.find((entry) => entry.id === id) as unknown as {
        params: { properties: Record<string, { type?: string }> }
        result: { properties: Record<string, unknown>; required: string[] }
      }
      expect(method.params.properties.revision?.type).toBe('integer')
      expect(Object.keys(method.result.properties)).toEqual(['workspace'])
      expect(method.result.required).toEqual(['workspace'])
    }
  })
})
