export const QUIRKY_EDITOR_SAVE_DIRTY_FILES_EVENT = 'quirky:editor-save-dirty-files'
export const QUIRKY_EDITOR_PREPARE_HOT_EXIT_EVENT = 'quirky:editor-prepare-hot-exit'

export type EditorSaveDirtyFilesDetail = {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorPrepareHotExitDetail = EditorSaveDirtyFilesDetail
