import type {
  TransferQuirkyProfileProjectArgs,
  TransferQuirkyProfileProjectResult
} from '../../shared/quirky-profiles'
import type { Store } from '../persistence/loading-store/store'
import { transferQuirkyProfileProject } from './profile-project-transfer'
import { hasQuirkyProfileStateDatabase } from './profile-storage-paths'
import { profileHasPendingProjectMove } from './profile-project-move-intent'
import { flushActiveProfileBeforeFileMutation } from './profile-persistence-deadline'

/** Keep the active Store stopped until file mutation either succeeds or proves unchanged. */
export async function transferActiveProfileProject(
  args: TransferQuirkyProfileProjectArgs,
  userDataPath: string,
  store: Pick<Store, 'beginProfileMaintenance'>,
  reopenSource: () => Promise<void>
): Promise<TransferQuirkyProfileProjectResult> {
  const hadDatabase = hasQuirkyProfileStateDatabase(args.sourceProfileId, userDataPath)
  const pendingMove = profileHasPendingProjectMove(args.sourceProfileId, userDataPath)
  const maintenance = await flushActiveProfileBeforeFileMutation(store, { flush: !pendingMove })
  let result: TransferQuirkyProfileProjectResult
  try {
    if (profileHasPendingProjectMove(args.sourceProfileId, userDataPath)) {
      throw new Error('active_source_quirky_profile_move_requires_recovery')
    }
    result = transferQuirkyProfileProject(args, userDataPath)
  } catch (error) {
    const needsRecovery =
      (!hadDatabase && hasQuirkyProfileStateDatabase(args.sourceProfileId, userDataPath)) ||
      profileHasPendingProjectMove(args.sourceProfileId, userDataPath)
    // Further writes would invalidate a retained move's recovery revision.
    await (needsRecovery ? reopenSource() : maintenance.resume())
    throw error
  }
  if (result.status !== 'transferred' || args.mode !== 'move') {
    await maintenance.resume()
  }
  return result
}
