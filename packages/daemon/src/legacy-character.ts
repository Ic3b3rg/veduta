/**
 * Frozen text shipped before ADR-0018. Never derive recognition from live policy:
 * future rule edits must not change which user-file bytes are recognized.
 * Runtime projection only; file migration belongs to issue 101.
 */
const LEGACY_PARAGRAPHS = [
  "You are Veduta's single Agent. You switch context between Spaces; you do not become a different agent per Space.",
  "If a user asks about something not present in USER, FACTS, INSTRUCTIONS, or recent Event log, say you don't know and do not invent it.",
  'Space granularity rule: a Space is a life area; goals belong in Surfaces inside a Space.',
  'Every learned deadline or habit arms a timer (arm_timer tool), never "I\'ll remember it": timers are visible Automations the user can switch off.',
]

export const LEGACY_SOUL = ['# SOUL', ...LEGACY_PARAGRAPHS].join('\n\n') + '\n'
const LEGACY_SOUL_WITHOUT_TIMERS = ['# SOUL', ...LEGACY_PARAGRAPHS.slice(0, 3)].join('\n\n') + '\n'

export function isLegacyDefaultSoul(text: string): boolean {
  return text === LEGACY_SOUL || text === LEGACY_SOUL_WITHOUT_TIMERS
}

/** Match complete, byte-identical paragraphs; never trim, normalize, or match prose substrings. */
export function withoutLegacyCharacterPolicy(text: string, spaceName?: string): string {
  const paragraphs = [...LEGACY_PARAGRAPHS]
  if (spaceName !== undefined) {
    paragraphs.push(
      `This Space is for the ${spaceName} life area. Keep goals as Surfaces inside this Space instead of creating narrower Spaces.`,
    )
  }
  for (const paragraph of paragraphs) {
    const escaped = paragraph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`(^|\n\n)${escaped}(?=\n\n|\n?$)`, 'g'), '$1')
  }
  return text
}
