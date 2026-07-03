import { SurfaceSchema, type Surface } from '@veduta/protocol'

export const catalogShowcaseSurface: Surface = SurfaceSchema.parse({
  id: 'srf-catalog-showcase',
  spaceId: 'spc-showcase',
  title: 'Atom catalog showcase',
  tree: {
    id: 'showcase-root',
    type: 'Box',
    props: { gap: 'lg', padding: 'lg' },
    children: [
      { id: 'showcase-title', type: 'Title', props: { text: 'Weekly home plan', level: 2 } },
      {
        id: 'showcase-caption',
        type: 'Caption',
        props: { text: 'Generated Surface using the complete v1 Atom catalog' },
      },
      {
        id: 'showcase-text',
        type: 'Text',
        props: { text: 'A compact plan with fast controls, state bindings, and agent actions.' },
      },
      {
        id: 'showcase-markdown',
        type: 'Markdown',
        props: {
          text: 'Prepare the kitchen list before Saturday.\n\nKeep recurring reminders visible.',
        },
      },
      {
        id: 'metrics-row',
        type: 'Row',
        props: { gap: 'md', align: 'stretch' },
        children: [
          {
            id: 'stats-col',
            type: 'Col',
            props: { gap: 'sm' },
            children: [
              {
                id: 'current-stat',
                type: 'Stat',
                binding: 'currentKg',
                props: { label: 'Pantry', unit: 'kg' },
              },
              {
                id: 'weekly-progress',
                type: 'Progress',
                binding: 'weeklyProgress',
                props: { label: 'Weekly progress' },
              },
            ],
          },
          { id: 'status-badge', type: 'Badge', props: { text: 'On track', tone: 'success' } },
          {
            id: 'status-icon',
            type: 'Icon',
            props: { name: 'check', label: 'Ready', tone: 'success' },
          },
        ],
      },
      { id: 'showcase-divider', type: 'Divider' },
      {
        id: 'edit-form',
        type: 'Form',
        props: { label: 'Plan details' },
        children: [
          { id: 'title-label', type: 'Label', props: { text: 'Title input' } },
          {
            id: 'title-input',
            type: 'Input',
            binding: 'title',
            props: { label: 'Title input', placeholder: 'Plan title' },
            actions: [{ name: 'change', path: 'fast', stateKey: 'title' }],
          },
          {
            id: 'notes-textarea',
            type: 'Textarea',
            binding: 'notes',
            props: { label: 'Notes', rows: 3 },
            actions: [{ name: 'change', path: 'fast', stateKey: 'notes' }],
          },
          {
            id: 'regenerate-button',
            type: 'Button',
            props: { label: 'Regenerate', variant: 'secondary' },
            actions: [{ name: 'regenerate', path: 'agent', payload: { reason: 'showcase' } }],
          },
        ],
      },
      {
        id: 'controls-row',
        type: 'Row',
        props: { gap: 'md', align: 'stretch' },
        children: [
          {
            id: 'date-picker',
            type: 'DatePicker',
            binding: 'date',
            props: { label: 'Date' },
            actions: [{ name: 'change', path: 'fast', stateKey: 'date' }],
          },
          {
            id: 'priority-select',
            type: 'Select',
            binding: 'priority',
            props: {
              label: 'Priority',
              options: [
                { label: 'Low', value: 'low' },
                { label: 'Medium', value: 'medium' },
                { label: 'High', value: 'high' },
              ],
            },
            actions: [{ name: 'change', path: 'fast', stateKey: 'priority' }],
          },
        ],
      },
      {
        id: 'cadence-radio',
        type: 'RadioGroup',
        binding: 'cadence',
        props: {
          label: 'Cadence',
          options: [
            { label: 'Daily', value: 'daily' },
            { label: 'Weekly', value: 'weekly' },
            { label: 'Monthly', value: 'monthly' },
          ],
        },
        actions: [{ name: 'change', path: 'fast', stateKey: 'cadence' }],
      },
      {
        id: 'checkbox-milk',
        type: 'Checkbox',
        binding: 'milk',
        props: { label: 'Milk' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'milk' }],
      },
      {
        id: 'showcase-table',
        type: 'Table',
        binding: 'tableRows',
        props: { columns: ['item', 'owner', 'status'] },
      },
      {
        id: 'showcase-chart',
        type: 'Chart',
        binding: 'chartData',
        props: { label: 'Completions by day' },
      },
      {
        id: 'showcase-image',
        type: 'Image',
        props: {
          alt: 'Kitchen prep',
        },
      },
      { id: 'showcase-spacer', type: 'Spacer', props: { size: 'sm' } },
      {
        id: 'showcase-transition',
        type: 'Transition',
        props: { visible: true },
        children: [
          { id: 'transition-text', type: 'Text', props: { text: 'Updated after the fast path.' } },
        ],
      },
      {
        id: 'shopping-list-item',
        type: 'ListItem',
        props: {
          label: 'Check pantry stock',
          detail: 'Before adding new groceries',
          status: 'pending',
        },
        actions: [{ name: 'open', path: 'agent', payload: { target: 'pantry' } }],
      },
      {
        id: 'water-automation',
        type: 'Automation',
        binding: 'waterReminder',
        props: { label: 'Water reminder', schedule: 'Every day at 08:00' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'waterReminder' }],
      },
    ],
  },
  state: {
    currentKg: 12,
    weeklyProgress: 0.72,
    title: 'Grocery plan',
    notes: 'Buy milk',
    date: '2026-07-03',
    priority: 'medium',
    cadence: 'daily',
    milk: true,
    tableRows: [
      { item: 'Milk', owner: 'Home', status: 'needed' },
      { item: 'Fruit', owner: 'Market', status: 'planned' },
    ],
    chartData: [
      { label: 'Mon', value: 2 },
      { label: 'Tue', value: 5 },
      { label: 'Wed', value: 3 },
      { label: 'Thu', value: 6 },
    ],
    waterReminder: true,
  },
  freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'seed' },
})
