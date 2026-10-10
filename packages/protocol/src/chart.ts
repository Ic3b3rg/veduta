import { z } from 'zod'
import { JsonObjectSchema } from './json.ts'
import { ValueFormatSchema } from './value-presentation.ts'

const ChartLabelSchema = z.string().trim().min(1).max(240)

/** One explicitly keyed series, in the order of its canonical records (ADR-0003). */
export const ChartAtomPropsSchema = z
  .object({
    type: z
      .enum(['line', 'bar'])
      .describe('One line or bar series; no multiple or stacked series.'),
    xKey: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .describe('Record field for the x-value, in array order.'),
    yKey: z.string().trim().min(1).max(160).describe('Record field containing a finite number.'),
    xFormat: ValueFormatSchema.optional().describe(
      'Value presentation; defaults to compact dates for complete ISO values. Use text for literal references.',
    ),
    label: ChartLabelSchema.describe('Visible Chart title and accessible name.'),
    xLabel: ChartLabelSchema.describe('Visible label describing the x-values.'),
    yLabel: ChartLabelSchema.describe('Visible label describing the y-values, including units.'),
    emptyText: ChartLabelSchema.describe(
      'Truthful visible text when the bound record array is empty.',
    ),
  })
  .strict()
  .describe(
    'Chart props. Bind exactly one ordered canonical record array; static data is unsupported.',
  )

export type ChartAtomProps = z.infer<typeof ChartAtomPropsSchema>

export function chartSeriesSchema(props: Pick<ChartAtomProps, 'xKey' | 'yKey'>) {
  return z.array(JsonObjectSchema).transform((records, ctx) =>
    records.map((record, index) => {
      const x = record[props.xKey]
      const y = record[props.yKey]
      if (
        !Object.prototype.hasOwnProperty.call(record, props.xKey) ||
        !(
          (typeof x === 'string' && x.trim().length > 0) ||
          (typeof x === 'number' && Number.isFinite(x))
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, props.xKey],
          message: 'Chart x-values must be non-empty strings or finite numbers',
        })
        return z.NEVER
      }
      if (
        !Object.prototype.hasOwnProperty.call(record, props.yKey) ||
        typeof y !== 'number' ||
        !Number.isFinite(y)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, props.yKey],
          message: 'Chart y-values must be finite numbers',
        })
        return z.NEVER
      }
      return { label: String(x), value: y }
    }),
  )
}
