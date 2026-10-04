export function PrototypeIcon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    services: 'M8 8h8v8H8z M12 3v5 M12 16v5 M3 12h5 M16 12h5',
    models: 'M12 3l8 5v8l-8 5-8-5V8z M4 8l8 5 8-5 M12 13v8',
    extensions:
      'M4 4h6v3a2 2 0 0 0 4 0V4h6v6h-3a2 2 0 0 0 0 4h3v6h-6v-3a2 2 0 0 0-4 0v3H4v-6h3a2 2 0 0 0 0-4H4z',
    access: 'M12 3l8 4v5c0 5-8 9-8 9S4 17 4 12V7z M8 12l3 3 5-6',
    back: 'M19 12H5 M11 6l-6 6 6 6',
    arrow: 'M5 12h14 M13 6l6 6-6 6',
    plus: 'M12 5v14 M5 12h14',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
    check: 'M5 12l4 4L19 6',
    close: 'M6 6l12 12 M6 18L18 6',
    book: 'M4 4h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H4z M13 7a3 3 0 0 1 3-3h5v14h-5a3 3 0 0 0-3 3',
    globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c-5 4-5 14 0 18 M12 3c5 4 5 14 0 18',
    alert: 'M12 3l10 18H2z M12 9v5 M12 17v1',
    mail: 'M3 5h18v14H3z M3 6l9 7 9-7',
    menu: 'M4 6h16 M4 12h16 M4 18h16',
    key: 'M9 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12 M13 13l8 8 M17 17l3-3',
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.models} />
    </svg>
  )
}

export function ProviderMark({ id }: { id: string }) {
  if (id === 'gmail')
    return (
      <span className="cp-provider cp-provider-gmail" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <path
            d="M5 24V9l11 8L27 9v15"
            fill="none"
            stroke="#d84a3b"
            strokeWidth="5"
            strokeLinejoin="round"
          />
          <path d="M5 10v14" stroke="#4385e9" strokeWidth="5" />
          <path d="M27 10v14" stroke="#3f9b67" strokeWidth="5" />
        </svg>
      </span>
    )
  if (id.startsWith('github'))
    return (
      <span className="cp-provider cp-provider-github" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1.01.07 1.54 1.03 1.54 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.99 1.03-2.69-.1-.26-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0 1 12 6.82c.85 0 1.71.11 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.39.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.58 4.94.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
        </svg>
      </span>
    )
  return (
    <span className={`cp-provider cp-provider-${id}`} aria-hidden="true">
      <PrototypeIcon
        name={
          id === 'mail'
            ? 'mail'
            : id.includes('skill')
              ? 'book'
              : id === 'anthropic' || id === 'openai'
                ? 'key'
                : 'models'
        }
        size={26}
      />
    </span>
  )
}
