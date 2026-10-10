import { Button } from '@veduta/catalog/ui/button'
import { Input } from '@veduta/catalog/ui/input'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@veduta/catalog/ui/sheet'

export function ReferenceRecipes() {
  return (
    <div className="reference-recipes">
      <div className="recipe-surface recipe-motion">
        <h3>Durable content</h3>
        <p>Opaque content, compact controls and a visible keyboard focus ring.</p>
        <label htmlFor="reference-input">Space name</label>
        <Input id="reference-input" className="recipe-input" defaultValue="Home and family" />
        <div className="reference-actions">
          <Button className="recipe-control recipe-focus" data-variant="primary">
            Save changes
          </Button>
          <Button className="recipe-control" disabled>
            Unavailable
          </Button>
        </div>
      </div>
      <nav className="recipe-menu" aria-label="Reference navigation menu">
        <a className="recipe-control recipe-focus" href="#reference-home">
          Home reference
        </a>
        <a className="recipe-control recipe-focus" href="#reference-atoms">
          Atom reference
        </a>
      </nav>
      <div className="reference-statuses">
        <span className="recipe-status" data-tone="success">
          Saved
        </span>
        <span className="recipe-status" data-tone="warning">
          Stale
        </span>
        <span className="recipe-status" data-tone="attention">
          Needs attention
        </span>
        <span className="recipe-status" data-tone="danger">
          Action failed
        </span>
        <span className="recipe-status" data-tone="pending">
          Approval pending
        </span>
        <span className="recipe-status" data-tone="offline">
          Offline · retry when connected
        </span>
      </div>
      <Sheet>
        <SheetTrigger asChild>
          <Button className="recipe-control recipe-focus">Open reference overlay</Button>
        </SheetTrigger>
        <SheetContent className="reference-overlay" side="right" showCloseButton={false}>
          <div className="recipe-overlay">
            <SheetTitle>Reference overlay</SheetTitle>
            <SheetDescription>
              Temporary controls share the opaque fallback and focus behavior.
            </SheetDescription>
            <label htmlFor="reference-overlay-input">Display name</label>
            <Input id="reference-overlay-input" className="recipe-input" defaultValue="Home" />
            <SheetClose asChild>
              <Button className="recipe-control recipe-focus">Close reference overlay</Button>
            </SheetClose>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
