import { z } from 'zod'

const askStatusSchema = z.enum([
  'registered',
  'pending',
  'answered',
  'partial',
  'declined',
  'timed_out',
  'unavailable'
])

const askPartialDraftSchema = z.looseObject({
  selected: z.array(z.string()).optional(),
  other: z.string().optional(),
  draft: z.string().optional(),
  confirm: z.boolean().optional(),
  note: z.string().optional()
})

const askRegistryEventSchema = z.looseObject({
  seq: z.number(),
  epoch: z.string(),
  askId: z.string(),
  paneKey: z.string().nullable(),
  status: askStatusSchema,
  spec: z.unknown().optional(),
  partial: z.record(z.string(), askPartialDraftSchema).optional(),
  result: z.looseObject({ summary: z.string(), skipped: z.array(z.string()) }).optional(),
  worktreeId: z.string().nullable().optional()
})

export type AskStreamEvent = z.infer<typeof askRegistryEventSchema>

const askStreamFrameSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('snapshot'), event: askRegistryEventSchema }),
  z.looseObject({ type: z.literal('watermark'), seq: z.number(), epoch: z.string() }),
  z.looseObject({ type: z.literal('event'), event: askRegistryEventSchema }),
  z.looseObject({ type: z.literal('end'), reason: z.string().optional() }),
  z.looseObject({ type: z.literal('error'), message: z.string().optional() })
])

export type AskStreamFrameInput = z.infer<typeof askStreamFrameSchema>

/** Null for the transport's `ready` marker and for any frame a foreign host sends that this phone cannot read. */
export function readAskStreamFrame(data: unknown): AskStreamFrameInput | null {
  const parsed = askStreamFrameSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}
