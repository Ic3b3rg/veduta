import { writeFileAtomicDurable } from './atomic-file.ts'
import { formatFactsMarkdown, type FactRecord, type FactsDocument } from './facts.ts'
import { stripForbiddenUnicode } from './forbidden-unicode.ts'
import { defaultRedactor } from './redaction.ts'
import { isValidOrigin } from './taint.ts'

const SECRET_ERROR =
  'Secrets cannot be stored in FACTS. Remove the credential and try the write again.'

/** Sanitizes and validates one proposed fact before the Curator compares it. */
export function prepareFactTextForWrite(factText: string): string {
  const sanitized = prepareString(factText)
  if (!sanitized.trim())
    throw new Error('fact text is required after forbidden Unicode sanitization')
  return sanitized
}

/** Sanitizes and validates every record without changing section or record order. */
export function prepareFactsDocument(document: FactsDocument): FactsDocument {
  return {
    active: document.active.map(prepareFactRecord),
    dormant: document.dormant.map(prepareFactRecord),
    superseded: document.superseded.map(prepareFactRecord),
  }
}

/** The only production replacement path for an existing FACTS.md document. */
export function persistFactsDocument(
  path: string,
  document: FactsDocument,
  fallbackDate: string,
): FactsDocument {
  const prepared = prepareFactsDocument(document)
  const markdown = formatFactsMarkdown(prepared, fallbackDate)
  writeFileAtomicDurable(path, Buffer.from(markdown, 'utf8'))
  return prepared
}

function prepareFactRecord(fact: FactRecord): FactRecord {
  const text = prepareFactTextForWrite(fact.text)
  const noted = prepareOptionalString(fact.noted)
  const dormantAt = prepareOptionalString(fact.dormantAt)
  const supersededAt = prepareOptionalString(fact.supersededAt)
  const supersededBy = prepareOptionalString(fact.supersededBy)
  const originText = prepareOptionalString(fact.origin)
  if (originText !== undefined && !isValidOrigin(originText)) {
    throw new Error('FACTS origin is invalid after forbidden Unicode sanitization')
  }

  return {
    text,
    ...(noted === undefined ? {} : { noted }),
    ...(dormantAt === undefined ? {} : { dormantAt }),
    ...(supersededAt === undefined ? {} : { supersededAt }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(originText === undefined ? {} : { origin: originText }),
  }
}

function prepareOptionalString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : prepareString(value)
}

function prepareString(value: string): string {
  const sanitized = stripForbiddenUnicode(value)
  if (defaultRedactor.redactText(sanitized) !== sanitized) throw new Error(SECRET_ERROR)
  return sanitized
}
