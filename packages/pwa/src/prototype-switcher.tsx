import { Button } from '@veduta/catalog/ui/button'
import { useEffect } from 'react'
import type { PrototypeVariant } from './connections-prototype-data.ts'

const variants: PrototypeVariant[] = ['A', 'B', 'C']
const labels = { A: 'Service catalog', B: 'Control panel', C: 'Guided overview' }

export function PrototypeSwitcher({
  variant,
  onChange,
}: {
  variant: PrototypeVariant
  onChange: (variant: PrototypeVariant) => void
}) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable], dialog')
      )
        return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      onChange(
        variants[(variants.indexOf(variant) + (event.key === 'ArrowRight' ? 1 : 2)) % 3] ?? 'A',
      )
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [variant, onChange])
  if (import.meta.env.PROD) return null
  return (
    <nav className="cp-switcher" aria-label="Prototype variants">
      <span className="cp-switcher-label">Prototype</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous variant"
        onClick={() => onChange(variants[(variants.indexOf(variant) + 2) % 3] ?? 'A')}
      >
        ←
      </Button>
      <span className="cp-switcher-current">
        {variant} · {labels[variant]}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next variant"
        onClick={() => onChange(variants[(variants.indexOf(variant) + 1) % 3] ?? 'A')}
      >
        →
      </Button>
      <span className="cp-switcher-options">
        {variants.map((key) => (
          <Button
            variant="ghost"
            size="icon-sm"
            key={key}
            aria-label={`Variant ${key}`}
            aria-pressed={key === variant}
            onClick={() => onChange(key)}
          >
            {key}
          </Button>
        ))}
      </span>
    </nav>
  )
}
