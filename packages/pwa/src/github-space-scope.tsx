import { NativeSelect } from '@veduta/catalog/ui/native-select'
import { Textarea } from '@veduta/catalog/ui/textarea'
import { GithubRepositoryScopeSchema, type GithubRepositoryScope } from '@veduta/protocol'

export interface GithubScopeChoice {
  mode: 'authorized' | 'selected'
  text: string
}
export function githubScopeChoice(scope?: GithubRepositoryScope): GithubScopeChoice {
  return scope?.mode === 'selected'
    ? {
        mode: 'selected',
        text: scope.repositories.map((repo) => `${repo.owner}/${repo.name}`).join('\n'),
      }
    : { mode: 'authorized', text: '' }
}
export function parseGithubScope(choice: GithubScopeChoice): GithubRepositoryScope | undefined {
  const parsed = GithubRepositoryScopeSchema.safeParse(
    choice.mode === 'authorized'
      ? { mode: 'authorized' }
      : {
          mode: 'selected',
          repositories: choice.text
            .split(/[\n,]/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [owner, name, extra] = line.split('/')
              return { owner, name: extra === undefined ? name : undefined }
            }),
        },
  )
  return parsed.success ? parsed.data : undefined
}
export function GithubSpaceScope({
  name,
  value,
  onChange,
}: {
  name: string
  value: GithubScopeChoice
  onChange: (value: GithubScopeChoice) => void
}) {
  return (
    <div className="connection-fields">
      <label>
        GitHub repositories in {name}
        <NativeSelect
          value={value.mode}
          onChange={(event) =>
            onChange({
              ...value,
              mode: event.target.value === 'selected' ? 'selected' : 'authorized',
            })
          }
        >
          <option value="authorized">All repositories authorized by the connection</option>
          <option value="selected">Only selected repositories</option>
        </NativeSelect>
      </label>
      {value.mode === 'selected' && (
        <label>
          Repository list for {name}
          <Textarea
            value={value.text}
            onChange={(event) => onChange({ ...value, text: event.target.value })}
            placeholder={'owner/repository\nowner/another-repository'}
            maxLength={7100}
          />
          <span>
            One owner/repository per line, up to 50. The token must also authorize each repository.
          </span>
        </label>
      )}
    </div>
  )
}
