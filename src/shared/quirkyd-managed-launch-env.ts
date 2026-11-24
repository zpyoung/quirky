/**
 * Set only by a client's managed launch. Enables idle exit and names the host's activation
 * fence, so an update or rollback in flight keeps the server up. User-started servers never
 * carry it. Dependency-free so the quirkyd launcher can read it.
 */
export const QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV = 'QUIRKY_QUIRKYD_MANAGED_ACTIVATION_ROOT'
