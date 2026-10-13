import { statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

/** Watches containing directories so atomic file replacement does not detach observation. */
export class CharacterDocumentObserver {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly retryAfter = new Map<string, number>()
  private directories = new Map<string, Set<string>>()
  private disposed = false
  private readonly signatures = new Map<string, string>()
  private pending = false
  private readonly fallback: ReturnType<typeof setInterval>

  constructor(
    private readonly paths: () => string[],
    private readonly changed: () => void,
  ) {
    // Lifecycle-owned stat fallback also detects missing fs.watch events; it never runs on reads.
    this.fallback = setInterval(() => this.checkChanges(), 1000)
    this.fallback.unref?.()
  }

  reconcile(): void {
    if (this.disposed) return
    const directories = new Map<string, Set<string>>()
    const observed = new Set(this.paths())
    for (const path of observed) {
      const directory = dirname(path)
      const names = directories.get(directory) ?? new Set<string>()
      names.add(basename(path))
      directories.set(directory, names)
    }
    for (const path of this.signatures.keys()) {
      if (!observed.has(path)) this.signatures.delete(path)
    }
    for (const path of observed) {
      if (!this.signatures.has(path)) this.signatures.set(path, this.signature(path))
    }
    for (const directory of this.retryAfter.keys()) {
      if (!directories.has(directory)) this.retryAfter.delete(directory)
    }
    this.directories = directories
    for (const [directory, watcher] of this.watchers) {
      if (directories.has(directory)) continue
      this.watchers.delete(directory)
      watcher.close()
    }
    for (const directory of directories.keys()) {
      if (this.watchers.has(directory) || (this.retryAfter.get(directory) ?? 0) > Date.now())
        continue
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (this.disposed || this.watchers.get(directory) !== watcher) return
          if (filename !== null && !this.directories.get(directory)?.has(filename)) return
          this.pending = true
          this.deliverChange()
        })
        watcher.on('error', (error) => {
          if (this.disposed || this.watchers.get(directory) !== watcher) return
          this.watchers.delete(directory)
          watcher.close()
          this.retryAfter.set(directory, Date.now() + 60_000)
          console.error(
            'character document watch failed; lifecycle stat fallback remains active',
            error,
          )
        })
        this.watchers.set(directory, watcher)
        this.retryAfter.delete(directory)
      } catch (error) {
        this.retryAfter.set(directory, Date.now() + 60_000)
        console.error(
          'character document watch unavailable; lifecycle stat fallback remains active',
          error,
        )
      }
    }
  }

  private signature(path: string): string {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false })
    return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : 'missing'
  }

  private checkChanges(): void {
    if (this.disposed) return
    try {
      this.reconcile()
      if ([...this.signatures].some(([path, previous]) => this.signature(path) !== previous))
        this.pending = true
      if (this.pending) this.deliverChange()
    } catch (error) {
      console.error('character document stat fallback failed', error)
    }
  }

  private deliverChange(): void {
    try {
      this.changed()
      for (const path of this.signatures.keys()) this.signatures.set(path, this.signature(path))
      this.pending = false
    } catch (error) {
      // Keep the update pending so a failed projection is retried by the same lifecycle fallback.
      console.error('character document observer failed', error)
    }
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.fallback)
    this.signatures.clear()
    this.retryAfter.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.directories.clear()
  }
}
