import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

/** Watches containing directories so atomic file replacement does not detach observation. */
export class CharacterDocumentObserver {
  private readonly watchers = new Map<string, FSWatcher>()
  private directories = new Map<string, Set<string>>()
  private disposed = false

  constructor(
    private readonly paths: () => string[],
    private readonly changed: () => void,
  ) {}

  reconcile(): void {
    if (this.disposed) return
    const directories = new Map<string, Set<string>>()
    for (const path of this.paths()) {
      const directory = dirname(path)
      const names = directories.get(directory) ?? new Set<string>()
      names.add(basename(path))
      directories.set(directory, names)
    }
    this.directories = directories
    for (const [directory, watcher] of this.watchers) {
      if (directories.has(directory)) continue
      this.watchers.delete(directory)
      watcher.close()
    }
    for (const directory of directories.keys()) {
      if (this.watchers.has(directory)) continue
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (this.disposed || this.watchers.get(directory) !== watcher) return
          if (filename !== null && !this.directories.get(directory)?.has(filename)) return
          try {
            this.changed()
          } catch (error) {
            console.error('character document observer failed', error)
          }
        })
        watcher.on('error', (error) => {
          if (this.disposed || this.watchers.get(directory) !== watcher) return
          this.watchers.delete(directory)
          watcher.close()
          console.error('character document watch failed; snapshot reads will reconcile', error)
        })
        this.watchers.set(directory, watcher)
      } catch (error) {
        console.error('character document watch unavailable; snapshot reads will reconcile', error)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.directories.clear()
  }
}
