import React from 'react'
import type { DropIndicator } from './drop-indicator'
import { resolveEditorTabGitStatus, type TabBarItem } from './tab-bar-item-model'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import TabBarItemRow from './TabBarItemRow'

export type TabBarItemSurfaceProps = Pick<
  TabBarProps,
  | 'worktreeId'
  | 'activeTabId'
  | 'activeFileId'
  | 'activeBrowserTabId'
  | 'activeSimulatorTabId'
  | 'activeTabType'
  | 'expandedPaneByTabId'
  | 'onCloseSplitPane'
>

export type TabBarItemSurfaceRuntime = Pick<
  TabBarRuntimeModel,
  | 'resolvedGroupId'
  | 'generatedTabTitlesEnabled'
  | 'managedBrowserCreationEnabled'
  | 'statusByRelativePath'
>

export function renderTabBarItems({
  items,
  props,
  runtime,
  actions,
  dropIndicatorByVisibleId,
  includeTopTabBorder,
  activeClientHostedBrowserRowId
}: {
  items: TabBarItem[]
  props: TabBarItemSurfaceProps
  runtime: TabBarItemSurfaceRuntime
  actions: TabBarItemActions
  dropIndicatorByVisibleId: Map<string, DropIndicator>
  includeTopTabBorder: boolean
  activeClientHostedBrowserRowId: string | null
}): React.ReactNode[] {
  const {
    worktreeId,
    activeTabId,
    activeFileId,
    activeBrowserTabId,
    activeSimulatorTabId,
    activeTabType,
    expandedPaneByTabId
  } = props
  const {
    resolvedGroupId,
    generatedTabTitlesEnabled,
    managedBrowserCreationEnabled,
    statusByRelativePath
  } = runtime

  // A selected client-hosted row covers the pane, so the tab it covers must stop looking active —
  // the group's own activeTabId never moves for it, and two underlines would show at once.
  const clientHostedRowOwnsActiveState = activeClientHostedBrowserRowId !== null

  function isActiveItem(item: TabBarItem): boolean {
    if (clientHostedRowOwnsActiveState) {
      return false
    }
    if (item.type === 'terminal') {
      return (
        (activeTabType === 'terminal' || activeTabType === 'simulator') && item.id === activeTabId
      )
    }
    if (item.type === 'browser') {
      return activeTabType === 'browser' && activeBrowserTabId === item.id
    }
    if (item.type === 'simulator') {
      return activeTabType === 'simulator' && item.id === activeSimulatorTabId
    }
    if (item.type === 'agent-session') {
      return activeTabType === 'agent-session' && item.id === activeTabId
    }
    return (activeTabType === 'editor' || activeTabType === 'simulator') && activeFileId === item.id
  }

  return items.map((item, index) => {
    return (
      <TabBarItemRow
        key={item.id}
        item={item}
        actions={actions}
        worktreeId={worktreeId}
        groupId={resolvedGroupId}
        generatedTabTitlesEnabled={generatedTabTitlesEnabled}
        tabCount={items.length}
        hasTabsToLeft={index > 0}
        hasTabsToRight={index < items.length - 1}
        isActive={isActiveItem(item)}
        isExpanded={item.type === 'terminal' && expandedPaneByTabId[item.id] === true}
        dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
        includeTopTabBorder={includeTopTabBorder}
        canDuplicate={item.type === 'browser' && managedBrowserCreationEnabled}
        canCloseSplitPane={props.onCloseSplitPane !== undefined}
        gitStatus={
          item.type === 'editor' ? resolveEditorTabGitStatus(item.data, statusByRelativePath) : null
        }
      />
    )
  })
}
