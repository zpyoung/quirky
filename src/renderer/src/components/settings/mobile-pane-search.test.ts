import { describe, expect, it } from 'vitest'

import { getMobilePaneSearchEntries } from './mobile-pane-search'
import { matchesSettingsSearch } from './settings-search'

describe('getMobilePaneSearchEntries', () => {
  // Why: the network entries were split into their own catalog and spliced back
  // in. Search ranking breaks ties by index, so a reorder silently reranks rows.
  it('keeps Network Interface in its original catalog position', () => {
    expect(getMobilePaneSearchEntries().map((entry) => entry.title)).toEqual([
      'Mobile Pairing',
      'Connected Devices',
      'Network Interface',
      'When you leave the mobile app',
      'Machine name'
    ])
  })

  it('keeps the shared machine-name entry searchable from the Mobile pane', () => {
    // Why: the entry is shared with Remote Servers; the Mobile pane only adds its own keyword.
    const entries = getMobilePaneSearchEntries()

    expect(matchesSettingsSearch('machine name', entries)).toBe(true)
    expect(matchesSettingsSearch('hostname', entries)).toBe(true)
  })
})
