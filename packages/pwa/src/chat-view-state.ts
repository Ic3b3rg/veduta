interface ChatViewSnapshot {
  draft: string
  scrollTop: number | undefined
  followsLatest: boolean
  anchorLatestTurn: boolean
}

/** Local presentation retained across rail/Sheet mounts; no Chat or decision authority. */
export function createChatViewState() {
  let snapshot: ChatViewSnapshot = {
    draft: '',
    scrollTop: undefined,
    followsLatest: true,
    anchorLatestTurn: false,
  }
  return {
    getSnapshot: (): Readonly<ChatViewSnapshot> => snapshot,
    remember: (changes: Partial<ChatViewSnapshot>): void => {
      snapshot = { ...snapshot, ...changes }
    },
  }
}

export type ChatViewState = ReturnType<typeof createChatViewState>
