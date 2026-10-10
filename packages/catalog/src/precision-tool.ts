import { cssVariablesFor } from './css-variables.ts'

/** Shared opt-in recipes; legacy consumers migrate under the #157 implementation graph. */
export function precisionToolCssText(): string {
  const dark = Object.entries(cssVariablesFor('dark'))
    .map(([name, value]) => `${name}: ${value};`)
    .join('\n')
  return `
.precision-tool {
  ${dark}
  --text: var(--catalog-color-text);
  --text-muted: var(--catalog-color-text-muted);
  --text-soft: var(--catalog-color-text-muted);
  --surface: var(--catalog-color-surface-raised);
  --border: var(--catalog-color-border);
  --border-strong: var(--catalog-color-border);
  --accent: var(--catalog-color-accent);
  --accent-text: var(--catalog-color-accent-text);
  --accent-soft: var(--catalog-color-accent);
  --accent-soft-bg: color-mix(in srgb, var(--catalog-color-accent) 14%, var(--catalog-color-surface));
  --focus: var(--catalog-color-focus);
  --page-bg: var(--catalog-color-surface);
  --pill-bg: var(--catalog-color-surface-muted);
  --glass-panel: var(--catalog-color-surface);
  --glass-panel-raised: var(--catalog-color-surface-raised);
  --glass-border: var(--catalog-color-border);
  --glass-highlight: var(--catalog-color-border);
  --glass-blur: 0px;
  --chat-dock-bg: var(--catalog-color-surface-raised);
  --surface-shadow: transparent;
  --chat-dock-shadow: transparent;
  --success-text: var(--catalog-color-success);
  --success-bg: var(--catalog-color-surface-muted);
  --success-border: var(--catalog-color-success);
  --warning-text: var(--catalog-color-warning);
  --warning-bg: var(--catalog-color-surface-muted);
  --warning-border: var(--catalog-color-warning);
  --danger-text: var(--catalog-color-danger);
  --danger-bg: var(--catalog-color-surface-muted);
  --danger-border: var(--catalog-color-danger);
  color-scheme: dark;
  background: var(--catalog-color-surface);
  color: var(--catalog-color-text);
  font-family: var(--catalog-font-family);
  font-size: var(--catalog-font-md);
  line-height: 1.45;
}
.precision-tool .recipe-surface {
  background: var(--catalog-color-surface-raised);
  border: 1px solid var(--catalog-color-border);
  border-radius: var(--catalog-radius-md);
  color: var(--catalog-color-text);
  padding: var(--catalog-space-lg);
  min-width: 0;
}
.precision-tool .recipe-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--catalog-space-sm);
  min-height: var(--catalog-control-height);
  max-width: 100%;
  border: 1px solid var(--catalog-color-border);
  border-radius: var(--catalog-radius-sm);
  padding: var(--catalog-space-xs) var(--catalog-space-md);
  background: var(--catalog-color-surface-muted);
  color: var(--catalog-color-text);
  font: inherit;
  font-size: var(--catalog-font-sm);
  font-weight: 600;
  white-space: normal;
  box-shadow: none;
}
.precision-tool .recipe-control[data-variant='primary'] {
  background: var(--catalog-color-accent);
  color: var(--catalog-color-accent-text);
  border-color: var(--catalog-color-accent);
}
.precision-tool .recipe-control:disabled { opacity: 0.6; cursor: not-allowed; }
.precision-tool .recipe-input {
  min-height: var(--catalog-control-height);
  min-width: 0;
  width: 100%;
  border: 1px solid var(--catalog-color-border);
  border-radius: var(--catalog-radius-sm);
  background: var(--catalog-color-surface);
  color: var(--catalog-color-text);
  padding: var(--catalog-space-sm);
  font: inherit;
  box-shadow: none;
}
.precision-tool .recipe-menu,
.precision-tool .recipe-overlay {
  background: var(--catalog-color-surface-raised);
  color: var(--catalog-color-text);
  border: 1px solid var(--catalog-color-border);
  border-radius: var(--catalog-radius-md);
  padding: var(--catalog-space-sm);
  max-width: 100%;
}
.precision-tool .recipe-overlay { padding: var(--catalog-space-lg); }
.precision-tool .recipe-status {
  display: inline-flex;
  align-items: baseline;
  gap: var(--catalog-space-xs);
  border-left: 2px solid currentColor;
  padding-left: var(--catalog-space-sm);
  color: var(--catalog-color-text-muted);
  font-size: var(--catalog-font-sm);
  font-variant-numeric: tabular-nums;
}
.precision-tool .recipe-status[data-tone='success'] { color: var(--catalog-color-success); }
.precision-tool .recipe-status[data-tone='warning'],
.precision-tool .recipe-status[data-tone='attention'] { color: var(--catalog-color-warning); }
.precision-tool .recipe-status[data-tone='danger'] { color: var(--catalog-color-danger); }
.precision-tool .recipe-status[data-tone='pending'] { color: var(--catalog-color-accent); }
.precision-tool .recipe-focus:focus-visible,
.precision-tool .recipe-control:focus-visible,
.precision-tool .recipe-input:focus-visible {
  outline: var(--catalog-control-focus-width) solid var(--catalog-color-focus);
  outline-offset: var(--catalog-control-focus-offset);
}
.precision-tool .recipe-motion {
  transition: opacity var(--catalog-motion-fast), border-color var(--catalog-motion-fast);
}
@media (pointer: coarse) {
  .precision-tool .recipe-control,
  .precision-tool .recipe-input {
    min-height: var(--catalog-control-touch-target);
  }
  .precision-tool .recipe-control { min-width: var(--catalog-control-touch-target); }
}
@media (prefers-reduced-motion: reduce) {
  .precision-tool .recipe-motion { transition: none; animation: none; }
}
`
}
