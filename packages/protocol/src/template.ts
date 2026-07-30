import { z } from 'zod'
import { AtomNodeSchema } from './atom.ts'
import { collectNodeBindingRefs } from './surface.ts'

/**
 * A Template is a saved Atom composition: a proven Surface tree the Agent
 * (or the user, by pinning) decided is worth reusing instead of
 * regenerating from scratch (issues/022-emergent-templates.md;
 * docs/adr/0003-declarative-atoms.md: "good compositions become saved and
 * reused Templates" — consistency across regenerations).
 *
 * A Template carries the composition — the tree, and the *names* of the
 * state keys it binds (`stateKeys`) — never the typed data behind those
 * names. Reuse instantiates the tree, seeds those keys, and patches real
 * values in; the Template itself never stores a value a user or an
 * external source produced.
 */

/** `tpl-<slug>`. Also the on-disk filename, so this doubles as the path-traversal guard. */
export const SurfaceTemplateIdSchema = z.string().regex(/^tpl-[a-z0-9][a-z0-9-]{0,63}$/)

/**
 * Conservative source-name grammar for an untrusted origin: lowercase
 * alnum, `-`/`_`, 1-64 chars — the same shape the daemon's taint
 * vocabulary uses for `untrusted:<source>` origins.
 */
const originRe = /^(trusted:user|trusted:system|untrusted:[a-z0-9][a-z0-9_-]{0,63})$/

const TemplateOriginSchema = z.string().regex(originRe)

const TemplateProvenanceSchema = z.object({
  sourceSurfaceId: z.string().min(1),
  sourceSpaceId: z.string().min(1),
  savedAt: z.string().datetime(),
  savedBy: z.enum(['pin', 'stability']),
  origin: TemplateOriginSchema,
})

export const SurfaceTemplateSchema = z
  .object({
    formatVersion: z.literal(1),
    id: SurfaceTemplateIdSchema,
    name: z.string().min(1),
    /**
     * Free-text match key used to find a reusable Template. The structural
     * half of the match — the sorted "AtomType:count" digest — is never
     * persisted: it is a pure function of `tree` (`treeSignature` in
     * `@veduta/daemon`'s `templates.ts`), so storing it here would let an
     * imported bundle advertise a signature that does not describe its own
     * tree and steer matching (docs/adr/0012-emergent-templates.md).
     */
    intent: z.string().min(1),
    tree: AtomNodeSchema,
    /** Every state key the tree binds or a fast action targets — names only, never values. */
    stateKeys: z.array(z.string().min(1)),
    /** "<nodeId>.<prop>" keys dropped from `tree` as instance data during derivation. */
    dataProps: z.array(z.string().min(1)),
    provenance: TemplateProvenanceSchema,
  })
  .superRefine((template, ctx) => {
    const knownKeys = new Set(template.stateKeys)

    for (const ref of collectNodeBindingRefs(template.tree, ['tree'])) {
      if (knownKeys.has(ref.key)) continue

      const message =
        ref.kind === 'binding'
          ? `binding "${ref.key}" does not exist in stateKeys`
          : `fast action "${ref.actionName}" targets missing state key "${ref.key}"`

      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ref.path, message })
    }
  })

export type SurfaceTemplate = z.infer<typeof SurfaceTemplateSchema>

export const TemplateBundleSchema = z.object({
  formatVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  templates: z.array(SurfaceTemplateSchema),
})

export type TemplateBundle = z.infer<typeof TemplateBundleSchema>
