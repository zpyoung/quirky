import { useContext } from 'react'
import { FileIcon } from '../../design-system/tool-icons'
import { RuntimeContext } from '../runtime'
import { splitPathCandidate } from '../remark-path-candidates'

const ICON_SIZE = 12

/** A file path that exists in the worktree, drawn as a chip that opens the file at its written line. */
export function PathChip({ candidate, line }: { candidate: string; line?: number }) {
  const runtime = useContext(RuntimeContext)
  const written = splitPathCandidate(candidate)
  return (
    <button
      type="button"
      className="qmd-chip"
      data-path-chip=""
      data-path={written.path}
      title={candidate}
      onClick={() => runtime.current.assets?.openFile(written.path, line ?? written.line)}
    >
      <FileIcon path={written.path} size={ICON_SIZE} />
      <span>{candidate}</span>
    </button>
  )
}
