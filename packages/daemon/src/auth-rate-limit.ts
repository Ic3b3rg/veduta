export interface LockoutCheck {
  allowed: boolean
  retryAfterSeconds: number
}

export interface ProgressiveAuthLockoutOptions {
  now?: () => Date
  failureThreshold?: number
}

interface LockoutRecord {
  failures: number
  lockedUntil?: string
}

export class ProgressiveAuthLockout {
  private records = new Map<string, LockoutRecord>()
  private now: () => Date
  private failureThreshold: number

  constructor(options: ProgressiveAuthLockoutOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.failureThreshold = options.failureThreshold ?? 3
  }

  check(key: string): LockoutCheck {
    const record = this.records.get(key)
    if (!record?.lockedUntil) return { allowed: true, retryAfterSeconds: 0 }
    const retryAfterSeconds = Math.ceil(
      (Date.parse(record.lockedUntil) - this.now().getTime()) / 1000,
    )
    if (retryAfterSeconds <= 0) return { allowed: true, retryAfterSeconds: 0 }
    return { allowed: false, retryAfterSeconds }
  }

  recordFailure(key: string): void {
    const record = this.records.get(key) ?? { failures: 0 }
    record.failures += 1
    if (record.failures >= this.failureThreshold) {
      const steps = record.failures - this.failureThreshold
      const seconds = Math.min(300, 2 ** steps * 30)
      record.lockedUntil = new Date(this.now().getTime() + seconds * 1000).toISOString()
    }
    this.records.set(key, record)
  }

  recordSuccess(key: string): void {
    this.records.delete(key)
  }
}
