import type { ChatScope, ChatTimelineEntry, ChatTimelinePage } from '@veduta/protocol'

interface ScopeState {
  entries: Map<string, ChatTimelineEntry>
  nextBefore: string | undefined
  latestLoaded: boolean
}

/** Disposable view of Gateway-owned Chat history. No browser storage participates. */
export class ChatTimelineProjection {
  private readonly scopes = new Map<string, ScopeState>()

  observe(entry: ChatTimelineEntry): void {
    const state = this.state(entry.scope)
    const previous = state.entries.get(entry.id)
    if (!previous || entry.revision > previous.revision) state.entries.set(entry.id, entry)
  }

  mergePage(scope: ChatScope, page: ChatTimelinePage, before?: string): void {
    const state = this.state(scope)
    for (const entry of page.entries) {
      if (scopeKey(entry.scope) !== scopeKey(scope)) continue
      this.observe(entry)
    }
    if (before === undefined) {
      if (!state.latestLoaded) {
        state.nextBefore = page.nextBefore
        state.latestLoaded = true
      }
    } else if (state.nextBefore === before) {
      state.nextBefore = page.nextBefore
    }
  }

  entries(scope: ChatScope): ChatTimelineEntry[] {
    return [...this.state(scope).entries.values()].sort((a, b) => a.position - b.position)
  }

  nextBefore(scope: ChatScope): string | undefined {
    return this.state(scope).nextBefore
  }

  loaded(scope: ChatScope): boolean {
    return this.state(scope).latestLoaded
  }

  clear(): void {
    this.scopes.clear()
  }

  private state(scope: ChatScope): ScopeState {
    const key = scopeKey(scope)
    let state = this.scopes.get(key)
    if (!state) {
      state = { entries: new Map(), nextBefore: undefined, latestLoaded: false }
      this.scopes.set(key, state)
    }
    return state
  }
}

export function scopeKey(scope: ChatScope): string {
  return scope.type === 'global' ? 'global' : `space:${scope.spaceId}`
}
