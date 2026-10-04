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
import { statusLabels, type DemoConnection } from './connections-prototype-data.ts'
import { ProviderMark, PrototypeIcon } from './connections-prototype-icons.tsx'

interface VariantProps {
  items: DemoConnection[]
  onOpen: (item: DemoConnection) => void
  selectedModel: string
  selectedConnection: string | undefined
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

export function CatalogVariant({ items, onOpen, selectedModel, selectedConnection }: VariantProps) {
  return (
    <div className="cp-catalog-grid">
      {items.map((item) => (
        <Card
          className={`cp-service-card ${selectedConnection === item.id ? 'cp-selected-card' : ''}`}
          key={item.id}
        >
          <div className="cp-card-summary">
            <ProviderMark id={item.id} />
            <div className="cp-card-identity">
              <h2>
                {item.name}
                {selectedModel === item.id && (
                  <Badge variant="secondary" className="cp-default">
                    Default
                  </Badge>
                )}
              </h2>
              <span>
                {item.account ||
                  (item.category === 'extensions' ? 'Explore this capability' : 'Add an account')}
              </span>
            </div>
            <ConnectionStatus item={item} />
          </div>
          <div className="cp-card-footer">
            <AccessLabel item={item} />
            <Button
              variant="ghost"
              size="sm"
              className="cp-card-action"
              aria-label={`${action(item)} ${item.name}`}
              aria-expanded={selectedConnection === item.id}
              aria-controls="cp-connection-detail"
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

export function GuidedVariant({ items, onOpen, selectedModel, selectedConnection }: VariantProps) {
  return (
    <div className="cp-guided-list" aria-label="Choose a connection">
      {items.map((item) => (
        <Button
          variant="ghost"
          key={item.id}
          className={
            item.id === selectedConnection ? 'cp-guided-choice cp-selected' : 'cp-guided-choice'
          }
          aria-label={`${action(item)} ${item.name}`}
          aria-expanded={item.id === selectedConnection}
          aria-controls="cp-connection-detail"
          onClick={() => onOpen(item)}
        >
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
            <span>{item.account || item.method}</span>
          </div>
          <ConnectionStatus item={item} />
          <PrototypeIcon name="arrow" size={16} />
        </Button>
      ))}
    </div>
  )
}
