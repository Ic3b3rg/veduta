import type { AtomType } from './atom.ts'
import type { JsonValue } from './json.ts'

/** Composition metadata remains in a Template; collections of instance content do not. */
export function isAtomCompositionProp(type: AtomType, key: string): boolean {
  return (
    (type === 'Table' && key === 'columns') ||
    (['Select', 'RadioGroup', 'Combobox'].includes(type) && key === 'options')
  )
}

export function emptyAtomDataProp(type: AtomType, key: string): JsonValue | undefined {
  return (type === 'Table' && key === 'rows') || (type === 'Automation' && key === 'history')
    ? []
    : undefined
}

/** Typed empty values satisfy each accepted binding contract without inventing user data. */
export function defaultAtomBindingValue(type: AtomType): JsonValue {
  if (type === 'Table' || type === 'Chart') return []
  if (['Checkbox', 'Switch', 'Automation'].includes(type)) return false
  if (
    [
      'Input',
      'Textarea',
      'Title',
      'Text',
      'Caption',
      'Label',
      'Markdown',
      'Select',
      'RadioGroup',
      'Combobox',
    ].includes(type)
  )
    return ''
  return null
}
