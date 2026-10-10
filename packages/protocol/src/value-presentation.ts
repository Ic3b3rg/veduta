import { z } from 'zod'

/** Unspecified formats recognize only complete ISO dates and zoned ISO timestamps. */
export const ValueFormatSchema = z.enum(['text', 'date', 'datetime'])
export type ValueFormat = z.infer<typeof ValueFormatSchema>

export const DateValueSchema = z.union([z.string().date(), z.string().datetime({ offset: true })])
