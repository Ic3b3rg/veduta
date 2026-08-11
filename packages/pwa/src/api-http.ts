/** Shared authenticated JSON transport for PWA API modules. */
export function authHeaders(token: string | undefined): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {}
}

export async function getJson(path: string, token?: string): Promise<unknown> {
  return requestJson(path, { headers: authHeaders(token) })
}

export async function postJson(path: string, body: unknown, token?: string): Promise<unknown> {
  return requestJson(path, jsonRequest('POST', body, token))
}

export async function patchJson(path: string, body: unknown, token?: string): Promise<unknown> {
  return requestJson(path, jsonRequest('PATCH', body, token))
}

export async function deleteJson(path: string, token?: string): Promise<unknown> {
  return requestJson(path, { method: 'DELETE', headers: authHeaders(token) })
}

function jsonRequest(method: 'POST' | 'PATCH', body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, init)
  if (!response.ok) return throwForResponse(response, path)
  return response.json()
}

/** Signals that a stale PWA tab called an API removed during an upgrade. */
export class ReloadRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReloadRequiredError'
  }
}

/** An API failure whose HTTP status remains available to session handling. */
export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiResponseError'
  }
}

async function throwForResponse(response: Response, path: string): Promise<never> {
  const message = await errorMessageFromResponse(response, path)
  if (response.status === 410) throw new ReloadRequiredError(message)
  throw new ApiResponseError(message, response.status)
}

async function errorMessageFromResponse(response: Response, path: string): Promise<string> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return errorMessageFromBody(response.status, path, body)
}

/** Renders daemon error bodies into a compact, actionable message. */
export function errorMessageFromBody(status: number, path: string, body: unknown): string {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record['error'] === 'string' && record['error'].length > 0) {
      return record['error']
    }
    if (Array.isArray(record['error'])) {
      const rendered = renderZodIssues(record['error'])
      if (rendered.length > 0) return `${path} failed: ${rendered}`
    }
    if (Array.isArray(record['issues'])) {
      const rendered = renderZodIssues(record['issues'])
      if (rendered.length > 0) return `${path} failed: ${rendered}`
    }
  }
  return `${path} failed: ${status}`
}

function renderZodIssues(issues: unknown[]): string {
  return issues
    .map(renderZodIssue)
    .filter((message) => message.length > 0)
    .join('; ')
}

function renderZodIssue(issue: unknown): string {
  if (issue === null || typeof issue !== 'object') return ''
  const record = issue as Record<string, unknown>
  const message = typeof record['message'] === 'string' ? record['message'] : ''
  if (message.length === 0) return ''
  const path = Array.isArray(record['path']) ? record['path'].join('.') : ''
  return path.length > 0 ? `${path}: ${message}` : message
}
