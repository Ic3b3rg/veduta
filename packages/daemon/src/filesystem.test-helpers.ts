import { chmodSync } from 'node:fs'

export async function withDirectoryMode<T>(
  path: string,
  mode: number,
  operation: () => T | Promise<T>,
): Promise<T> {
  chmodSync(path, mode)
  try {
    return await operation()
  } finally {
    chmodSync(path, 0o700)
  }
}
