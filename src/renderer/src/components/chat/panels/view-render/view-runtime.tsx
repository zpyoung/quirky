import { createContext, useContext } from 'react'

export type WorkspaceImage = { dataUrl: string }

/** What a rendered view node may reach: its link opener and the workspace it draws files from. */
export type ViewRuntime = {
  viewId: string
  workspaceRoot: string | null
  openLink(href: string): void
  /** Opens a localhost preview URL in the app's browser tab. */
  openPreview(url: string): void
  /** Reads an image at a workspace-relative path; rejects with a reason a person can read. */
  readWorkspaceImage(relativePath: string): Promise<WorkspaceImage>
}

const INERT: ViewRuntime = {
  viewId: '',
  workspaceRoot: null,
  openLink: () => {},
  openPreview: () => {},
  readWorkspaceImage: () => Promise.reject(new Error('No workspace to read images from.'))
}

export const ViewRuntimeContext = createContext<ViewRuntime>(INERT)

export const useViewRuntime = (): ViewRuntime => useContext(ViewRuntimeContext)
