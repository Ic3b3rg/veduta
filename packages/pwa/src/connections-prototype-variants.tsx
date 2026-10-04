import { Card } from '@veduta/catalog/ui/card'
import { Badge } from '@veduta/catalog/ui/badge'
import {
  Table,
  TableBody,
  TableHeader,
  TableRow,
  TableHead,
  TableCell,
} from '@veduta/catalog/ui/table'
import { Button } from '@veduta/catalog/ui/button'
import { useState } from 'react'
import { statusLabels, type DemoConnection } from './connections-prototype-data.ts'
import { ProviderMark, PrototypeIcon } from './connections-prototype-icons.tsx'

interface VariantProps {
  items: DemoConnection[]
  onOpen: (item: DemoConnection) => void
  selectedModel: string
}
export function ConnectionStatus({ item }: { item: DemoConnection }) {
  return (
    <Badge variant="outline" className={`cp-status cp-status-${item.status}`}>
      <span />
      {item.category === 'extensions' && item.status === 'available'
        ? 'Available'
        : statusLabels[item.status]}
    </Badge>
  )
}
function action(item: DemoConnection) {
  return item.status === 'connected' || item.status === 'disabled'
    ? 'Manage'
    : item.status === 'needs_reconnect'
      ? 'Reconnect'
      : item.status === 'included'
        ? 'View details'
        : item.category === 'extensions'
          ? 'Preview setup'
          : 'Connect'
}
function AccessLabel({ item }: { item: DemoConnection }) {
  return (
    <span className="cp-access-label">
      <PrototypeIcon name={item.category === 'models' ? 'globe' : 'access'} size={15} />
      {item.category === 'models'
        ? 'Shared across Spaces'
        : item.spaces.length
          ? item.spaces.join(', ')
          : 'No Space access'}
    </span>
  )
}

export function CatalogVariant({ items, onOpen, selectedModel }: VariantProps) {
  return (
    <div className="cp-catalog-grid">
      {items.map((item) => (
        <Card className="cp-service-card" key={item.id}>
          <div className="cp-card-top">
            <ProviderMark id={item.id} />
            <ConnectionStatus item={item} />
          </div>
          <h2>
            {item.name}
            {selectedModel === item.id && (
              <Badge variant="secondary" className="cp-default">
                Agent default
              </Badge>
            )}
          </h2>
          <p>{item.description}</p>
          <div className="cp-card-meta">
            <span>{item.method}</span>
            <span>
              {item.account ||
                (item.category === 'extensions'
                  ? 'Explore this capability'
                  : 'Choose an account during setup')}
            </span>
          </div>
          <div className="cp-card-footer">
            <AccessLabel item={item} />
            <Button
              variant={item.status === 'available' ? 'default' : 'outline'}
              className={item.status === 'available' ? 'cp-primary' : 'cp-button'}
              aria-label={`${action(item)} ${item.name}`}
              onClick={() => onOpen(item)}
            >
              {action(item)}
              <PrototypeIcon name="arrow" size={15} />
            </Button>
          </div>
        </Card>
      ))}
    </div>
  )
}

export function ControlVariant({ items, onOpen, selectedModel }: VariantProps) {
  const category = items[0]?.category
  return (
    <div className="cp-control-layout">
      <div className="cp-table-wrap">
        <Table className="cp-connections-table">
          <TableHeader>
            <TableRow>
              <TableHead>Connection</TableHead>
              <TableHead>Authorization</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>{category === 'models' ? 'Availability' : 'Space access'}</TableHead>
              <TableHead>
                <span className="cp-sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="cp-table-identity">
                    <ProviderMark id={item.id} />
                    <div>
                      <strong>
                        {item.name}
                        {selectedModel === item.id && (
                          <Badge variant="secondary" className="cp-default">
                            Default
                          </Badge>
                        )}
                      </strong>
                      <span>{item.account || item.description}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell>{item.method}</TableCell>
                <TableCell>
                  <ConnectionStatus item={item} />
                </TableCell>
                <TableCell>
                  <AccessLabel item={item} />
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    className="cp-button"
                    aria-label={`${action(item)} ${item.name}`}
                    onClick={() => onOpen(item)}
                  >
                    {action(item)}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="cp-control-note">
        <PrototypeIcon name="access" />
        <div>
          <strong>
            {category === 'services'
              ? 'Access stays with the Space you choose'
              : category === 'models'
                ? 'Model connections are shared across Spaces'
                : 'A capability grants no account permission'}
          </strong>
          <p>
            {category === 'services'
              ? 'Connecting an account keeps it available to Veduta. Each Space needs its own explicit access.'
              : category === 'models'
                ? 'The Model connection provides inference to Veduta’s Agent. Service access remains separately scoped.'
                : 'Review an extension’s requirements. Connect and authorize any service account separately.'}
          </p>
        </div>
      </div>
    </div>
  )
}

