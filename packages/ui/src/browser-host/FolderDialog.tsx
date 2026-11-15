import { useSyncExternalStore } from 'react'
import { Button, Checkbox, Dialog, EmptyState, InlineError, ListRow, NoticeLine, StatusDot, TextField, uiTokens } from '../design-system'
import type { BrowserHostController } from '../browser-host'

const subscribeEmpty = () => () => {}
const noPrompt = () => null
const stackStyle = { display: 'grid', gap: 'var(--ui-space-12)' } as const
const controlsStyle = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-8)' } as const

export function FolderDialog({ controller }: { controller: BrowserHostController | null }) {
  const prompt = useSyncExternalStore(
    controller?.subscribe ?? subscribeEmpty,
    controller?.getSnapshot ?? noPrompt,
    controller?.getSnapshot ?? noPrompt
  )
  if (!controller || !prompt) return null

  const send = (
    action: 'set-path' | 'navigate' | 'select' | 'confirm' | 'cancel' | 'open-popup',
    fields: { path?: string; selected?: boolean; offset?: number } = {}
  ) => controller.controlCurrent(prompt.requestId, action, fields).catch(() => undefined)
  const cancel = () => { void send('cancel') }

  if (prompt.kind === 'window-open') {
    return (
      <Dialog
        open
        title="Open tab"
        onClose={cancel}
        actions={
          <div style={controlsStyle}>
            <Button onClick={cancel}>Cancel</Button>
            <Button variant="primary" disabled={prompt.busy} onClick={() => { void send('open-popup') }}>Open tab</Button>
          </div>
        }
      >
        <div style={stackStyle}>
          <p>The browser blocked the new tab. Retry here to open the requested view in a separate tab.</p>
          {prompt.error && <InlineError message={prompt.error} />}
          <NoticeLine>Quirky will not change this tab's view while the new tab is opening.</NoticeLine>
        </div>
      </Dialog>
    )
  }

  const selectedPaths = prompt.selectedPaths ?? []
  const directory = prompt.directory
  const path = prompt.draftPath ?? ''
  const directoryReady = directory !== undefined && directory.path === path && !prompt.error
  const navigate = (nextPath: string, offset = 0) => send('navigate', { path: nextPath, offset })
  const retry = () => {
    void controller.retryDirectory(prompt.requestId).catch(() => undefined)
  }
  const selected = (candidate: string) => selectedPaths.includes(candidate)
  const pageOffset = directory?.offset ?? 0
  const pageLimit = directory?.limit ?? 100

  return (
    <Dialog
      open
      title={prompt.title || 'Choose folder'}
      onClose={cancel}
      scrollBody
      actions={
        <div style={controlsStyle}>
          <Button onClick={cancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={prompt.busy || selectedPaths.length === 0 || prompt.error !== null || !directoryReady}
            onClick={() => { void send('confirm') }}
          >
            {prompt.multiple ? 'Choose folders' : 'Choose folder'}
          </Button>
        </div>
      }
    >
      <div style={stackStyle}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void navigate(path)
          }}
        >
          <div style={stackStyle}>
            <TextField
              label="Folder path"
              value={path}
              onChange={(event) => { void send('set-path', { path: event.currentTarget.value }) }}
            />
            <div style={controlsStyle}>
              <Button type="submit" disabled={prompt.busy}>Go</Button>
              <Button
                disabled={prompt.busy || !directoryReady || !directory?.parent}
                onClick={() => { if (directoryReady && directory?.parent) void navigate(directory.parent) }}
              >
                Up
              </Button>
            </div>
          </div>
        </form>

        {prompt.busy && (
          <NoticeLine>
            <StatusDot status="working" label="Reading daemon folders" /> Reading daemon folders
          </NoticeLine>
        )}
        {prompt.error && <InlineError message={prompt.error} action={{ label: 'Retry', onAction: retry }} />}

        {directoryReady && directory && (
          <div style={stackStyle}>
            {directory.entries.length === 0 && !prompt.busy ? (
              <EmptyState message="No folders here." />
            ) : (
              <div className="browser-folder-list" aria-label="Folders">
                {directory.entries.map((entry) => (
                  <ListRow
                    key={entry.path}
                    title={entry.name}
                    description={entry.path}
                    compact
                    selected={selected(entry.path)}
                    mainLabel={`Open ${entry.name}`}
                    onClick={() => { void navigate(entry.path) }}
                    trailing={prompt.multiple ? (
                      <Checkbox
                        checked={selected(entry.path)}
                        label={`${selected(entry.path) ? 'Remove' : 'Add'} ${entry.name}`}
                        hideLabel
                        onChange={(checked) => { void send('select', { path: entry.path, selected: checked }) }}
                      />
                    ) : (
                      <Button onClick={() => { void send('select', { path: entry.path, selected: true }) }}>
                        Select {entry.name}
                      </Button>
                    )}
                  />
                ))}
              </div>
            )}

            <div style={controlsStyle}>
              {prompt.multiple ? (
                <Checkbox
                  checked={selected(directory.path)}
                  label={`${selected(directory.path) ? 'Remove' : 'Add'} current folder`}
                  onChange={(checked) => { void send('select', { path: directory.path, selected: checked }) }}
                />
              ) : (
                <Button onClick={() => { void send('select', { path: directory.path, selected: true }) }}>
                  {selected(directory.path) ? 'Current folder selected' : 'Select this folder'}
                </Button>
              )}
              <Button
                disabled={prompt.busy || pageOffset === 0}
                onClick={() => { void navigate(directory.path, Math.max(0, pageOffset - pageLimit)) }}
              >
                Previous
              </Button>
              <Button
                disabled={prompt.busy || !directory.hasMore}
                onClick={() => { void navigate(directory.path, pageOffset + pageLimit) }}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        {prompt.multiple && selectedPaths.length > 0 && (
          <div style={stackStyle} aria-label="Selected folders">
            <NoticeLine>{selectedPaths.length} {selectedPaths.length === 1 ? 'folder' : 'folders'} selected</NoticeLine>
            {selectedPaths.map((selectedPath) => (
              <ListRow
                key={selectedPath}
                title={selectedPath}
                compact
                trailing={
                  <Button
                    aria-label={`Remove ${selectedPath}`}
                    disabled={prompt.busy}
                    onClick={() => { void send('select', { path: selectedPath, selected: false }) }}
                  >
                    Remove
                  </Button>
                }
              />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}
