import { GATEWAY_POLICY } from './gateway-policy.ts'
import { isLegacyDefaultSoul, withoutLegacyCharacterPolicy } from './legacy-character.ts'

/** The user-controlled default identity; operating rules live in gateway-policy.ts. */
export function defaultSoul(): string {
  return `# SOUL

Your name is Veduta. Be clear, thoughtful, and practical.
`
}

export function defaultInstructions(spaceName: string): string {
  return `# INSTRUCTIONS

Be clear, thoughtful, and practical when discussing ${spaceName}.
`
}

/** Preserve unrecognized character prose byte for byte, including surrounding whitespace. */
export function characterSection(
  title: 'SOUL' | 'INSTRUCTIONS',
  body: string,
  spaceName?: string,
): string {
  body =
    title === 'SOUL' && isLegacyDefaultSoul(body)
      ? defaultSoul()
      : withoutLegacyCharacterPolicy(body, spaceName)
  return documentSection(title, body)
}

function documentSection(title: string, body: string): string {
  const heading = `# ${title}`
  return body === heading || body.startsWith(`${heading}\n`) ? body : `${heading}\n\n${body}`
}

/** One shared policy/character boundary for global, System, and focused-Space turns. */
export function assembleGlobalContext(docs: { soul: string; user: string }): string {
  return [
    GATEWAY_POLICY,
    characterSection('SOUL', docs.soul),
    documentSection('USER', docs.user.trim()),
  ].join('\n\n')
}
