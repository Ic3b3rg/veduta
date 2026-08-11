/** Human-readable Surface freshness (ADR-0005). */
export function freshnessLabel(updatedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(updatedAt)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

/** Human-readable approval expiry. */
export function expiresInLabel(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now
  if (ms <= 0) return 'expired'
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `expires in ${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `expires in ${hours}h` : `expires in ${Math.round(hours / 24)}d`
}
