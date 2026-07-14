import { join } from 'node:path'
import { SecretsVault, resolveVaultKeyMaterial } from './secrets-vault.ts'

/** `pnpm --filter @veduta/daemon vault <set <name> <value>|list|delete <name>>`. */
function main(): void {
  const [command, name, value] = process.argv.slice(2)
  const rootDir = process.env['VEDUTA_DATA_DIR'] ?? join(process.cwd(), '.veduta')

  const keyMaterial = resolveVaultKeyMaterial()
  if (!keyMaterial) {
    console.error(
      'no vault key material found; set VEDUTA_VAULT_KEYFILE (path to a keyfile) or VEDUTA_VAULT_KEY',
    )
    process.exitCode = 1
    return
  }

  try {
    const vault = SecretsVault.open(rootDir, keyMaterial)
    if (command === 'list') {
      for (const entryName of vault.list()) console.log(entryName)
      return
    }
    if (command === 'set') {
      if (!name || value === undefined) {
        console.error('usage: vault set <name> <value>')
        process.exitCode = 1
        return
      }
      vault.set(name, value)
      console.log(`stored ${name}`)
      return
    }
    if (command === 'delete') {
      if (!name) {
        console.error('usage: vault delete <name>')
        process.exitCode = 1
        return
      }
      console.log(vault.delete(name) ? `deleted ${name}` : `${name} was not set`)
      return
    }
    console.error('usage: vault <set <name> <value>|list|delete <name>>')
    process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] && process.argv[1].endsWith('vault-cli.ts')) main()
