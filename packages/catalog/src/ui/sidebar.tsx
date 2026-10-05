import type { ComponentProps } from 'react'
import { cn } from 'cn'
import { Slot } from 'radix-ui'

// Static composition of the shadcn Sidebar pattern: the caller owns responsive placement.
// https://ui.shadcn.com/docs/components/radix/sidebar
function Sidebar({ className, ...props }: ComponentProps<'aside'>) {
  return (
    <aside
      data-slot="sidebar"
      className={cn('flex shrink-0 flex-col bg-card text-card-foreground', className)}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn('min-h-0 flex-1 overflow-auto p-2', className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn('m-0 flex list-none flex-col gap-1 p-0', className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: ComponentProps<'li'>) {
  return (
    <li data-slot="sidebar-menu-item" className={cn('relative min-w-0', className)} {...props} />
  )
}

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  className,
  ...props
}: ComponentProps<'button'> & { asChild?: boolean; isActive?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive}
      className={cn(
        'flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-normal no-underline outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-accent data-[active=true]:font-medium data-[active=true]:text-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0',
        className,
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
}
