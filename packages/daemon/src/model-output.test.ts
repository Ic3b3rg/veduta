import { describe, expect, it } from 'vitest'
import { stripJsonCodeFence } from './model-output.ts'

describe('stripJsonCodeFence', () => {
  it('removes an optional JSON fence and surrounding whitespace', () => {
    expect(stripJsonCodeFence('  ```json\n{"ok":true}\n```  ')).toBe('{"ok":true}')
    expect(stripJsonCodeFence('```\n[]\n```')).toBe('[]')
  })

  it('leaves unfenced content intact apart from surrounding whitespace', () => {
    expect(stripJsonCodeFence('  {"ok":true}  ')).toBe('{"ok":true}')
  })
})
