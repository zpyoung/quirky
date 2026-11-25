/** A fresh connection report with the app and platform it was built on. */
export type ConnectionDiagnosticsReport = {
  report: string
  appVersion: string
  platform: string
}

export interface DiagnosticsDeviceOperations {
  report(): Promise<ConnectionDiagnosticsReport>
}