export function GuidedVariant({ items, onOpen, selectedModel }: VariantProps) {
  const [selectedId, setSelectedId] = useState('github')
  const selected = items.find((item) => item.id === selectedId) ?? items[0]
  if (!selected) return <p className="cp-empty">No matching connections. Try another search.</p>
  const isService = selected.category === 'services'
  return (
    <div className="cp-guided-layout">
      <div className="cp-guided-list" aria-label="Choose a connection">
        {items.map((item) => (
          <Button
            variant="ghost"
            key={item.id}
            className={
              item.id === selected.id ? 'cp-guided-choice cp-selected' : 'cp-guided-choice'
            }
            aria-pressed={item.id === selected.id}
            onClick={() => setSelectedId(item.id)}
          >
            <ProviderMark id={item.id} />
            <div>
              <strong>{item.name}</strong>
              <span>{statusLabels[item.status]}</span>
            </div>
            <PrototypeIcon name="arrow" size={16} />
          </Button>
        ))}
      </div>
      <Card className="cp-guided-detail">
        <div className="cp-guided-heading">
          <ProviderMark id={selected.id} />
          <ConnectionStatus item={selected} />
        </div>
        <h2>{selected.name}</h2>
        <p className="cp-guided-description">{selected.description}</p>
        {selected.account && (
          <div className="cp-account-line">
            <strong>{selected.account}</strong>
            <AccessLabel item={selected} />
          </div>
        )}
        <h3>
          {selected.status === 'connected' ? 'You’re in control' : 'What happens during setup'}
        </h3>
        <ol className="cp-setup-steps">
          <li>
            <strong>
              {isService
                ? 'Choose your account'
                : selected.category === 'models'
                  ? 'Choose your connection method'
                  : 'Review the capability'}
            </strong>
            <p>
              {isService
                ? `Continue with ${selected.name === 'Gmail' ? 'Google' : selected.name}.`
                : selected.method}
            </p>
          </li>
          <li>
            <strong>{isService ? 'Review the requested access' : 'Check the connection'}</strong>
            <p>
              {isService
                ? 'Start with read access. Writes require a separate approval.'
                : 'See the setup requirements and any missing pieces.'}
            </p>
          </li>
          <li>
            <strong>
              {isService
                ? 'Choose the Spaces'
                : selected.category === 'models'
                  ? 'Choose your Agent model'
                  : 'Choose where it is available'}
            </strong>
            <p>
              {isService
                ? 'You can change or revoke access here at any time.'
                : selected.category === 'models'
                  ? 'Use the same Agent capabilities across every Space.'
                  : 'Installing a Skill or MCP grants no account permission.'}
            </p>
          </li>
        </ol>
        <div className="cp-guided-bottom">
          <span>
            {selectedModel === selected.id ? 'Your current Agent default' : selected.method}
          </span>
          <Button
            className="cp-primary"
            aria-label={`${action(selected)} ${selected.name}`}
            onClick={() => onOpen(selected)}
          >
            {action(selected)} {selected.name}
            <PrototypeIcon name="arrow" size={17} />
          </Button>
        </div>
      </Card>
    </div>
  )
}
