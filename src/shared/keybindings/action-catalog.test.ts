import { describe, expect, it } from 'vitest'
import { ACTION_CATALOG, isCatalogedActionId } from './action-catalog'
import { KEYBINDING_DEFINITIONS } from './definitions'

const catalogEntries = Object.entries(ACTION_CATALOG)

describe('action catalog', () => {
  it('has an entry for every keybinding action, including the generated agent tabs', () => {
    const missing = KEYBINDING_DEFINITIONS.map((definition) => definition.id).filter(
      (id) => !isCatalogedActionId(id)
    )
    expect(missing).toEqual([])
    expect(
      KEYBINDING_DEFINITIONS.some((definition) => definition.id.startsWith('tab.newAgent.'))
    ).toBe(true)
  })

  it('has no entry for an action that does not exist', () => {
    const known = new Set<string>(KEYBINDING_DEFINITIONS.map((definition) => definition.id))
    expect(catalogEntries.map(([id]) => id).filter((id) => !known.has(id))).toEqual([])
  })

  it('says why each ui-only action has no rpc path and, where one exists, names the typed command', () => {
    const noTypedEquivalent = new Set(['app.forceReload', 'terminal.switchInputSource'])
    const uiOnly = catalogEntries.filter(([, entry]) => entry.dispatch === 'ui-only')
    expect(uiOnly.filter(([, entry]) => !entry.uiOnlyReason).map(([id]) => id)).toEqual([])
    expect(
      uiOnly
        .filter(([id]) => !noTypedEquivalent.has(id))
        .filter(([, entry]) => !entry.uiOnlyReason?.includes('quirky'))
        .map(([id]) => id)
    ).toEqual([])
  })

  it('gives every entry a one-line description', () => {
    const bad = catalogEntries.filter(
      ([, entry]) => entry.description.trim() === '' || entry.description.includes('\n')
    )
    expect(bad.map(([id]) => id)).toEqual([])
  })

  it('marks only deleting actions destructive, and workspace.delete takes a workspace', () => {
    const destructive = Object.fromEntries(
      catalogEntries
        .filter(([, entry]) => entry.destructive !== undefined)
        .map(([id, entry]) => [id, entry.destructive?.category])
    )
    expect(destructive).toEqual({
      'workspace.delete': 'workspace-delete',
      'fileExplorer.delete': 'file-overwrite-delete'
    })
    expect(ACTION_CATALOG['workspace.delete'].takesWorkspace).toBe(true)
    expect(ACTION_CATALOG['tab.closeAll'].destructive).toBeUndefined()
  })
})
