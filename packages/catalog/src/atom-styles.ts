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
