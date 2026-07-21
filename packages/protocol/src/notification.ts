import { z } from 'zod'

/**
 * A browser Web Push subscription (RFC 8291 / Push API), as returned by
 * `PushManager.subscribe()` and re-posted to the daemon for storage in
 * `push.sqlite` (`PushStore`). `expirationTime` is nullable because browsers
 * serialize an absent expiry as `null`, not `undefined`.
 */
export const PushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .url()
    .refine((value) => value.startsWith('https://'), {
      message: 'endpoint must be an https URL',
    }),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    // A P-256 uncompressed point (65 bytes) base64url-encoded is ~87-88 chars.
    p256dh: z
      .string()
      .min(80)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/, 'p256dh must be base64url-encoded'),
    // A 16-byte auth secret base64url-encoded is ~22 chars.
    auth: z
      .string()
      .min(16)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/, 'auth must be base64url-encoded'),
  }),
})

// Backslashes are rejected because `new URL('/\evil.com/x', base)` treats `\`
// as `/`, so a leading `/\` can resolve cross-origin despite passing a naive
// `startsWith('/')` check. ASCII control characters (charCode < 0x20, e.g.
// `\n`, `\0`) are rejected too, since they can be used to smuggle header or
// protocol injections into whatever eventually consumes this path.
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const UNSAFE_RELATIVE_URL_CHARS = /[\\\x00-\x1f]/

/**
 * The payload a service worker's `push` handler receives. `url` is a
 * same-origin relative deep link (never an absolute URL) so a push can never
 * be used to redirect the client off-origin.
 */
export const PushPayloadSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(400),
  url: z
    .string()
    .max(512)
    .refine(
      (value) =>
        value.startsWith('/') && !value.startsWith('//') && !UNSAFE_RELATIVE_URL_CHARS.test(value),
      {
        message: 'url must be a same-origin relative path',
      },
    ),
})

export type PushSubscription = z.infer<typeof PushSubscriptionSchema>
export type PushPayload = z.infer<typeof PushPayloadSchema>
