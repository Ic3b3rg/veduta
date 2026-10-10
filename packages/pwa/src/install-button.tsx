import type { BrowserInstallPromptEvent } from './pwa-storage.ts'
import { Button } from '@veduta/catalog/ui/button'
import { Download } from 'lucide-react'

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
    <Button
      className="install-button recipe-control utility-control"
      data-variant="primary"
      aria-label="Install"
      title="Install Veduta"
      onClick={() => void run()}
    >
      <Download aria-hidden="true" />
    </Button>
  )
}
