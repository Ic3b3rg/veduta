import type { ModelConnectionsSnapshot } from '@veduta/protocol'

export const referenceAt = '2026-10-09T10:00:00.000Z'
export const referenceNow = Date.parse(referenceAt)

export const referenceModels: ModelConnectionsSnapshot = {
  vaultAvailable: true,
  mockEnabled: false,
  mockControlAvailable: false,
  methods: [
    {
      id: 'anthropic-api-key',
      provider: 'anthropic',
      providerDisplayName: 'Claude',
      methodDisplayName: 'API key',
      capabilities: {
        authorization: 'api-key',
        refresh: 'static',
        revocation: 'local-only',
        metered: true,
      },
      primaryRoutable: true,
      available: true,
    },
  ],
  connections: [
    {
      id: 'a1a1a1a1-0000-4000-8000-000000000001',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Personal Model connection',
      state: 'connected',
      stateAt: referenceAt,
      createdAt: referenceAt,
      enabledForFallback: false,
      selectedModelId: 'reference-model',
      catalog: [{ id: 'reference-model', label: 'Verified example model', routable: true }],
    },
  ],
  selection: { connectionId: 'a1a1a1a1-0000-4000-8000-000000000001', modelId: 'reference-model' },
}
