import { z } from 'zod'

export const UI_STATE_TAB_TYPES = [
  'terminal',
  'browser',
  'editor',
  'markdown',
  'chat',
  'other'
] as const

/** What the user is looking at right now, as the renderer reports it. */
export const UiStateSnapshotSchema = z.object({
  worktreeId: z.string().nullable(),
  view: z.string(),
  tab: z
    .object({
      id: z.string(),
      type: z.enum(UI_STATE_TAB_TYPES),
      title: z.string()
    })
    .nullable(),
  paneId: z.string().nullable(),
  panels: z.object({
    leftSidebar: z.boolean(),
    rightSidebar: z.object({ open: z.boolean(), tab: z.string().nullable() }),
    floatingTerminal: z.boolean()
  }),
  editorFile: z.string().nullable()
})

export type UiStateSnapshot = z.infer<typeof UiStateSnapshotSchema>
