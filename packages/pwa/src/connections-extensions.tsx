import { Badge } from '@veduta/catalog/ui/badge'
import { Button } from '@veduta/catalog/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@veduta/catalog/ui/item'
import { GitFork, Mail } from 'lucide-react'
import { Link } from 'react-router-dom'
import { clientPath } from './client-router.tsx'
import { ConnectionsSection } from './connections-section.tsx'

const extensions = [
  {
    name: 'Mailbox',
    icon: Mail,
    status: 'Included',
    description: 'Gmail through Google OAuth; other providers through Himalaya 2.1.0.',
    detail: 'Connect and verify an account, then choose where to use it.',
    service: 'gmail',
    action: 'Connect email',
  },
  {
    name: 'GitHub MCP Server',
    icon: GitFork,
    status: 'Available to connect',
    description: 'List repositories, read files and review open issues in your Spaces.',
    detail:
      'Reviewed v1.12.2. Installed on the Gateway during authorized setup; access requires an account and a Space grant.',
    service: 'github',
    action: 'Connect GitHub',
  },
]

export function ConnectionsExtensions() {
  return (
    <ConnectionsSection
      title="Extensions"
      description="Reviewed capabilities available in this Veduta version."
      actions={
        <Button asChild variant="outline">
          <Link to={clientPath.serviceConnections}>Manage accounts</Link>
        </Button>
      }
    >
      <ItemGroup className="connections-extensions">
        {extensions.map(({ name, icon: Icon, status, description, detail, service, action }) => (
          <Item key={name} role="listitem" aria-label={name} className="connection-extension">
            <ItemMedia variant="icon">
              <Icon aria-hidden="true" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full flex-wrap">
                <h2>{name}</h2>
                <Badge variant="outline">{status}</Badge>
              </ItemTitle>
              <ItemDescription>{description}</ItemDescription>
              <ItemDescription>{detail}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button asChild variant="outline">
                <Link to={`${clientPath.serviceConnections}?detail=new&service=${service}`}>
                  {action}
                </Link>
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </ConnectionsSection>
  )
}
