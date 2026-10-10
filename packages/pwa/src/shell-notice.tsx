import { useEffect, useRef, type ComponentProps } from 'react'
import { X } from 'lucide-react'
import { Button } from '@veduta/catalog/ui/button'

interface ShellNoticeProps extends Omit<ComponentProps<'div'>, 'children'> {
  message: string
  dismissLabel: string
  onDismiss: () => void
}

/** In-flow feedback: long text shares the content region's scroll, not a tiny inner viewport. */
export function ShellNotice({
  message,
  dismissLabel,
  onDismiss,
  className = '',
  ...props
}: ShellNoticeProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' })
  }, [message])
  return (
    <div {...props} ref={ref} className={`shell-notice ${className}`}>
      <p>{message}</p>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shell-notice-dismiss"
        aria-label={dismissLabel}
        title={dismissLabel}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  )
}
