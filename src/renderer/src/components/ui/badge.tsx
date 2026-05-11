import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap tracking-[0.04em] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/45 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-primary/45 bg-primary/16 text-primary",
        secondary:
          "border-border/70 bg-secondary/65 text-secondary-foreground",
        outline: "border-border/80 bg-muted/30 text-foreground",
        destructive:
          "border-destructive/45 bg-destructive/14 text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
