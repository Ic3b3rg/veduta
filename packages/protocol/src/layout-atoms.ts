import { z } from 'zod'
import type { AtomNode } from './atom.ts'
import { AtomToneSchema } from './content-atoms.ts'

export const AtomSpacingSchema = z.enum(['none', 'xs', 'sm', 'md', 'lg', 'xl'])
export const BoxAtomPropsSchema = z
  .object({ gap: AtomSpacingSchema.optional(), padding: AtomSpacingSchema.optional() })
  .strict()
export const RowAtomPropsSchema = z
  .object({
    gap: AtomSpacingSchema.optional(),
    align: z.enum(['start', 'end', 'center', 'stretch']).optional(),
    wrap: z.boolean().optional(),
  })
  .strict()
export const ColAtomPropsSchema = z.object({ gap: AtomSpacingSchema.optional() }).strict()
export const SpacerAtomPropsSchema = z.object({ size: AtomSpacingSchema.optional() }).strict()
export const DividerAtomPropsSchema = z.object({}).strict()
export const TransitionAtomPropsSchema = z.object({ visible: z.boolean().optional() }).strict()

/** Media sources are HTTP(S) or same-origin absolute paths, without embedded credentials or markup. */
export const ImageSourceSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((source) => {
    if (
      /[\s\\]/.test(source) ||
      Array.from(source).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return false
    if (/^\/(?!\/)/.test(source)) return true
    try {
      const url = new URL(source)
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
    } catch {
      return false
    }
  }, 'Image source must be an HTTP(S) URL or same-origin absolute path without credentials')
export const ImageAtomPropsSchema = z
  .object({
    src: ImageSourceSchema.optional(),
    alt: z.string().trim().min(1).max(240),
    loading: z.enum(['lazy', 'eager']).optional(),
  })
  .strict()
export const iconNames = ['dot', 'check', 'clock', 'alert', 'bolt'] as const
export const IconAtomPropsSchema = z
  .object({
    name: z.enum(iconNames),
    label: z.string().trim().min(1).max(240).optional(),
    decorative: z.boolean().optional(),
    tone: AtomToneSchema.optional(),
  })
  .strict()
  .superRefine((props, ctx) => {
    if (props.decorative === true && props.label !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['label'],
        message: 'Decorative Icon cannot discard a label',
      })
    if (props.decorative !== true && props.label === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['label'],
        message: 'Icon requires a label or decorative: true',
      })
  })

export type ImageAtomProps = z.infer<typeof ImageAtomPropsSchema>
export type IconAtomProps = z.infer<typeof IconAtomPropsSchema>
const layoutSchemas = {
  Box: BoxAtomPropsSchema,
  Row: RowAtomPropsSchema,
  Col: ColAtomPropsSchema,
  Spacer: SpacerAtomPropsSchema,
  Divider: DividerAtomPropsSchema,
  Image: ImageAtomPropsSchema,
  Icon: IconAtomPropsSchema,
  Transition: TransitionAtomPropsSchema,
}
type LayoutAtomType = keyof typeof layoutSchemas

interface LayoutAtomCandidate {
  type: AtomNode['type']
  props?: Readonly<Record<string, unknown>> | undefined
  binding?: string | undefined
  actions?: AtomNode['actions'] | undefined
  children?: AtomNode['children'] | undefined
}

export function validateLayoutAtom(node: LayoutAtomCandidate, ctx: z.RefinementCtx): void {
  if (!isLayoutAtomType(node.type)) return
  const result = layoutSchemas[node.type].safeParse(node.props ?? {})
  if (!result.success) {
    for (const issue of result.error.issues)
      ctx.addIssue({ ...issue, path: ['props', ...issue.path] })
  }
  for (const field of ['binding', 'actions'] as const) {
    if (node[field] !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${node.type} does not accept ${field}`,
      })
  }
  if (['Spacer', 'Divider', 'Image', 'Icon'].includes(node.type) && node.children !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['children'],
      message: `${node.type} must be a leaf Atom`,
    })
  }
  if (node.type === 'Transition' && !node.children?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['children'],
      message: 'Transition requires visible canonical children',
    })
  }
}

function isLayoutAtomType(type: string): type is LayoutAtomType {
  return Object.hasOwn(layoutSchemas, type)
}
