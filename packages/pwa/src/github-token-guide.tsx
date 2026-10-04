import type { ConnectionReview } from '@veduta/protocol'

export function GithubTokenGuide({ review }: { review: ConnectionReview }) {
  const repository = review.repository
    ? `${review.repository.owner}/${review.repository.name}`
    : 'the repositories authorized by this token'
  const write = review.actions.includes('issue_write')
  const files = review.actions.includes('read_files')
  const url = new URL('https://github.com/settings/personal-access-tokens/new')
  url.searchParams.set('name', 'Veduta')
  url.searchParams.set(
    'description',
    files
      ? 'Read repository metadata, files and issues for Veduta'
      : `${write ? 'Read and create' : 'Read'} issues in ${repository}`,
  )
  url.searchParams.set('expires_in', '30')
  url.searchParams.set('issues', write ? 'write' : 'read')
  if (files) url.searchParams.set('contents', 'read')
  if (review.repository) url.searchParams.set('target_name', review.repository.owner)
  return (
    <section className="connection-setup-guide" aria-label="GitHub token setup guide">
      <h3>Connect with a GitHub token</h3>
      <ol>
        <li>
          <a href={url.toString()} target="_blank" rel="noreferrer">
            Create a token for Veduta
          </a>
          . GitHub opens with a name, 30-day expiry and the requested read permissions filled in.
          You can also use an existing fine-grained token.
        </li>
        <li>
          {files ? (
            <>
              Under Repository access, choose All repositories or select the repositories you want
              this connection to use. Set Contents and Issues to <strong>Read-only</strong>;
              Metadata read access is included by GitHub.
            </>
          ) : (
            <>
              Under Repository access, choose Only select repositories and select{' '}
              <strong>{repository}</strong>. Check that Issues is set to{' '}
              <strong>{write ? 'Read and write' : 'Read-only'}</strong>.
            </>
          )}
        </li>
        <li>
          Generate the token and paste it below. Verification checks your account and the reviewed
          MCP tools; Space access is confirmed afterward.
        </li>
      </ol>
      <p className="connection-note">
        Keep the token in Veduta's protected form. Each Space receives only the access you
        explicitly grant.
      </p>
    </section>
  )
}
