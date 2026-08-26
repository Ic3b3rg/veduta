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
    entranceDurationMs: number
    entranceEasing: string
    staggerIntervalMs: number
    updateFeedbackDurationMs: number
  }
}

const motionTokens: CatalogTokens['motion'] = {
  fast: '120ms ease',
  entranceDurationMs: 240,
  entranceEasing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  staggerIntervalMs: 45,
  updateFeedbackDurationMs: 720,
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
    motion: motionTokens,
  },
  dark: {
    mode: 'dark',
    color: {
      surface: '#0f1017',
      surfaceMuted: '#191a23',
      surfaceRaised: '#14151d',
      text: '#f4f4f5',
      textMuted: '#a4a4b0',
      border: '#30313d',
      accent: '#a994ff',
      accentText: '#0b0911',
      success: '#6ee7a8',
      warning: '#f4c56a',
      danger: '#ff8c8c',
      focus: '#b8a7ff',
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
    motion: motionTokens,
  },
}

export function tokensFor(theme: CatalogTheme | undefined): CatalogTokens {
  return catalogTokens[theme ?? 'light']
}
