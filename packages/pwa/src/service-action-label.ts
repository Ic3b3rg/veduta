const labels: Record<string, string> = {
  list_repositories: 'List repositories',
  list_issues: 'Read open issues',
  read_files: 'Read directories and text files',
  search_mailbox: 'Summarize mail',
  issue_write: 'Create an issue after approval',
}

export function serviceActionLabel(action: string): string {
  return labels[action] ?? action
}
