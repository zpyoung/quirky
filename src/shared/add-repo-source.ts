export type AddRepoExistingWorkspaceSource =
  | 'local_folder_picker'
  | 'runtime_server_path'
  | 'ssh_remote_path'
  | 'clone_url'
  | 'create_project'

export type AddRepoDefaultCheckoutHandoffSource =
  | AddRepoExistingWorkspaceSource
  | 'onboarding_open_folder'
  | 'onboarding_clone_url'
  | 'project_added_compat'

export type DefaultCheckoutHandoffReason =
  | 'loaded_default_checkout'
  | 'detected_default_checkout'
  | 'no_authoritative_detection'
  | 'no_default_checkout'
  | 'show_detected_default_failed'
  | 'show_detected_linked_failed'
  | 'authoritative_refresh_failed'
  | 'linked_external_refresh_failed'
  | 'refreshed_default_missing'

export type FeatureWallOpenSource = 'help_menu' | 'popup' | 'onboarding' | 'unknown'
