import type { QuirkydManagedDeployResult } from './quirkyd-managed-runtime'
import type { SshRepoReadoption, SshTargetCreateInput } from './ssh-types'

export type QuirkydSshProvisioningIntent = Readonly<{
  requestId: string
  name: string
}>

export type QuirkydSshProvisioningRequest = QuirkydSshProvisioningIntent & {
  target: SshTargetCreateInput
}

export type QuirkydSshPendingProvisioning = QuirkydSshProvisioningIntent & {
  sshTargetId: string
}

export type QuirkydSshProvisioningResult = QuirkydSshPendingProvisioning & {
  repoReadoptions: SshRepoReadoption[]
  result: QuirkydManagedDeployResult | { outcome: 'pending'; reason: string }
}
