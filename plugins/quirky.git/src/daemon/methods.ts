import { aiFix, aiFixPreview } from './ai-fix'
import { cancelGenerate, generateCommitMessage } from './ai-generate'
import { aiRecipe, setAiRecipe } from './ai-recipes'
import { aiName } from './ai-name'
import type { DaemonEnv, Handler } from './env'
import { commit } from './commit'
import { branches, compare, setBase } from './compare'
import { describeSwitchBranch, switchBranch } from './branch-switch'
import { abort, acceptConflictDeletion, conflictFile, continueOperation, describeAbort } from './conflicts'
import { diff, hugeFolders, ignoreFolder, reveal, save, submoduleStatus } from './files'
import { commitFiles, history } from './history'
import { addNote, clearNotes, deleteNote, describeClearNotes, editNote, formatNotes, notes } from './notes'
import { describeForcePush, fastForward, fetchRemote, forcePush, pull, push, pushTarget, rebaseFromBase, sync } from './remote'
import { describeDiscard, discard, stage, unstage } from './staging'
import { noteTargets, sendNotes } from './targets'
import { mergePreview } from './merge-preview'
import { diffCloseGuard } from './hosted'

/**
 * Every method `quirky.git` provides, by manifest name. A handler that throws has its git,
 * eligibility and path errors turned into reasoned plugin errors.
 */
export function methodTable(env: DaemonEnv): Record<string, Handler> {
  const status: Handler = async (params, caller) => env.readStatus(await env.resolve(params, caller))
  const table: Record<string, Handler> = {
    status,
    diff: diff(env),
    stage: stage(env),
    unstage: unstage(env),
    discard: discard(env),
    describeDiscard: describeDiscard(env),
    commit: commit(env),
    continue: continueOperation(env),
    abort: abort(env),
    describeAbort: describeAbort(env),
    conflictFile: conflictFile(env),
    acceptConflictDeletion: acceptConflictDeletion(env),
    save: save(env),
    submoduleStatus: submoduleStatus(env),
    hugeFolders: hugeFolders(env),
    ignoreFolder: ignoreFolder(env),
    reveal: reveal(env),
    push: push(env),
    diffCloseGuard: diffCloseGuard(),
    pushTarget: pushTarget(env),
    forcePush: forcePush(env),
    describeForcePush: describeForcePush(env),
    pull: pull(env),
    fastForward: fastForward(env),
    fetch: fetchRemote(env),
    sync: sync(env),
    rebaseFromBase: rebaseFromBase(env),
    compare: compare(env),
    mergePreview: mergePreview(env),
    setBase: setBase(env),
    branches: branches(env),
    switchBranch: switchBranch(env),
    describeSwitchBranch: describeSwitchBranch(env),
    history: history(env),
    commitFiles: commitFiles(env),
    notes: notes(env),
    addNote: addNote(env),
    editNote: editNote(env),
    deleteNote: deleteNote(env),
    clearNotes: clearNotes(env),
    describeClearNotes: describeClearNotes(env),
    formatNotes: formatNotes(env),
    noteTargets: noteTargets(env),
    sendNotes: sendNotes(env),
    generateCommitMessage: generateCommitMessage(env),
    cancelGenerate: cancelGenerate(env),
    aiFix: aiFix(env),
    aiFixPreview: aiFixPreview(env),
    aiName: aiName(env),
    aiRecipe: aiRecipe(env),
    setAiRecipe: setAiRecipe(env)
  }
  return Object.fromEntries(
    Object.entries(table).map(([name, handler]) => [
      name,
      async (params, caller) => {
        try {
          return await handler(params, caller)
        } catch (error) {
          throw env.errors.translate(error)
        }
      }
    ])
  )
}
