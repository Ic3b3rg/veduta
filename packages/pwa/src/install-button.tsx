import type { BrowserInstallPromptEvent } from './pwa-storage.ts'

export function InstallButton({
  prompt,
  onDone,
}: {
  prompt: BrowserInstallPromptEvent | null
  onDone: () => void
}) {
  const run = async () => {
    if (prompt) {
      await prompt.prompt()
      await prompt.userChoice
    }
    onDone()
  }

  return (
    <button type="button" className="install-button" onClick={() => void run()}>
      Install
    </button>
  )
}
