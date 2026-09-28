import { ChevronDownIcon } from 'lucide-react'
import { createContext, useContext, type ReactNode } from 'react'
import { motionContent, propBoolean, text } from './atom-helpers.ts'
import type { AtomProps } from './types.ts'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion.tsx'
import { Button } from './ui/button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.tsx'

const AccordionScope = createContext(false)

export function AccordionAtom({ node, children }: AtomProps): ReactNode {
  const openIds = (node.children ?? [])
    .filter((child) => child.props?.['defaultOpen'] === true)
    .map((child) => child.id)

  return node.props?.['mode'] === 'multiple' ? (
    <Accordion
      type="multiple"
      defaultValue={openIds}
      className="rounded-lg border border-border px-4"
    >
      <AccordionScope.Provider value={true}>{children}</AccordionScope.Provider>
    </Accordion>
  ) : (
    <Accordion
      type="single"
      collapsible
      {...(openIds[0] === undefined ? {} : { defaultValue: openIds[0] })}
      className="rounded-lg border border-border px-4"
    >
      <AccordionScope.Provider value={true}>{children}</AccordionScope.Provider>
    </Accordion>
  )
}

export function CollapsibleAtom({ node, children }: AtomProps): ReactNode {
  const label = text(node.props?.['label'])
  if (useContext(AccordionScope)) {
    return (
      <AccordionItem value={node.id} className="border-border">
        <AccordionTrigger
          {...motionContent('label')}
          className="border-0 bg-transparent text-foreground hover:bg-accent/50 hover:no-underline"
        >
          {label}
        </AccordionTrigger>
        <AccordionContent>
          <AccordionScope.Provider value={false}>{children}</AccordionScope.Provider>
        </AccordionContent>
      </AccordionItem>
    )
  }
  return (
    <Collapsible
      defaultOpen={propBoolean(node.props, 'defaultOpen', false)}
      className="group rounded-lg border border-border bg-card"
    >
      <CollapsibleTrigger asChild>
        <Button
          {...motionContent('label')}
          type="button"
          variant="ghost"
          className="h-auto min-h-9 w-full justify-between border-0 bg-transparent px-4 py-2 text-left whitespace-normal hover:no-underline"
        >
          {label}
          <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border px-4 py-3">
        <AccordionScope.Provider value={false}>{children}</AccordionScope.Provider>
      </CollapsibleContent>
    </Collapsible>
  )
}
