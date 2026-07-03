export type CatalogTheme = 'light' | 'dark'

export interface CatalogTokens {
  mode: CatalogTheme
  color: {
    surface: string
    surfaceMuted: string
    surfaceRaised: string
    text: string
    textMuted: string
    border: string
    accent: string
    accentText: string
    success: string
    warning: string
    danger: string
    focus: string
  }
  space: {
    xs: number
    sm: number
    md: number
    lg: number
    xl: number
  }
  radius: {
    sm: number
    md: number
  }
  font: {
    family: string
    xs: number
    sm: number
    md: number
    lg: number
    xl: number
  }
  motion: {
    fast: string
  }
}

export const catalogTokens: Record<CatalogTheme, CatalogTokens> = {
  light: {
    mode: 'light',
    color: {
      surface: '#ffffff',
      surfaceMuted: '#f6f7f9',
      surfaceRaised: '#ffffff',
      text: '#18202b',
      textMuted: '#657080',
      border: '#d8dee8',
      accent: '#246b58',
      accentText: '#ffffff',
      success: '#1f7a4d',
      warning: '#9a6200',
      danger: '#b42318',
      focus: '#0b6fcb',
    },
    space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
    radius: { sm: 4, md: 8 },
    font: {
      family:
        'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      xs: 12,
      sm: 13,
      md: 15,
      lg: 18,
      xl: 24,
    },
    motion: { fast: '120ms ease' },
  },
  dark: {
    mode: 'dark',
    color: {
      surface: '#11161d',
      surfaceMuted: '#1b222c',
      surfaceRaised: '#151b24',
      text: '#eef3f7',
      textMuted: '#a7b0bd',
      border: '#303a49',
      accent: '#74c7a2',
      accentText: '#07110d',
      success: '#7bd59f',
      warning: '#e4b55d',
      danger: '#ff8a80',
      focus: '#85bfff',
    },
    space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
    radius: { sm: 4, md: 8 },
    font: {
      family:
        'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      xs: 12,
      sm: 13,
      md: 15,
      lg: 18,
      xl: 24,
    },
    motion: { fast: '120ms ease' },
  },
}

export function tokensFor(theme: CatalogTheme | undefined): CatalogTokens {
  return catalogTokens[theme ?? 'light']
}
