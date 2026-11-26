import { useMemo } from 'react'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import {
  fileLinkTargetExists,
  mayCheckFileLinkTargetUnprompted,
  resolveFileLinkTarget,
  type FileLinkHost
} from '@/components/terminal-pane/terminal-file-link-target'
import { createTerminalPathExistenceBatch } from '@/components/terminal-pane/terminal-path-existence-batch'
import { useAppStore } from '@/store'
import { routeNativeChatHref } from '../../../../../shared/native-chat-href-routing'
import { resolveNativeChatFileLink } from '../../native-chat/native-chat-file-link'
import { showFileLinkUnresolvedToast } from '../../native-chat/native-chat-file-link-toasts'
import {
  nativeChatFileOpenDeps,
  resolveNativeChatHttpLinkRouting
} from '../../native-chat/native-chat-link-target-actions'
import { openNativeChatWebLink } from '../../native-chat/native-chat-web-link-actions'
import { useNativeChatFileLinkContext } from '../../native-chat/use-native-chat-file-link-context'
import type { ChatMarkdownAssets } from '../markdown'

const PATH_WITH_POSITION = /^(.*?)(?::(\d+))?(?::(\d+))?$/

type Wiring = { assets: ChatMarkdownAssets | undefined; onOpenLink: (href: string) => void }

/**
 * How the chat's markdown opens links and finds files: through the same file and web link
 * actions the native chat uses, for the workspace that owns `tabId`. Without a tab no file
 * resolves and no link opens, so nothing in a reply looks clickable that cannot be.
 */
export function useChatMarkdownWiring(tabId: string | undefined): Wiring {
  // an empty id owns no workspace, so the context is null
  const context = useNativeChatFileLinkContext(tabId ?? '')
  return useMemo(() => {
    if (!context) {
      return { assets: undefined, onOpenLink: () => {} }
    }
    const host: FileLinkHost = {
      cwd: context.worktreePath,
      worktreeId: context.worktreeId,
      worktreePath: context.worktreePath,
      runtimeEnvironmentId: context.runtimeEnvironmentId
    }
    const pathExists = createTerminalPathExistenceBatch()
    const existsCache = new Map<string, boolean>()
    const openFile = (href: string): void => {
      const target = resolveNativeChatFileLink(href, context)
      if (!target) {
        showFileLinkUnresolvedToast(href)
        return
      }
      openDetectedFilePath(target.absolutePath, target.line, target.column, {
        ...nativeChatFileOpenDeps(target, context),
        openWithSystemDefault: false
      })
    }
    const assets: ChatMarkdownAssets = {
      async resolveFiles(candidates) {
        const found: Record<string, { line?: number } | null> = {}
        await Promise.all(
          candidates.map(async (candidate) => {
            const match = PATH_WITH_POSITION.exec(candidate)
            const pathText = match?.[1] ?? candidate
            const line = match?.[2] === undefined ? null : Number(match[2])
            const column = match?.[3] === undefined ? null : Number(match[3])
            const target = resolveFileLinkTarget(
              {
                pathText,
                line,
                column,
                startIndex: 0,
                endIndex: candidate.length,
                displayText: candidate
              },
              host
            )
            try {
              const exists =
                target !== null &&
                mayCheckFileLinkTargetUnprompted(target, host) &&
                (await fileLinkTargetExists(target, existsCache, pathExists))
              found[candidate] = exists ? (line === null ? {} : { line }) : null
            } catch {
              found[candidate] = null
            }
          })
        )
        return found
      },
      resolveImages: async (srcs) => Object.fromEntries(srcs.map((src) => [src, null])),
      openFile: (path, line) => openFile(line === undefined ? path : `${path}:${line}`)
    }
    const onOpenLink = (href: string): void => {
      const route = routeNativeChatHref(href)
      if (route.kind === 'file') {
        openFile(href)
        return
      }
      if (route.kind === 'web' && /^https?:/i.test(route.url)) {
        const routing = resolveNativeChatHttpLinkRouting(useAppStore.getState(), context.worktreeId)
        openNativeChatWebLink(
          route.url,
          { worktreeId: context.worktreeId, sourceOwner: routing.sourceOwner },
          undefined
        )
      }
    }
    return { assets, onOpenLink }
  }, [context])
}
