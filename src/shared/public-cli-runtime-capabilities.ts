// Hosts without this capability have no public CLI contract: no stable error codes, no
// `publicContract` request flag handling, no public events.
export const PUBLIC_CLI_RUNTIME_CAPABILITY = 'public-cli.v1' as const

export const PUBLIC_CLI_RUNTIME_CAPABILITIES = [PUBLIC_CLI_RUNTIME_CAPABILITY] as const
