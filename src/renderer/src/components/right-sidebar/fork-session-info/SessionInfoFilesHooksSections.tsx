import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SessionInfoFilesTouched } from '../../../../../shared/fork-session-info/session-info-types'
import type { HooksAndMcpLoadState } from './use-hooks-and-mcp'
import { SessionInfoAsOf, SessionInfoRow, SessionInfoWaiting } from './SessionInfoRows'

export function SessionInfoFilesSection({
  files
}: {
  files: SessionInfoFilesTouched
}): React.JSX.Element {
  return (
    <div>
      <dl>
        {files.linesAdded !== undefined ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.linesAdded', 'Lines added')}
            value={`+${files.linesAdded}`}
          />
        ) : null}
        {files.linesRemoved !== undefined ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.linesRemoved', 'Lines removed')}
            value={`−${files.linesRemoved}`}
          />
        ) : null}
      </dl>
      <SessionInfoAsOf updatedAt={files.updatedAt} />
    </div>
  )
}

function statusLineLabel(state: string): string {
  switch (state) {
    case 'managed':
      return translate('fork.sessionInfo.statusLineManaged', 'Managed')
    case 'chained':
      return translate('fork.sessionInfo.statusLineChained', 'Chained')
    case 'available':
      return translate('fork.sessionInfo.statusLineAvailable', 'Custom statusline detected')
    case 'drifted':
      return translate('fork.sessionInfo.statusLineDrifted', 'Custom statusline changed')
    case 'disabled':
      return translate('fork.sessionInfo.statusLineDisabled', 'Not enabled')
    default:
      return translate('fork.sessionInfo.statusLineError', 'Needs attention')
  }
}

function hookStateLabel(state: string): string {
  switch (state) {
    case 'installed':
      return translate('fork.sessionInfo.hookInstalled', 'Installed')
    case 'not_installed':
      return translate('fork.sessionInfo.hookNotInstalled', 'Not installed')
    case 'partial':
      return translate('fork.sessionInfo.hookPartial', 'Partially installed')
    case 'skipped':
      return translate('fork.sessionInfo.hookSkipped', 'Skipped')
    default:
      return translate('fork.sessionInfo.hookError', 'Error')
  }
}

function mcpStatusLabel(status: string): string {
  switch (status) {
    case 'enabled':
      return translate('fork.sessionInfo.mcpEnabled', 'Enabled')
    case 'disabled':
      return translate('fork.sessionInfo.mcpDisabled', 'Disabled')
    default:
      return translate('fork.sessionInfo.mcpInvalid', 'Invalid')
  }
}

export function SessionInfoHooksSection({
  loadState,
  onRetry,
  onEnableStatusLine
}: {
  loadState: HooksAndMcpLoadState
  onRetry: () => void
  onEnableStatusLine: () => void
}): React.JSX.Element {
  if (loadState.status === 'idle' || loadState.status === 'loading') {
    return (
      <SessionInfoWaiting
        label={translate(
          'fork.sessionInfo.hooksLoading',
          'Inspecting hooks and MCP configuration…'
        )}
      />
    )
  }
  const value = loadState.value
  const statusLine = value?.statusLine
  const canEnableStatusLine = statusLine?.state === 'available' || statusLine?.state === 'drifted'
  return (
    <div className="space-y-2">
      {value?.hookStatus ? (
        <dl>
          <SessionInfoRow
            label={translate('fork.sessionInfo.hooks', 'Hooks')}
            value={hookStateLabel(value.hookStatus.state)}
          />
          {value.hookStatus.detail ? (
            <SessionInfoRow
              label={translate('fork.sessionInfo.hookDetail', 'Hook detail')}
              value={value.hookStatus.detail}
              title={value.hookStatus.detail}
            />
          ) : null}
        </dl>
      ) : null}
      {statusLine ? (
        <div className="rounded-md border border-border bg-muted/30 p-2">
          <p className="text-xs font-medium text-foreground">
            {translate('fork.sessionInfo.statusLine', 'Statusline')} ·{' '}
            {statusLineLabel(statusLine.state)}
          </p>
          {statusLine.detail ? (
            <p className="mt-1 text-xs text-muted-foreground">{statusLine.detail}</p>
          ) : null}
          {canEnableStatusLine ? (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                {translate(
                  'fork.sessionInfo.statusLineConsent',
                  'Quirky will preserve and run your existing statusline command.'
                )}
              </p>
              <Button
                variant="outline"
                size="xs"
                className="mt-2"
                disabled={loadState.enablingStatusLine}
                onClick={onEnableStatusLine}
              >
                {translate('fork.sessionInfo.enableStatusLine', 'Enable session telemetry')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {value?.mcpServers ? (
        <div>
          <p className="mb-1 text-xs font-medium text-foreground">
            {translate('fork.sessionInfo.configuredMcp', 'Configured MCP servers')}
          </p>
          {value.mcpServers.length ? (
            <ul className="space-y-1">
              {value.mcpServers.map((server) => (
                <li
                  key={server.name}
                  className="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5"
                >
                  <p className="truncate text-xs text-foreground" title={server.name}>
                    {server.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {server.transport} · {mcpStatusLabel(server.status)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {translate('fork.sessionInfo.noMcp', 'No configured servers found.')}
            </p>
          )}
        </div>
      ) : null}
      {loadState.error ? (
        <p role="alert" className="text-xs text-destructive">
          {loadState.error}
        </p>
      ) : null}
      {loadState.status === 'error' ? (
        <Button variant="outline" size="xs" onClick={onRetry}>
          <RefreshCw className="size-3" />
          {translate('fork.sessionInfo.retry', 'Retry')}
        </Button>
      ) : null}
      <SessionInfoAsOf updatedAt={value?.updatedAt} stale={loadState.status === 'error'} />
    </div>
  )
}
