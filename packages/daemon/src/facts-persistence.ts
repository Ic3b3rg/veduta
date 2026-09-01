import { randomBytes } from 'node:crypto'
import { linkSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomicDurable } from './atomic-file.ts'
import {
  formatFactsMarkdown,
  parseFactsMarkdown,
  type FactRecord,
  type FactsDocument,
} from './facts.ts'
import { stripForbiddenUnicode } from './forbidden-unicode.ts'
import { defaultRedactor } from './redaction.ts'
import { isValidOrigin } from './taint.ts'

const SECRET_ERROR =
  'Secrets cannot be stored in FACTS. Remove the credential and try the write again.'

/** Sanitizes and validates one proposed fact before the Curator compares it. */
export function sanitizeAndValidateFactText(factText: string): string {
  const sanitized = sanitizeAndRejectSecrets(factText)
  if (!sanitized.trim())
    throw new Error('fact text is required after forbidden Unicode sanitization')
  return sanitized
}

/** Sanitizes raw Markdown before headings, metadata, or origins are interpreted. */
export function parseSanitizedFactsMarkdown(markdown: string): FactsDocument {
  return parseFactsMarkdown(stripForbiddenUnicode(markdown))
}

/** Sanitizes and rejects secrets before parsing a document that will be rewritten. */
export function readFactsDocumentForRewrite(path: string): FactsDocument {
  const sanitized = sanitizeAndRejectSecrets(readFileSync(path, 'utf8'))
  return parseFactsMarkdown(sanitized)
}

/** Sanitizes and validates every record without changing section or record order. */
export function sanitizeAndValidateFactsDocument(document: FactsDocument): FactsDocument {
  return {
    active: document.active.map(sanitizeAndValidateFactRecord),
    dormant: document.dormant.map(sanitizeAndValidateFactRecord),
    superseded: document.superseded.map(sanitizeAndValidateFactRecord),
  }
}

/** The only production replacement path for an existing FACTS.md document. */
export function persistFactsDocument(
  path: string,
  document: FactsDocument,
  fallbackDate: string,
): FactsDocument {
  const validated = sanitizeAndValidateFactsDocument(document)
  const markdown = formatFactsMarkdown(validated, fallbackDate)
  replaceFactsBytes(path, Buffer.from(markdown, 'utf8'))
  return validated
}

function sanitizeAndValidateFactRecord(fact: FactRecord): FactRecord {
  const text = sanitizeAndValidateFactText(fact.text)
  const noted = sanitizeOptionalText(fact.noted)
  const dormantAt = sanitizeOptionalText(fact.dormantAt)
  const supersededAt = sanitizeOptionalText(fact.supersededAt)
  const supersededBy = sanitizeOptionalText(fact.supersededBy)
  const originText = sanitizeOptionalText(fact.origin)
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

function sanitizeOptionalText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeAndRejectSecrets(value)
}

function sanitizeAndRejectSecrets(value: string): string {
  const sanitized = stripForbiddenUnicode(value)
  if (defaultRedactor.redactText(sanitized) !== sanitized) throw new Error(SECRET_ERROR)
  return sanitized
}

/**
 * Keeps a hard link to the previous inode until the durable replacement has
 * completed. If the atomic writer reports a late parent-directory sync
 * failure after rename, restoring that link makes the reported failure
 * byte-preserving too.
 */
function replaceFactsBytes(path: string, content: Buffer): void {
  const rollbackPath = join(
    dirname(path),
    `.${basename(path)}.rollback-${randomBytes(6).toString('hex')}`,
  )
  linkSync(path, rollbackPath)
  let failure: unknown
  try {
    writeFileAtomicDurable(path, content)
  } catch (error) {
    failure = error
  }

  if (failure === undefined) {
    try {
      rmSync(rollbackPath, { force: true })
      return
    } catch (error) {
      failure = error
    }
  }

  try {
    renameSync(rollbackPath, path)
    rmSync(rollbackPath, { force: true })
  } catch (rollbackError) {
    throw new AggregateError(
      [failure, rollbackError],
      'FACTS replacement failed and the previous bytes could not be restored',
    )
  }
  throw failure
}
