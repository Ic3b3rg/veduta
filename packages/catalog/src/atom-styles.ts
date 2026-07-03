import type { CSSProperties } from 'react'
import type { CatalogTokens } from './design-system.ts'

export function surfaceStyle(tokens: CatalogTokens): CSSProperties {
  return {
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    color: tokens.color.text,
    fontFamily: tokens.font.family,
  }
}

export function bodyTextStyle(tokens: CatalogTokens): CSSProperties {
  return {
    color: tokens.color.text,
    fontFamily: tokens.font.family,
    fontSize: tokens.font.md,
    lineHeight: 1.45,
    margin: 0,
  }
}

export function labelStyle(tokens: CatalogTokens): CSSProperties {
  return {
    color: tokens.color.textMuted,
    fontFamily: tokens.font.family,
    fontSize: tokens.font.xs,
    fontWeight: 650,
    letterSpacing: 0,
    lineHeight: 1.3,
  }
}

export function controlStyle(tokens: CatalogTokens): CSSProperties {
  return {
    background: tokens.color.surfaceRaised,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    color: tokens.color.text,
    font: `${tokens.font.md}px ${tokens.font.family}`,
    minHeight: 40,
    outlineColor: tokens.color.focus,
    padding: `${tokens.space.sm}px ${tokens.space.md}px`,
    width: '100%',
  }
}

export function fieldStyle(tokens: CatalogTokens): CSSProperties {
  return {
    color: tokens.color.text,
    display: 'grid',
    gap: tokens.space.xs,
    minWidth: 160,
  }
}

export function inlineControlStyle(tokens: CatalogTokens): CSSProperties {
  return {
    alignItems: 'center',
    color: tokens.color.text,
    display: 'inline-flex',
    fontFamily: tokens.font.family,
    fontSize: tokens.font.md,
    gap: tokens.space.sm,
    minHeight: 40,
  }
}

export function buttonStyle(
  tokens: CatalogTokens,
  variant: string | undefined,
  disabled: boolean,
): CSSProperties {
  const subtle = variant === 'secondary' || variant === 'ghost'
  return {
    background: subtle ? tokens.color.surfaceMuted : tokens.color.accent,
    border: `1px solid ${subtle ? tokens.color.border : tokens.color.accent}`,
    borderRadius: tokens.radius.sm,
    color: subtle ? tokens.color.text : tokens.color.accentText,
    cursor: disabled ? 'not-allowed' : 'pointer',
    font: `650 ${tokens.font.md}px ${tokens.font.family}`,
    minHeight: 40,
    opacity: disabled ? 0.55 : 1,
    outlineColor: tokens.color.focus,
    padding: `${tokens.space.sm}px ${tokens.space.lg}px`,
  }
}

export function tableHeaderStyle(tokens: CatalogTokens): CSSProperties {
  return {
    borderBottom: `1px solid ${tokens.color.border}`,
    color: tokens.color.textMuted,
    fontFamily: tokens.font.family,
    fontSize: tokens.font.xs,
    padding: `${tokens.space.sm}px`,
    textAlign: 'left',
  }
}

export function tableCellStyle(tokens: CatalogTokens): CSSProperties {
  return {
    borderBottom: `1px solid ${tokens.color.border}`,
    color: tokens.color.text,
    fontFamily: tokens.font.family,
    fontSize: tokens.font.sm,
    padding: `${tokens.space.sm}px`,
  }
}

export function listItemStyle(tokens: CatalogTokens): CSSProperties {
  return {
    alignItems: 'center',
    background: tokens.color.surfaceRaised,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    color: tokens.color.text,
    display: 'flex',
    gap: tokens.space.md,
    justifyContent: 'space-between',
    minHeight: 48,
    padding: tokens.space.md,
  }
}

export function switchStyle(tokens: CatalogTokens, enabled: boolean): CSSProperties {
  return {
    alignItems: 'center',
    background: enabled ? tokens.color.accent : tokens.color.surfaceMuted,
    border: `1px solid ${enabled ? tokens.color.accent : tokens.color.border}`,
    borderRadius: 999,
    cursor: 'pointer',
    display: 'inline-flex',
    height: 28,
    justifyContent: enabled ? 'flex-end' : 'flex-start',
    minWidth: 48,
    outlineColor: tokens.color.focus,
    padding: 2,
  }
}

export function switchKnobStyle(tokens: CatalogTokens, enabled: boolean): CSSProperties {
  return {
    background: enabled ? tokens.color.accentText : tokens.color.textMuted,
    borderRadius: 999,
    display: 'block',
    height: 22,
    width: 22,
  }
}
