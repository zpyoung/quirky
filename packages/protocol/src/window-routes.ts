import type { UiLayout, UiState } from './ui'

/** A live kernel UI connection, never a native auxiliary ID or caller-supplied host label. */
export type WindowRoute = { connId: number; desktopClientId?: string }
export type WindowRouteState = UiState & WindowRoute
export type WindowViewOpenRequest = WindowRoute & { id: string; input?: unknown }
/** Exact-view compare-and-close prevents sleep from closing a newly selected workspace. */
export type WindowViewCloseRequest = WindowRoute & { expectedView?: NonNullable<UiLayout['view']> }
export type WindowCommandRequest = WindowRoute & { id: string; args?: unknown }
