import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { getJudgmentQuestionPolicy } from '../../shared/fork-heimdall/judgment/registry'
import type { JudgmentPersistencePort } from '../fork-heimdall/judgment/store'
import { readJudgmentAccess } from '../fork-heimdall/judgment/access-store'
import { createJudgmentClient } from '../fork-heimdall/judgment/client'
import { JudgmentService } from '../fork-heimdall/judgment/service'
import { JudgmentAnswerStore } from '../fork-heimdall/judgment/store'
import { ObjectiveDatabase } from './objective-database'
import { createObjectiveKind, type ObjectiveKind } from './kind'
import { ObjectiveStore } from './objective-store'

export type ObjectiveKernelRegistration = {
  registerKind(kind: ObjectiveKind): void
}

export type ObjectiveRegistration = {
  store: ObjectiveStore
  dispose(): void
}

export function registerObjectiveKind(
  kernel: ObjectiveKernelRegistration,
  runtime: QuirkyRuntimeService,
  store: Store,
  storageAuthority: 'desktop' | 'runtime' = 'desktop',
  judgmentPersistence?: JudgmentPersistencePort
): ObjectiveRegistration {
  const database = new ObjectiveDatabase(store)
  const objectiveStore = new ObjectiveStore(database)
  const judgmentService = judgmentPersistence
    ? new JudgmentService({
        store: new JudgmentAnswerStore(judgmentPersistence),
        databasePath: () => judgmentPersistence.databasePath(),
        readAccess: readJudgmentAccess,
        createClient: createJudgmentClient,
        questionPolicy: getJudgmentQuestionPolicy
      })
    : undefined
  kernel.registerKind(
    createObjectiveKind({
      runtime,
      store,
      objectiveStore,
      storageAuthority,
      ...(judgmentService ? { judgmentService } : {})
    })
  )
  return {
    store: objectiveStore,
    dispose: () => database.close()
  }
}
