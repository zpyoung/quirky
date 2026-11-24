/** How a managed re-pair retires transports still on the refused token; the IPC layer registers it. */
let listener: (environmentId: string) => void | Promise<void> = () => {}

export function setManagedQuirkydPairingRepairedListener(
  next: (environmentId: string) => void | Promise<void>
): void {
  listener = next
}

export function notifyManagedQuirkydPairingRepaired(environmentId: string): void | Promise<void> {
  return listener(environmentId)
}
