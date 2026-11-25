// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '../../store'
import {
  getRepositoryPaneSearchEntries,
  matchesRepositoryIdentitySearch,
  RepositoryPane
} from './RepositoryPane'
import { matchesSettingsSearch } from './settings-search'
import { TooltipProvider } from '../ui/tooltip'

let container: HTMLDivElement
let root: Root

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'Example Repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // WorktreeSymlinksSection reads window.api.fs on mount to suggest directory
  // paths; provide a minimal renderer bridge so mounting the full pane doesn't
  // throw in the test environment.
  ;(window as unknown as { api: unknown }).api = {
    fs: { readDir: () => Promise.resolve([]) }
  }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  delete (window as unknown as { api?: unknown }).api
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('RepositoryPane search entries', () => {
  it('keeps renamed hook sections reachable through settings search', () => {
    const entries = getRepositoryPaneSearchEntries(repo, { isLocalWindowsProject: true })

    expect(matchesSettingsSearch('setup script', entries)).toBe(true)
    expect(matchesSettingsSearch('archive script', entries)).toBe(true)
    expect(matchesSettingsSearch('setup command', entries)).toBe(true)
    expect(matchesSettingsSearch('archive command', entries)).toBe(true)
    expect(matchesSettingsSearch('advanced', entries)).toBe(true)
    expect(matchesSettingsSearch('runtime', entries)).toBe(true)
    expect(matchesSettingsSearch('wsl', entries)).toBe(true)
    expect(matchesSettingsSearch('windows host', entries)).toBe(true)
    expect(matchesSettingsSearch('command source', entries)).toBe(true)
    expect(matchesSettingsSearch('local settings scripts', entries)).toBe(true)
    expect(matchesSettingsSearch('../worktrees', entries)).toBe(true)
    expect(matchesSettingsSearch('worktree path', entries)).toBe(true)
  })

  it('includes each project search section once', () => {
    const entries = getRepositoryPaneSearchEntries(repo)

    expect(entries.filter(({ title }) => title === 'Project Icon')).toHaveLength(1)
    expect(entries.filter(({ title }) => title === 'Default Worktree Base')).toHaveLength(1)
  })

  it('omits project runtime search for remote or unsupported repos', () => {
    expect(matchesSettingsSearch('project runtime', getRepositoryPaneSearchEntries(repo))).toBe(
      false
    )
    expect(
      matchesSettingsSearch(
        'project runtime',
        getRepositoryPaneSearchEntries(
          {
            ...repo,
            connectionId: 'builder',
            executionHostId: 'ssh:builder'
          },
          { windowsRuntimeSupported: true }
        )
      )
    ).toBe(false)
  })

  it('matches project identity searches on display name and path only', () => {
    expect(matchesRepositoryIdentitySearch('example repo', repo)).toBe(true)
    expect(matchesRepositoryIdentitySearch('/tmp/repo', repo)).toBe(true)
    expect(matchesRepositoryIdentitySearch('setup script', repo)).toBe(false)
  })

  it('renders full hook controls when search matches the project name', () => {
    useAppStore.setState({
      settingsSearchQuery: 'Example Repo',
      settingsSearchInputQuery: 'Example Repo'
    })

    try {
      const html = renderToStaticMarkup(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(RepositoryPane, {
            repo,
            yamlHooks: null,
            hasHooksFile: false,
            hooksInspectionReady: true,
            mayNeedUpdate: false,
            updateRepo: vi.fn(),
            removeProject: vi.fn()
          })
        )
      )

      expect(html).toContain('Worktree Hooks')
      expect(html).toContain('Setup Script')
      expect(html).toContain('Archive Script')
      expect(html).toContain('Custom GitHub Issue Command')
    } finally {
      useAppStore.setState({
        settingsSearchQuery: '',
        settingsSearchInputQuery: ''
      })
    }
  })
})
