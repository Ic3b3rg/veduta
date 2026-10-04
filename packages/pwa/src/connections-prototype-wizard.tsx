import { Input } from '@veduta/catalog/ui/input'
import { Checkbox } from '@veduta/catalog/ui/checkbox'
import { Button } from '@veduta/catalog/ui/button'
import { useEffect, useRef, useState } from 'react'
import { demoSpaces, type DemoConnection } from './connections-prototype-data.ts'
import { ProviderMark, PrototypeIcon } from './connections-prototype-icons.tsx'
import { ConnectionStatus } from './connections-prototype-variants.tsx'

interface WizardProps {
  item: DemoConnection | null
  catalog: DemoConnection[]
  mode: 'connect' | 'manage'
  onChoose: (item: DemoConnection) => void
  onClose: () => void
  onSave: (item: DemoConnection) => void
  onReconnect: () => void
  onSelectModel: () => void
}

export function PrototypeConnectionWizard({
  item,
  catalog,
  mode,
  onChoose,
  onClose,
  onSave,
  onReconnect,
  onSelectModel,
}: WizardProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 880px)').matches)
  const [step, setStep] = useState<'review' | 'authorize' | 'grant'>('review')
  const [spaces, setSpaces] = useState(item?.spaces ?? [])
  const [resource, setResource] = useState(item?.resource ?? '')
  const [denied, setDenied] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 880px)')
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!mobile) return
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    dialogRef.current?.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true })
    }
  }, [mobile])
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [step])
  const toggleSpace = (space: string) =>
    setSpaces((current) =>
      current.includes(space) ? current.filter((value) => value !== space) : [...current, space],
    )
  const demoAccount =
    item?.id === 'gmail'
      ? 'alex@example.test'
      : item?.id === 'github'
        ? 'alex-demo'
        : item?.id === 'mail'
          ? 'mailbox@example.test'
          : 'Personal demo connection'
  const grantEditor = (
    <>
      <fieldset className="cp-space-options">
        <legend>Spaces that can use this connection</legend>
        {demoSpaces.map((space) => (
          <label key={space}>
            <span className={`cp-space-icon cp-space-${space.toLowerCase()}`}>
              {space.slice(0, 1)}
            </span>
            <span>
              <strong>{space}</strong>
              <small>{spaces.includes(space) ? 'Read access enabled' : 'No access'}</small>
            </span>
            <Checkbox
              aria-label={`${space} access`}
              checked={spaces.includes(space)}
              onCheckedChange={() => toggleSpace(space)}
            />
          </label>
        ))}
      </fieldset>
      {item?.id === 'github' && (
        <label className="cp-field">
          Repository scope
          <Input
            value={resource}
            onChange={(event) => setResource(event.target.value)}
            placeholder="owner/repository"
          />
          <small>Access applies only to this repository. Writing needs separate approval.</small>
        </label>
      )}
    </>
  )
  const footer = !item ? (
    <Button variant="outline" onClick={onClose}>
      Cancel
    </Button>
  ) : mode === 'manage' ? (
    <>
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
      <Button onClick={() => onSave({ ...item, spaces, resource })}>Save changes</Button>
    </>
  ) : step === 'review' ? (
    <>
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
      <Button
        onClick={() => {
          setDenied(false)
          setStep('authorize')
        }}
      >
        {item.id === 'gmail'
          ? 'Continue with Google'
          : item.id === 'github'
            ? 'Continue with GitHub'
            : 'Continue setup'}
        <PrototypeIcon name="arrow" size={17} />
      </Button>
    </>
  ) : step === 'authorize' ? (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setDenied(true)
          setStep('review')
        }}
      >
        Simulate denial
      </Button>
      <Button onClick={() => setStep('grant')}>
        Use demo authorization
        <PrototypeIcon name="check" size={17} />
      </Button>
    </>
  ) : (
    <>
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
      <Button
        onClick={() =>
          onSave({
            ...item,
            account: demoAccount,
            spaces,
            resource,
            status: item.category === 'extensions' ? 'previewed' : 'connected',
          })
        }
      >
        {spaces.length
          ? 'Connect & allow access'
          : item.category === 'extensions'
            ? 'Save demo setup'
            : 'Save demo connection'}
      </Button>
    </>
  )
  const content = (
    <>
      <header className="cp-dialog-header">
        <span>{mode === 'manage' ? 'Connection details' : 'Connection setup'}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="cp-icon-button"
          aria-label="Close details"
          onClick={onClose}
        >
          <PrototypeIcon name="close" />
        </Button>
      </header>
      <div ref={contentRef} className="cp-dialog-content">
        <div className="cp-demo-note">
          <PrototypeIcon name="models" size={17} />
          <span>Demo only. Authorization and verification are simulated.</span>
        </div>
        {!item ? (
          <>
            <h2 id="cp-dialog-title">What would you like to add?</h2>
            <p>Choose an account, a model, or a capability.</p>
            <div className="cp-picker">
              {catalog.map((connection) => (
                <Button variant="outline" key={connection.id} onClick={() => onChoose(connection)}>
                  <ProviderMark id={connection.id} />
                  <div>
                    <strong>{connection.name}</strong>
                    <span>{connection.method}</span>
                  </div>
                  <PrototypeIcon name="arrow" size={18} />
                </Button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="cp-dialog-title">
              <ProviderMark id={item.id} />
              <div>
                <h2 id="cp-dialog-title">
                  {mode === 'manage' ? item.name : `Connect ${item.name}`}
                </h2>
                <span>{item.method}</span>
              </div>
            </div>
            {mode === 'manage' ? (
              <>
                <ConnectionStatus item={item} />
                <p className="cp-detail-description">{item.description}</p>
                <div className="cp-account-preview">
                  <span>{item.category === 'extensions' ? 'Capability' : 'Account'}</span>
                  <strong>{item.account || 'No account connected'}</strong>
                  <small>Demo data</small>
                </div>
                {item.category === 'services' ? (
                  grantEditor
                ) : (
                  <p className="cp-info">
                    {item.category === 'models'
                      ? 'This Model connection supplies inference to the same Veduta Agent across all Spaces.'
                      : item.id === 'github-mcp'
                        ? 'GitHub MCP support is included. Your GitHub account and Space access are configured under Accounts & services.'
                        : 'This Skill provides instructions for the Agent. It grants no credentials or additional account permissions.'}
                  </p>
                )}
                <div className="cp-management-actions">
                  {item.category === 'models' && (
                    <Button
                      variant="outline"
                      className="cp-button"
                      disabled={item.status !== 'connected'}
                      onClick={onSelectModel}
                    >
                      Use for Agent
                    </Button>
                  )}
                  {item.category !== 'extensions' && (
                    <>
                      <Button variant="outline" className="cp-button" onClick={onReconnect}>
                        Reconnect
                      </Button>
                      <Button
                        variant="outline"
                        className="cp-button"
                        onClick={() =>
                          onSave({
                            ...item,
                            status: item.status === 'disabled' ? 'connected' : 'disabled',
                          })
                        }
                      >
                        {item.status === 'disabled' ? 'Enable' : 'Disable'}
                      </Button>
                      <Button
                        variant="link"
                        className="cp-danger-link"
                        onClick={() =>
                          onSave({ ...item, account: '', status: 'available', spaces: [] })
                        }
                      >
                        Remove connection
                      </Button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <ol className="cp-wizard-progress">
                  {[
                    'Review',
                    'Authorization',
                    item.category === 'models' ? 'Finish' : 'Space access',
                  ].map((label, index) => (
                    <li
                      key={label}
                      className={
                        index === ['review', 'authorize', 'grant'].indexOf(step) ? 'cp-current' : ''
                      }
                    >
                      <span>{index + 1}</span>
                      {label}
                    </li>
                  ))}
                </ol>
                {step === 'review' && (
                  <>
                    <h3>
                      {item.category === 'extensions'
                        ? 'Review this capability'
                        : 'Know what you’re connecting'}
                    </h3>
                    <p>{item.description}</p>
                    <dl className="cp-review-details">
                      <div>
                        <dt>Authorization</dt>
                        <dd>{item.method}</dd>
                      </div>
                      <div>
                        <dt>Access</dt>
                        <dd>
                          {item.category === 'services'
                            ? 'Read access. External writes require separate approval.'
                            : item.category === 'models'
                              ? 'Model inference only. Veduta owns the Agent and tools.'
                              : 'No account permissions granted by installation.'}
                        </dd>
                      </div>
                      <div>
                        <dt>Execution</dt>
                        <dd>Your Veduta Gateway</dd>
                      </div>
                    </dl>
                    {denied && (
                      <p className="cp-error" role="alert">
                        Demo authorization denied. No connection or Space access was saved.
                      </p>
                    )}
                  </>
                )}
                {step === 'authorize' && (
                  <>
                    <h3>
                      {item.category === 'extensions' ? 'Setup preview' : 'Authorization preview'}
                    </h3>
                    <p>
                      {item.method.includes('OAuth') || item.id === 'chatgpt'
                        ? 'In the final flow, you authorize on the provider’s page and return here.'
                        : item.category === 'extensions'
                          ? 'Installation will show the exact package, compatibility, and required review.'
                          : 'In the final flow, a protected form guides you through the required credentials.'}
                    </p>
                    <div className="cp-provider-preview">
                      <ProviderMark id={item.id} />
                      <strong>{item.name}</strong>
                      <span>{demoAccount}</span>
                      <small>Example account for this prototype</small>
                    </div>
                  </>
                )}
                {step === 'grant' && (
                  <>
                    <h3>
                      {item.category === 'models'
                        ? 'Your Model connection'
                        : 'Choose where it can be used'}
                    </h3>
                    <div className="cp-account-preview">
                      <span>Example account</span>
                      <strong>{demoAccount}</strong>
                      <small>Identity verification is simulated</small>
                    </div>
                    {item.category === 'models' ? (
                      <p className="cp-info">
                        This connection will be available to your Agent across every Space. Choose
                        the default on the Models page.
                      </p>
                    ) : (
                      grantEditor
                    )}
                    <p className="cp-info">
                      {item.category === 'services'
                        ? 'Connecting performs no task. You can save the account with no Space access and grant it later.'
                        : item.category === 'extensions'
                          ? 'This previews the setup only. It is not a verified extension installation.'
                          : 'All changes here exist only in this prototype.'}
                    </p>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      <footer className="cp-dialog-footer">{footer}</footer>
    </>
  )
  return mobile ? (
    <dialog
      ref={dialogRef}
      className="cp-dialog cp-mobile-drawer"
      id="cp-connection-detail"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      aria-labelledby="cp-dialog-title"
    >
      {content}
    </dialog>
  ) : (
    <aside
      className="cp-dialog cp-detail-panel"
      id="cp-connection-detail"
      aria-labelledby="cp-dialog-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      {content}
    </aside>
  )
}
