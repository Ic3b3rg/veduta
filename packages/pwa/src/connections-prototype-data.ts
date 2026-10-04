// Throwaway UI evidence for #181. All accounts, health, and grants are demo data.
export type PrototypeSection = 'overview' | 'services' | 'models' | 'extensions' | 'access'
export type PrototypeVariant = 'A' | 'B' | 'C'
export type DemoStatus =
  'connected' | 'available' | 'needs_reconnect' | 'disabled' | 'included' | 'previewed'
export type DemoCategory = 'services' | 'models' | 'extensions'
export interface DemoConnection {
  id: string
  name: string
  description: string
  category: DemoCategory
  method: string
  account: string
  status: DemoStatus
  spaces: string[]
  resource: string
}

export const demoSpaces = ['Health', 'Work', 'Home']
export const demoConnections: DemoConnection[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Find email, summarize newsletters, and prepare replies.',
    category: 'services',
    method: 'Google OAuth',
    account: 'alex@example.test',
    status: 'connected',
    spaces: ['Health'],
    resource: '',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read repository issues and prepare changes for approval.',
    category: 'services',
    method: 'GitHub OAuth preview',
    account: '',
    status: 'available',
    spaces: [],
    resource: 'demo/veduta-sandbox',
  },
  {
    id: 'mail',
    name: 'Other email',
    description: 'Connect a personal mailbox using IMAP and SMTP.',
    category: 'services',
    method: 'IMAP and SMTP',
    account: '',
    status: 'available',
    spaces: [],
    resource: '',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    description: 'Use your ChatGPT subscription for Veduta’s Agent.',
    category: 'models',
    method: 'Subscription',
    account: 'Alex · ChatGPT',
    status: 'connected',
    spaces: [],
    resource: '',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'Connect with your own API key and choose a model.',
    category: 'models',
    method: 'API key',
    account: '',
    status: 'available',
    spaces: [],
    resource: '',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Use Claude models with your own API key.',
    category: 'models',
    method: 'API key',
    account: 'Personal API connection',
    status: 'needs_reconnect',
    spaces: [],
    resource: '',
  },
  {
    id: 'mailbox-skill',
    name: 'Mailbox',
    description: 'Teaches the Agent to search and summarize scoped email.',
    category: 'extensions',
    method: 'First-party Skill',
    account: 'Included with Veduta',
    status: 'included',
    spaces: [],
    resource: '',
  },
  {
    id: 'github-mcp',
    name: 'GitHub MCP',
    description: 'Reviewed support for GitHub tools. Connect your account in Services.',
    category: 'extensions',
    method: 'MCP server · v1.12.2',
    account: 'Included support · account not connected',
    status: 'included',
    spaces: [],
    resource: '',
  },
  {
    id: 'planning-skill',
    name: 'Weekly planning',
    description: 'Preview a procedure for reviewing goals and planning the week.',
    category: 'extensions',
    method: 'Skill preview',
    account: '',
    status: 'available',
    spaces: [],
    resource: '',
  },
]

export const statusLabels: Record<DemoStatus, string> = {
  connected: 'Connected',
  available: 'Not connected',
  needs_reconnect: 'Reconnect needed',
  disabled: 'Disabled',
  included: 'Included',
  previewed: 'Preview only',
}
export const sectionLabels: Record<PrototypeSection, string> = {
  overview: 'Overview',
  services: 'Accounts & services',
  models: 'Models',
  extensions: 'Extensions',
  access: 'Space access',
}
export const sectionDescriptions: Record<PrototypeSection, string> = {
  overview: 'Your connections, capabilities, and anything that needs attention.',
  services: 'Connect the services you use. Choose where Veduta can use each account.',
  models: 'Choose how Veduta’s Agent connects to a model. Shared across your Spaces.',
  extensions: 'Discover Skills and MCP support. Adding a capability grants no account access.',
  access: 'Choose exactly which Space can use each account and capability.',
}
