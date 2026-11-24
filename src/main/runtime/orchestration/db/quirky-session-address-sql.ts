import { QUIRKY_SESSION_ADDRESS_PREFIX } from '../../../../shared/quirky-session-address'

/**
 * The `quirky_session_id:<id>` address of a bare Quirky session id column or expression, NULL when it is NULL.
 * The only way SQL compares a stored id with a mail address: the id side is formatted, never the
 * address side stripped, so a handle or `run:` address can never equal a bare id.
 */
export function quirkySessionAddressSql(quirkySessionIdSql: string): string {
  return `('${QUIRKY_SESSION_ADDRESS_PREFIX}' || ${quirkySessionIdSql})`
}
