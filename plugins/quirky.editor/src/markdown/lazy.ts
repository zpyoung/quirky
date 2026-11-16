import type { createMarkdownMethods } from './service'
import type { EditorServices, FeatureMethods } from '../types'

export const MARKDOWN_METHOD_NAMES = ['markdown', 'markdownPreview', 'notes', 'workspaceNotes'] as const

type MarkdownServiceModule = {
  createMarkdownMethods: typeof createMarkdownMethods
}

/** The Markdown methods, with the service behind them loaded on the first call. */
export function createLazyMarkdownMethods(
  host: EditorServices,
  load: () => Promise<MarkdownServiceModule> = () => import('./service')
): FeatureMethods {
  let disposed = false
  let service: FeatureMethods | undefined
  let loading: Promise<FeatureMethods> | undefined

  const getService = async (): Promise<FeatureMethods> => {
    if (disposed) throw host.context.error('conflict', 'The editor is stopping.')
    if (service) return service

    if (!loading) {
      const attempt = load()
        .then((module) => {
          if (disposed) throw host.context.error('conflict', 'The editor is stopping.')
          service = module.createMarkdownMethods(host)
          return service
        })
        .finally(() => {
          if (loading === attempt) loading = undefined
        })
      loading = attempt
    }

    return loading
  }

  const methods: FeatureMethods['methods'] = {}
  for (const name of MARKDOWN_METHOD_NAMES) {
    methods[name] = async (params, caller) => {
      const loaded = await getService()
      return loaded.methods[name](params, caller)
    }
  }

  return {
    methods,
    dispose() {
      if (disposed) return
      disposed = true
      service?.dispose()
    }
  }
}
