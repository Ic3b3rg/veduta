import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Runtime data may contain Codex plugin fixtures named `*.test.*`; they are never Veduta tests.
    exclude: [...configDefaults.exclude, '**/.veduta/**'],
  },
})
