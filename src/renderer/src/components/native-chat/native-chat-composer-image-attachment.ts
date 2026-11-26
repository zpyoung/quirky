export type NativeChatComposerImageAttachment = {
  id: string
  /** Empty while `pending`: the clipboard image has no agent-readable path yet. */
  path: string
  connectionId?: string
  /** Clipboard thumbnail (blob/data URL) rendered before — and after — the file
   *  lands, so the chip never waits on a disk round-trip to show something. */
  previewUrl?: string
  /** True while the pasted image is still being written to disk or uploaded. */
  pending?: boolean
  /** The file's name while it uploads: a dropped or picked file, not a pasted image. */
  pendingName?: string
  /** Set on an image the draft names but can't send: the file to attach again. */
  unavailableName?: string
}
