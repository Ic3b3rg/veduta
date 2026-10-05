import type { ReactNode } from 'react'

export function ConnectionsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="connections-section">
      <header className="connections-heading">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {actions}
      </header>
      {children}
    </section>
  )
}
