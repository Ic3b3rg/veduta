import type { ConnectionReview as Review } from '@veduta/protocol'

export function ConnectionReview({ review }: { review: Review }) {
  return (
    <>
      <dl className="connection-review">
        <div>
          <dt>Account</dt>
          <dd>{review.accountHint ?? 'Verified after authorization'}</dd>
        </div>
        <div>
          <dt>Provider access</dt>
          <dd>{review.service === 'gmail' ? 'Read-only Gmail' : review.scopes.join(', ')}</dd>
        </div>
        <div>
          <dt>Allowed actions</dt>
          <dd>{review.actions.join(', ')}</dd>
        </div>
        {review.repository && (
          <div>
            <dt>Repository</dt>
            <dd>
              {review.repository.owner}/{review.repository.name}
            </dd>
          </div>
        )}
        <div>
          <dt>Runs on</dt>
          <dd>{review.executionHost}</dd>
        </div>
      </dl>
      <details>
        <summary>Technical details</summary>
        <dl className="connection-review">
          <div>
            <dt>Provider scopes</dt>
            <dd>{review.scopes.join(', ')}</dd>
          </div>
          {review.serverVersion && (
            <div>
              <dt>Reviewed server version</dt>
              <dd>{review.serverVersion}</dd>
            </div>
          )}
          {review.serverSource && (
            <div>
              <dt>Source</dt>
              <dd>
                <a href={review.serverSource} target="_blank" rel="noreferrer">
                  Official GitHub MCP release
                </a>
              </dd>
            </div>
          )}
          {review.archiveSha256 && (
            <div>
              <dt>Archive SHA-256</dt>
              <dd>
                <code>{review.archiveSha256}</code>
              </dd>
            </div>
          )}
          {review.executableSha256 && (
            <div>
              <dt>Executable SHA-256</dt>
              <dd>
                <code>{review.executableSha256}</code>
              </dd>
            </div>
          )}
          {review.toolSchemaSha256 && (
            <div>
              <dt>Tool schema SHA-256</dt>
              <dd>
                <code>{review.toolSchemaSha256}</code>
              </dd>
            </div>
          )}
        </dl>
      </details>
    </>
  )
}
