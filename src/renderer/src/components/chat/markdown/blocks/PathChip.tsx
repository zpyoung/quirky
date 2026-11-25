import { useContext } from 'react'
import { FileText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { RuntimeContext } from '../runtime'
import { splitPathCandidate } from '../remark-path-candidates'

/** A file path that exists in the worktree, drawn as a chip that opens the file at its written line. */
export function PathChip({ candidate, line }: { candidate: string; line?: number }) {
  const runtime = useContext(RuntimeContext)
  const written = splitPathCandidate(candidate)
  return (
    <Badge asChild variant="promptPill">
      <button
        type="button"
        className="qmd-chip"
        data-path-chip=""
        data-path={written.path}
        title={candidate}
        onClick={() => runtime.current.assets?.openFile(written.path, line ?? written.line)}
      >
        <FileText aria-hidden="true" />
        <span>{candidate}</span>
      </button>
    </Badge>
  )
}
