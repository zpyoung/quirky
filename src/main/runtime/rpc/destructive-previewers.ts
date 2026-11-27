import type {
  ApprovalCategory,
  DestructiveSpec
} from '../../../shared/public-rpc/public-method-spec'
import type { RpcContext } from './core'

/** Describes, without performing it, what a destructive call would change; each line is one effect. */
export type DestructivePreviewer = (params: unknown, ctx: RpcContext) => Promise<string[]>

const previewers = new Map<string, DestructivePreviewer>()

export function registerDestructivePreviewer(method: string, fn: DestructivePreviewer): void {
  if (previewers.has(method)) {
    throw new Error(`duplicate_destructive_previewer:${method}`)
  }
  previewers.set(method, fn)
}

export function getDestructivePreviewer(method: string): DestructivePreviewer | undefined {
  return previewers.get(method)
}

export function clearDestructivePreviewersForTest(): void {
  previewers.clear()
}

/** Decides from a call's own params whether it is destructive; undefined defers to the method spec. */
export type DestructiveResolver = (params: unknown) => DestructiveSpec | undefined

/** Names the approval category a call's own params require; undefined defers to the method spec. */
export type ApprovalCategoryResolver = (params: unknown) => ApprovalCategory | undefined

const destructiveResolvers = new Map<string, DestructiveResolver>()
const approvalCategoryResolvers = new Map<string, ApprovalCategoryResolver>()

export function registerDestructiveResolver(method: string, fn: DestructiveResolver): void {
  if (destructiveResolvers.has(method)) {
    throw new Error(`duplicate_destructive_resolver:${method}`)
  }
  destructiveResolvers.set(method, fn)
}

export function registerApprovalCategoryResolver(
  method: string,
  fn: ApprovalCategoryResolver
): void {
  if (approvalCategoryResolvers.has(method)) {
    throw new Error(`duplicate_approval_category_resolver:${method}`)
  }
  approvalCategoryResolvers.set(method, fn)
}

export function resolveDestructiveForCall(
  method: string,
  params: unknown
): DestructiveSpec | undefined {
  return destructiveResolvers.get(method)?.(params)
}

export function resolveApprovalCategoryForCall(
  method: string,
  params: unknown
): ApprovalCategory | undefined {
  return approvalCategoryResolvers.get(method)?.(params)
}
