/** Untrusted guest data is clamped before any display, export, or delivery. */
export type DesignRect = { x: number; y: number; width: number; height: number }
export type DesignScreenshot = { mimeType: 'image/png'; dataUrl: string; width: number; height: number }
export type DesignPayload = {
  page: { sanitizedUrl: string; title: string; viewportWidth: number; viewportHeight: number; scrollX: number; scrollY: number; devicePixelRatio: number; capturedAt: string }
  target: {
    tagName: string; selector: string; elementPath: string; fullPath: string; cssClasses: string; nearbyElements: string[];
    selectedText: string | null; isFixed: boolean; reactComponents: string | null; sourceFile: string | null;
    textSnippet: string; htmlSnippet: string; attributes: Record<string, string>;
    accessibility: { role: string; accessibleName: string; ariaLabel: string; ariaLabelledBy: string };
    rectViewport: DesignRect; rectPage: DesignRect; computedStyles: Record<string, string>
  }
  nearbyText: string[]; ancestorPath: string[]; screenshot: DesignScreenshot | null
}
export type DesignAnnotation = { id: string; revision: number; browserPageId: string; payload: DesignPayload; intent: 'change' | 'question'; comment: string }
export type DesignSelection = { kind: 'selected' | 'context-selected' | 'copy' | 'screenshot'; payload: DesignPayload }
export type DesignRead = { opId: string; status: 'armed' | 'cancelled' | 'expired'; selection?: DesignSelection }
export type DesignTarget = { session: string; agent: string; label: string; title: string; status: string; state: string | null; lastActivityAt: number; sendable: boolean; reason?: string }
export type DesignTargets = { sessions: DesignTarget[]; agents: { id: string; label: string }[] }
export const DESIGN_METHODS = ['designArm', 'designRead', 'designHover', 'designCancel', 'designCapture', 'designFormat', 'designTargets', 'designSend'] as const
export type DesignMethod = typeof DESIGN_METHODS[number]
export type DesignGuestAction = 'arm' | 'read' | 'hover' | 'cancel' | 'hide' | 'show'
export type DesignRequests = {
  designArm: { pane: string; mode: 'grab' | 'annotate' }
  designRead: { pane: string; opId: string }
  designHover: { pane: string; opId: string }
  designCancel: { pane: string; opId: string }
  designCapture: { pane: string; opId?: string; rect?: DesignRect }
  designFormat: { payload?: unknown; annotations?: unknown[] }
  designTargets: { pane: string }
  designSend: { pane: string; annotations: unknown[]; session?: string; agent?: string }
}
