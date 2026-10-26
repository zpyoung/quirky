import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import manifest from '../../quirky-plugin.json'
import { BUILT_IN_AGENT_IDS } from '../../src/window/agentTabs'

const AGENTS = manifest.contributes.agent
const COMMANDS = manifest.contributes.command

describe('the Agents UI declarations', () => {
  test('the manifest points at the built module and declares the Agents view', () => {
    expect(manifest.ui).toBe('dist/ui.js')
    expect(manifest.contributes.view).toEqual([{ id: 'settings', title: 'Agents' }])
  })

  test('SC-43: there is one "New <Label> tab" command for each of the 45 agents, in catalog order', () => {
    expect(AGENTS.length).toBe(45)
    const perAgent = COMMANDS.filter((command) => /^new-.+-tab$/.test(command.id) && command.id !== 'new-agent-tab')
    expect(perAgent.map((command) => command.id)).toEqual(AGENTS.map((agent) => `new-${agent.id}-tab`))
    expect(perAgent.map((command) => command.title)).toEqual(AGENTS.map((agent) => `New ${agent.label} tab`))
    expect(COMMANDS.find((command) => command.id === 'new-aider-tab')!.title).toBe('New Aider tab')
    expect(COMMANDS.find((command) => command.id === 'new-claude-tab')!.title).toBe('New Claude tab')
  })

  test('the settings command and the default-agent command are declared with their titles', () => {
    expect(COMMANDS.find((command) => command.id === 'open-settings')!.title).toBe('Open agent settings')
    expect(COMMANDS.find((command) => command.id === 'new-agent-tab')!.title).toBe('New agent tab (default agent)')
    expect(COMMANDS.length).toBe(47)
  })

  test('SC-43: Cmd+Option+T is bound to the default-agent command and no agent command has a chord', () => {
    expect(manifest.contributes.keybinding).toEqual([{ id: 'new-agent-tab', key: 'mod+alt+t', command: 'new-agent-tab' }])
  })

  test('the module provides a command for exactly the agents the manifest lists', () => {
    expect([...BUILT_IN_AGENT_IDS]).toEqual(AGENTS.map((agent) => agent.id))
  })
})

describe('the Agents module build', () => {
  test('bundles for the browser with React left to the window', async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, '..', '..', 'src', 'ui.tsx')],
      target: 'browser',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    expect(result.logs.filter((log) => log.level === 'error')).toEqual([])
    expect(result.success).toBe(true)
    const code = await result.outputs[0]!.text()
    expect(code).toContain('react-dom/client')
    expect(code).toMatch(/export\s*\{[^}]*activate/)
  })

  test('the bundle does not carry the manifest', async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, '..', '..', 'src', 'ui.tsx')],
      target: 'browser',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    expect(await result.outputs[0]!.text()).not.toContain('detectAliases')
  })
})
