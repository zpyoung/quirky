import type {
  CreateLocalQuirkyProfileArgs,
  CreateLocalQuirkyProfileResult,
  FindQuirkyProfileProjectsByPathArgs,
  FindQuirkyProfileProjectsByPathResult,
  QuirkyProfileListResult,
  SwitchQuirkyProfileArgs,
  SwitchQuirkyProfileResult,
  TransferQuirkyProfileProjectArgs,
  TransferQuirkyProfileProjectResult
} from '../../shared/quirky-profiles'

export type QuirkyProfileApi = {
  list: () => Promise<QuirkyProfileListResult>
  createLocal: (args?: CreateLocalQuirkyProfileArgs) => Promise<CreateLocalQuirkyProfileResult>
  switchProfile: (args: SwitchQuirkyProfileArgs) => Promise<SwitchQuirkyProfileResult>
  transferProject: (
    args: TransferQuirkyProfileProjectArgs
  ) => Promise<TransferQuirkyProfileProjectResult>
  findProjectProfiles: (
    args: FindQuirkyProfileProjectsByPathArgs
  ) => Promise<FindQuirkyProfileProjectsByPathResult>
}
